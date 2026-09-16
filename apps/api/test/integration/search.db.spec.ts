// =============================================================================
// Real-Postgres test: `GET /api/search` end to end (issue #175, epic #164)
// =============================================================================
//
// Almost nothing this endpoint promises can be proved without a real database.
// The generated `tsvector` columns, the GIN indexes, `plainto_tsquery`'s
// stopword list, `ts_rank_cd`'s cover-density arithmetic and `ts_headline`'s
// fragment selection all live in Postgres; a mocked Prisma can only assert
// that the right SQL text was emitted (which `src/search/search.service
// .spec.ts` does) and never that the text MEANS what the comments above it
// claim. So this suite drives `SearchService` against a migrated database with
// real rows in it.
//
// THIS IS A `*.db.spec.ts` FILE, deliberately excluded from `npm test`/
// `test:unit`/`test:cov`/`test:ci` (see apps/api/package.json's
// testPathIgnorePatterns). It runs via `npm run test:db`, and reuses
// `../jobs/db-test-support.ts` for the reachability probe and the client
// factory rather than re-implementing either — see that file's header.
//
// The corpus is built once and shared, with a DISTINCT NONSENSE TERM per
// scenario (`zarquon`, `vorpal`, `grimwald`, ...). That is not whimsy: it is
// what lets one fixture set answer nine independent questions without any test
// seeing another test's rows, and it makes an accidental cross-match
// impossible rather than merely unlikely. Where a scenario needs to control
// what ELSE is visible — the 201-document truncation case — it gets its own
// user instead, because visibility is the strongest isolation this endpoint
// has.
//
// -----------------------------------------------------------------------------
// THE SEMANTIC ARM (#189) IS EXERCISED WITH HAND-SEEDED VECTORS
// -----------------------------------------------------------------------------
//
// No embedding provider is called anywhere in this file. `search_chunks` and
// `search_embeddings` rows are inserted by raw SQL (the only way to write a
// `vector` column — see `SearchEmbedding`'s model comment), and the query
// vector comes from a stub `SearchQueryEmbedder` each test sets for itself.
//
// That is not a shortcut around the vendor; it is the only way to make these
// assertions MEAN anything. A real embedding model's output is a black box, so
// "the paraphrase ranked first" would be a statement about OpenAI rather than
// about this code. The fixtures below use sparse unit vectors on distinct axes,
// which makes every cosine similarity in this suite a number written down in
// the fixture — 1.0, 0.6 or 0.0 — so a test that fails does so because the
// FUSION changed, not because a model drifted.
//
// The two scenarios the epic lives or dies on are built to be falsifiable:
//
//   - THE PARAPHRASE. `invoice amounts billed each month` shares NO stemmed
//     term with the transcript it must find, so the full-text arm returns
//     nothing at all for it — asserted directly, so the semantic arm cannot
//     pass by accident.
//   - THE EXACT TOKEN. `PROJ4471` is in one transcript and a DIFFERENT
//     transcript is nearer in vector space (similarity 1.0 against 0.6), so a
//     pure-vector ranking would get it WRONG. Fusion has to put the literal
//     match first, and the test asserts the losing order is genuinely available
//     rather than merely claimed.
// =============================================================================

import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';

import { EMBEDDING_DIMENSIONS } from '../../src/ai/providers/ai-provider.interface';
import type { RequestUser } from '../../src/auth/interfaces/authenticated-user.interface';
import { PERMISSIONS } from '../../src/common/constants/roles.constants';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { MAX_CANDIDATE_DOCUMENTS } from '../../src/search/dto/search.dto';
import { RRF_K } from '../../src/search/search-fusion';
import type { SearchQueryEmbedder } from '../../src/search/search-query-embedder.service';
import type {
  SemanticQueryPlan,
  SemanticReason,
} from '../../src/search/search-semantic';
import { MIN_SEMANTIC_SIMILARITY, SearchService } from '../../src/search/search.service';
import { createDbClient, resolveDbSuite } from '../jobs/db-test-support';

const { describeWithDb } = resolveDbSuite('search.db.spec');

/** Every row this suite creates is named with one of these, and cleaned by it. */
const TITLE_PREFIX = 'search-ep-';
const EMAIL_PREFIX = 'search-endpoint-test';
const KEY_PREFIX = 'test-search-endpoint/';

/** Long enough that `sum` would beat `max` by an order of magnitude. */
const PASSING_MENTIONS = 30;

/** The model these hand-seeded vectors claim to have come from. */
const EMBEDDING_MODEL = 'test-embedding-model';

/**
 * A sparse unit vector: zero everywhere except the given axes.
 *
 * Handed to Postgres as an ordinary bound TEXT parameter and cast at the call
 * site, the same way `search-embeddings.db.spec.ts` does it and the same way
 * `search.service.ts` does it — there is no TypeScript representation of a
 * pgvector value, so every write and every comparison assembles the literal.
 */
function vectorLiteral(axes: Record<number, number>): string {
  const values = new Array(EMBEDDING_DIMENSIONS).fill(0);

  for (const [index, value] of Object.entries(axes)) values[Number(index)] = value;

  return `[${values.join(',')}]`;
}

/** The plain-array form, for the stub embedder's `vector`. */
function vectorOf(axes: Record<number, number>): number[] {
  const values: number[] = new Array(EMBEDDING_DIMENSIONS).fill(0);

  for (const [index, value] of Object.entries(axes)) values[Number(index)] = value;

  return values;
}

// Four orthogonal topics. Cosine similarity between any two of them is 0, and
// between a vector and itself is 1 — so every distance in this suite is a
// number stated here rather than a property of a model.
const AXIS_BILLING = { 0: 1 };
const AXIS_GREENHOUSE = { 1: 1 };
const AXIS_SHARED = { 3: 1 };

// 0.6 along the greenhouse axis, 0.8 along a fourth — a unit vector whose
// cosine similarity with AXIS_GREENHOUSE is exactly 0.6. Comfortably over
// MIN_SEMANTIC_SIMILARITY, and comfortably under the decoy's 1.0.
const AXIS_BUDGET_NEAR_GREENHOUSE = { 1: 0.6, 2: 0.8 };

describeWithDb('GET /api/search (real Postgres)', () => {
  let prisma: PrismaClient;
  let service: SearchService;

  let alice: { id: string };
  let bob: { id: string };
  let bulk: { id: string };
  /** Owns content but nothing embedded — the `no_indexed_content` case. */
  let fresh: { id: string };
  /** Owns a small, mostly-indexed library — the `unindexedCount` case. */
  let tidy: { id: string };

  const ids: Record<string, string> = {};

  // ---------------------------------------------------------------------------
  // The stub query embedder
  // ---------------------------------------------------------------------------
  //
  // ⚠ THE REAL ONE NEVER THROWS — every vendor failure is a reason string (see
  // `search-query-embedder.service.ts`), and `search-query-embedder.service
  // .spec.ts` is where that inversion is pinned against a provider that really
  // does throw. Here the plan is simply chosen per test, which is what lets one
  // corpus answer "with a key", "without a key" and "the vendor is down" from
  // identical rows.

  /** Reset to `ai_key_missing` before every test: the pre-#165 endpoint. */
  let plan: SemanticQueryPlan | SemanticReason = 'ai_key_missing';

  /** Point the query vector at one topic for the next search. */
  const embedAt = (axes: Record<number, number>) => {
    plan = { ok: true, provider: 'test', model: EMBEDDING_MODEL, vector: vectorOf(axes) };
  };

  const embedder = {
    resolve: async () => {
      if (typeof plan === 'string') return { ok: false as const, reason: plan };
      if (!plan.ok) {
        const failing = plan;

        // `embedding_failed` is reached by CALLING the provider, so the stub
        // must resolve and then fail — not decline up front, which is a
        // different reason with a different meaning.
        return { ok: true as const, embed: async () => failing };
      }

      const succeeding = plan;

      return { ok: true as const, embed: async () => succeeding };
    },
  } as unknown as SearchQueryEmbedder;

  beforeEach(() => {
    plan = 'ai_key_missing';
  });

  // ---------------------------------------------------------------------------
  // Fixtures
  // ---------------------------------------------------------------------------

  async function createUser(suffix: string) {
    return prisma.user.create({
      data: {
        email: `${EMAIL_PREFIX}-${suffix}-${Date.now()}-${Math.random()
          .toString(36)
          .slice(2)}@example.test`,
      },
    });
  }

  async function createTranscript(
    ownerId: string,
    title: string,
    options: { deletedAt?: Date } = {},
  ) {
    const object = await prisma.storageObject.create({
      data: {
        name: 'recording.m4a',
        size: BigInt(1024),
        mimeType: 'audio/mp4',
        storageKey: `${KEY_PREFIX}${randomUUID()}`,
        managedBy: 'transcripts',
        uploadedById: ownerId,
      },
    });

    const transcript = await prisma.transcript.create({
      data: {
        ownerId,
        title,
        sourceObjectId: object.id,
        provider: 'assemblyai',
        status: 'ready',
        deletedAt: options.deletedAt ?? null,
      },
    });

    const speaker = await prisma.transcriptSpeaker.create({
      data: { transcriptId: transcript.id, label: 'A', displayName: 'Speaker A', colorIndex: 0 },
    });

    return { transcript, speakerId: speaker.id };
  }

  async function addSegments(transcriptId: string, speakerId: string, texts: string[]) {
    for (const [index, text] of texts.entries()) {
      await prisma.transcriptSegment.create({
        data: {
          transcriptId,
          speakerId,
          startMs: index * 5_000,
          endMs: index * 5_000 + 4_000,
          ordinal: (index + 1) * 1000,
          text,
          words: [],
        },
      });
    }
  }

  async function createNote(
    ownerId: string,
    title: string,
    body: string,
    options: { deletedAt?: Date } = {},
  ) {
    return prisma.note.create({
      data: {
        ownerId,
        title,
        body,
        sourceType: 'document',
        status: 'ready',
        deletedAt: options.deletedAt ?? null,
      },
    });
  }

  /**
   * One chunk plus its embedding for a document, by raw SQL.
   *
   * `content_hash` carries the suite's own prefix so `afterAll` can find every
   * row this file created — `search_chunks.document_id` has no foreign key in
   * either direction (the migration header's point 2), so nothing cleans these
   * up on its own.
   */
  async function embedDocument(
    documentType: 'transcript' | 'note',
    documentId: string,
    text: string,
    axes: Record<number, number>,
  ) {
    const chunkId = randomUUID();

    await prisma.$executeRaw`
      INSERT INTO search_chunks
        (id, document_type, document_id, ordinal, text, content_hash, char_start, char_end, created_at)
      VALUES
        (${chunkId}::uuid, ${documentType}, ${documentId}::uuid, 0, ${text},
         ${`${TITLE_PREFIX}${randomUUID()}`}, 0, ${text.length}, CURRENT_TIMESTAMP)
    `;

    await prisma.$executeRaw`
      INSERT INTO search_embeddings (id, chunk_id, model, dimensions, embedding, created_at)
      VALUES (${randomUUID()}::uuid, ${chunkId}::uuid, ${EMBEDDING_MODEL},
              ${EMBEDDING_DIMENSIONS}, ${vectorLiteral(axes)}::vector, CURRENT_TIMESTAMP)
    `;
  }

  /** The per-document legibility row `unindexedCount` reads. */
  async function markIndexState(
    documentType: 'transcript' | 'note',
    documentId: string,
    ownerId: string,
    status: 'indexed' | 'failed' | 'pending',
  ) {
    await prisma.searchIndexState.create({
      data: {
        documentType,
        documentId,
        ownerId,
        status,
        chunkCount: status === 'indexed' ? 1 : 0,
        model: status === 'indexed' ? EMBEDDING_MODEL : null,
        indexedAt: status === 'indexed' ? new Date() : null,
      },
    });
  }

  function requestUser(
    id: string,
    permissions: string[] = [PERMISSIONS.TRANSCRIPTS_READ, PERMISSIONS.NOTES_READ],
  ): RequestUser {
    return { id, email: 'x@example.test', roles: ['Viewer'], permissions, isActive: true };
  }

  const search = (
    q: string,
    who: RequestUser,
    extra: { limit?: number; types?: string; cursor?: string } = {},
  ) => service.search({ q, limit: extra.limit ?? 20, ...extra }, who);

  beforeAll(async () => {
    prisma = createDbClient();
    await prisma.$connect();
    service = new SearchService(prisma as unknown as PrismaService, embedder);

    alice = await createUser('alice');
    bob = await createUser('bob');
    bulk = await createUser('bulk');
    fresh = await createUser('fresh');
    tidy = await createUser('tidy');

    // -- (1) A term that appears ONLY in a segment, in no title anywhere ------
    {
      const { transcript, speakerId } = await createTranscript(
        alice.id,
        `${TITLE_PREFIX}Weekly Engineering Sync`,
      );
      ids.segmentOnly = transcript.id;
      await addSegments(transcript.id, speakerId, [
        'Good morning everyone, thanks for joining.',
        'We agreed that the zarquon rollout starts on Monday.',
        'Anything else before we wrap up?',
      ]);
    }

    // -- (5) max-vs-sum: a SHORT recording that is ABOUT `vorpal`, and a long
    //        one that mentions it thirty times in passing. Built so that the
    //        SUM of the long one's unit scores is far larger than the short
    //        one's best unit — i.e. so `sum` would order these BACKWARDS.
    {
      const short = await createTranscript(alice.id, `${TITLE_PREFIX}Short Focused Call`);
      ids.vorpalShort = short.transcript.id;
      await addSegments(short.transcript.id, short.speakerId, [
        'Vorpal is the whole point of this review: vorpal tiers, vorpal floors, ' +
          'and how we explain vorpal to customers.',
      ]);

      const long = await createTranscript(alice.id, `${TITLE_PREFIX}All Hands Quarterly`);
      ids.vorpalLong = long.transcript.id;
      await addSegments(
        long.transcript.id,
        long.speakerId,
        Array.from(
          { length: PASSING_MENTIONS },
          () => 'We also briefly mentioned vorpal in passing before moving on to the next item.',
        ),
      );
    }

    // -- (6) A segment containing live markup --------------------------------
    {
      const { transcript, speakerId } = await createTranscript(
        alice.id,
        `${TITLE_PREFIX}Markup Incident Review`,
      );
      ids.escaping = transcript.id;
      await addSegments(transcript.id, speakerId, [
        // The `&`, the `"` and the `'` sit tightly around the match term on
        // purpose: `ts_headline` returns a WINDOW, and a character parked at
        // the far end of the sentence can fall outside it — which would make
        // the escaping assertions below pass vacuously.
        'Somebody pasted <script>alert(1)</script> into the "xylophone" & drums field ' +
          "again and it didn't break the build today, thankfully.",
      ]);
    }

    // -- (2) A term in a NOTE BODY, absent from its title ---------------------
    ids.bodyNote = (
      await createNote(
        alice.id,
        `${TITLE_PREFIX}Untitled Summary`,
        'The team concluded that the tesseract approach is the only one that scales.',
      )
    ).id;

    // -- (3) Visibility: Bob's private transcript, Bob's shared transcript,
    //        and Bob's note. `grimwald` is in all three.
    {
      const priv = await createTranscript(bob.id, `${TITLE_PREFIX}Bob Private Call`);
      ids.bobPrivate = priv.transcript.id;
      await addSegments(priv.transcript.id, priv.speakerId, [
        'The grimwald numbers are not public yet.',
      ]);

      const shared = await createTranscript(bob.id, `${TITLE_PREFIX}Bob Shared Call`);
      ids.bobShared = shared.transcript.id;
      await addSegments(shared.transcript.id, shared.speakerId, [
        'Here is the grimwald walkthrough I promised you.',
      ]);
      await prisma.transcriptShare.create({
        data: {
          transcriptId: shared.transcript.id,
          userId: alice.id,
          role: 'viewer',
          grantedById: bob.id,
        },
      });

      ids.bobNote = (
        await createNote(
          bob.id,
          `${TITLE_PREFIX}Bob Private Note`,
          'My own grimwald conclusions, for my eyes only.',
        )
      ).id;
    }

    // -- (4) Soft-deleted rows ------------------------------------------------
    {
      const { transcript, speakerId } = await createTranscript(
        alice.id,
        `${TITLE_PREFIX}Deleted Recording`,
        { deletedAt: new Date() },
      );
      ids.deletedTranscript = transcript.id;
      await addSegments(transcript.id, speakerId, ['The narwhal migration is cancelled.']);

      ids.deletedNote = (
        await createNote(alice.id, `${TITLE_PREFIX}Deleted Note`, 'Narwhal retrospective.', {
          deletedAt: new Date(),
        })
      ).id;
    }

    // -- (8) Paging -----------------------------------------------------------
    for (let i = 0; i < 6; i += 1) {
      await createNote(
        alice.id,
        `${TITLE_PREFIX}Paging Note ${i}`,
        `Everything about paginato, entry number ${i}.`,
      );
    }

    // -- (7) Stopword degradation: the only two titles containing "of the" ----
    {
      const { transcript } = await createTranscript(
        alice.id,
        `${TITLE_PREFIX}Minutes of the Board`,
      );
      ids.stopwordTranscript = transcript.id;

      ids.stopwordNote = (
        await createNote(alice.id, `${TITLE_PREFIX}Notes of the Retreat`, 'Body text.')
      ).id;
    }

    // -- (10) The semantic corpus (#189) -------------------------------------
    //
    // Four documents Alice can see, on three orthogonal topics plus one
    // deliberate near-miss. Every similarity this suite depends on is fixed by
    // these axes and written down beside the assertion that reads it.
    {
      // A. THE PARAPHRASE TARGET. Its text shares no stemmed term with the
      //    query that must find it — the whole point of epic #165.
      const target = await createTranscript(alice.id, `${TITLE_PREFIX}Tariff Decision`);
      ids.semanticTarget = target.transcript.id;
      const targetText =
        'We decided to raise the subscription tariff for enterprise accounts next quarter.';
      await addSegments(target.transcript.id, target.speakerId, [targetText]);
      await embedDocument('transcript', target.transcript.id, targetText, AXIS_BILLING);
      await markIndexState('transcript', target.transcript.id, alice.id, 'indexed');

      // B. THE VECTOR DECOY. Perfectly on the greenhouse axis, so it is the
      //    NEAREST document to the `PROJ4471` query vector — and contains no
      //    `PROJ4471` anywhere. A pure-vector ranking puts this first.
      const decoy = await createTranscript(alice.id, `${TITLE_PREFIX}Greenhouse Notes`);
      ids.vectorDecoy = decoy.transcript.id;
      const decoyText = 'Unrelated ramblings about greenhouse irrigation schedules.';
      await addSegments(decoy.transcript.id, decoy.speakerId, [decoyText]);
      await embedDocument('transcript', decoy.transcript.id, decoyText, AXIS_GREENHOUSE);
      await markIndexState('transcript', decoy.transcript.id, alice.id, 'indexed');

      // C. THE LEXICAL TARGET. Holds the literal token, and sits at similarity
      //    0.6 from that same query vector — over the floor, under the decoy.
      const literal = await createTranscript(alice.id, `${TITLE_PREFIX}Budget Approval`);
      ids.lexicalTarget = literal.transcript.id;
      const literalText = 'The PROJ4471 budget was approved this morning.';
      await addSegments(literal.transcript.id, literal.speakerId, [literalText]);
      await embedDocument(
        'transcript',
        literal.transcript.id,
        literalText,
        AXIS_BUDGET_NEAR_GREENHOUSE,
      );
      await markIndexState('transcript', literal.transcript.id, alice.id, 'indexed');

      // D. BOB'S PRIVATE, INDEXED DOCUMENT, on the SAME axis as the decoy — so
      //    it is tied for nearest and Alice must still never see it.
      const bobPrivate = await createTranscript(bob.id, `${TITLE_PREFIX}Bob Greenhouse Log`);
      ids.bobIndexedPrivate = bobPrivate.transcript.id;
      const bobText = 'Private irrigation measurements for the greenhouse.';
      await addSegments(bobPrivate.transcript.id, bobPrivate.speakerId, [bobText]);
      await embedDocument('transcript', bobPrivate.transcript.id, bobText, AXIS_GREENHOUSE);
      await markIndexState('transcript', bobPrivate.transcript.id, bob.id, 'indexed');

      // E. THE TRANSCRIPT BOB SHARED WITH ALICE, on its own axis — a share has
      //    to reach the vector arm exactly as it reaches the full-text one.
      await embedDocument(
        'transcript',
        ids.bobShared,
        'Here is the grimwald walkthrough I promised you.',
        AXIS_SHARED,
      );
      await markIndexState('transcript', ids.bobShared, bob.id, 'indexed');
    }

    // -- (11) A user with content but nothing embedded ------------------------
    {
      const { transcript, speakerId } = await createTranscript(
        fresh.id,
        `${TITLE_PREFIX}Fresh Recording`,
      );
      ids.freshTranscript = transcript.id;
      await addSegments(transcript.id, speakerId, ['The wombat inventory is complete.']);
    }

    // -- (12) A small library whose indexing state is fully known -------------
    {
      for (const suffix of ['One', 'Two']) {
        const { transcript } = await createTranscript(tidy.id, `${TITLE_PREFIX}Tidy ${suffix}`);
        await markIndexState('transcript', transcript.id, tidy.id, 'indexed');
      }

      // `failed`, not "no row": both are "not indexed", and one predicate has
      // to cover both or the count lies about the interesting half.
      const { transcript } = await createTranscript(tidy.id, `${TITLE_PREFIX}Tidy Three`);
      ids.tidyFailed = transcript.id;
      await markIndexState('transcript', transcript.id, tidy.id, 'failed');

      const note = await createNote(tidy.id, `${TITLE_PREFIX}Tidy Note`, 'Body text.');
      await markIndexState('note', note.id, tidy.id, 'indexed');
    }

    // -- (9) Truncation, on its own user so nothing else is in the window -----
    await prisma.note.createMany({
      data: Array.from({ length: MAX_CANDIDATE_DOCUMENTS + 1 }, (_, i) => ({
        ownerId: bulk.id,
        title: `${TITLE_PREFIX}Bulk ${i}`,
        body: `A capacitor discussion, number ${i}.`,
        sourceType: 'document' as const,
        status: 'ready' as const,
      })),
    });
  }, 120_000);

  afterAll(async () => {
    // Children first, then the documents, then their storage objects, then the
    // users — the same order `search-vectors.db.spec.ts` uses.
    //
    // ⚠ `search_chunks` FIRST AND BY HAND. `document_id` carries no foreign key
    // in either direction (the migration header's point 2), so nothing cascades
    // these away when the transcript goes — the suite that created them owns
    // them, which is the same responsibility that header hands to
    // `transcript.purge`. `search_embeddings` cascades off the chunk;
    // `search_index_state` cascades off its owner, but is cleared here too so
    // this suite does not depend on the order users are deleted in.
    await prisma.$executeRaw`
      DELETE FROM search_chunks WHERE content_hash LIKE ${`${TITLE_PREFIX}%`}
    `;
    await prisma.searchIndexState.deleteMany({
      where: { owner: { email: { startsWith: EMAIL_PREFIX } } },
    });
    await prisma.note.deleteMany({ where: { title: { startsWith: TITLE_PREFIX } } });
    await prisma.transcriptSegment.deleteMany({
      where: { transcript: { title: { startsWith: TITLE_PREFIX } } },
    });
    await prisma.transcriptShare.deleteMany({
      where: { transcript: { title: { startsWith: TITLE_PREFIX } } },
    });
    await prisma.transcriptSpeaker.deleteMany({
      where: { transcript: { title: { startsWith: TITLE_PREFIX } } },
    });
    await prisma.transcript.deleteMany({ where: { title: { startsWith: TITLE_PREFIX } } });
    await prisma.storageObject.deleteMany({ where: { storageKey: { startsWith: KEY_PREFIX } } });
    await prisma.user.deleteMany({ where: { email: { startsWith: EMAIL_PREFIX } } });
    await prisma?.$disconnect();
  }, 120_000);

  // ===========================================================================
  // 1-2. Content, not titles — the headline criterion of the epic
  // ===========================================================================

  describe('searching content', () => {
    it('finds a transcript from a term that is only in a segment and in NO title', async () => {
      // THE WHOLE POINT OF EPIC #164. `GET /api/transcripts?q=zarquon` — a
      // title substring filter — returns nothing for this, and always will.
      const result = await search('zarquon', requestUser(alice.id));

      expect(result.results.map((r) => r.id)).toEqual([ids.segmentOnly]);
      expect(result.results[0].type).toBe('transcript');
      expect(result.results[0].title).toBe(`${TITLE_PREFIX}Weekly Engineering Sync`);
      expect(result.degraded).toBeNull();
    });

    it('carries the segment snippet, marked, with a seekable startMs', async () => {
      const result = await search('zarquon', requestUser(alice.id));
      const [snippet] = result.results[0].snippets;

      expect(snippet.field).toBe('segment');
      expect(snippet.html).toContain('<mark>zarquon</mark>');
      // The matching line is the second segment, at 5s.
      expect(snippet.startMs).toBe(5_000);
    });

    it('finds a note from a term that is only in its body', async () => {
      const result = await search('tesseract', requestUser(alice.id));

      expect(result.results.map((r) => r.id)).toEqual([ids.bodyNote]);
      expect(result.results[0].type).toBe('note');
      expect(result.results[0].snippets[0].field).toBe('body');
      expect(result.results[0].snippets[0].html).toContain('<mark>tesseract</mark>');
      expect(result.results[0].snippets[0].startMs).toBeNull();
    });

    it('honours the `types` filter', async () => {
      const notesOnly = await search('tesseract', requestUser(alice.id), { types: 'transcript' });

      expect(notesOnly.results).toHaveLength(0);
      expect(notesOnly.searchedTypes).toEqual(['transcript']);
    });
  });

  // ===========================================================================
  // 3. Visibility — the security boundary
  // ===========================================================================

  describe('visibility', () => {
    it("never returns another user's transcript", async () => {
      const result = await search('grimwald', requestUser(alice.id));

      expect(result.results.map((r) => r.id)).not.toContain(ids.bobPrivate);
    });

    it('does return a transcript that user shared with the caller', async () => {
      const result = await search('grimwald', requestUser(alice.id));

      expect(result.results.map((r) => r.id)).toContain(ids.bobShared);
    });

    it("never returns another user's note, even when that user shared a transcript", async () => {
      // Alice holds a share on one of Bob's TRANSCRIPTS. Notes are not
      // shareable and there is no `notes:read_any` for any role, so the share
      // must not become a foothold into Bob's notes.
      const result = await search('grimwald', requestUser(alice.id));

      expect(result.results.map((r) => r.id)).not.toContain(ids.bobNote);
      expect(result.results.every((r) => r.type === 'transcript')).toBe(true);
    });

    it('returns exactly the shared transcript for Alice, and all three for Bob', async () => {
      const forAlice = await search('grimwald', requestUser(alice.id));
      const forBob = await search('grimwald', requestUser(bob.id));

      expect(forAlice.results.map((r) => r.id).sort()).toEqual([ids.bobShared]);
      expect(forBob.results.map((r) => r.id).sort()).toEqual(
        [ids.bobPrivate, ids.bobShared, ids.bobNote].sort(),
      );
    });

    it('applies visibility INSIDE the window, not after it', async () => {
      // Bulk owns 201 documents matching `capacitor`. If visibility were
      // applied AFTER the top-200 were chosen, Alice — who owns none of them —
      // would still get an empty list here, so this test alone cannot
      // distinguish the two. What it CAN show is the other half of the same
      // property: Bulk's own window is full and correct while Alice's is
      // empty, from the identical query.
      const forAlice = await search('capacitor', requestUser(alice.id));
      const forBulk = await search('capacitor', requestUser(bulk.id));

      expect(forAlice.results).toHaveLength(0);
      expect(forAlice.matchedDocuments).toBe(0);
      expect(forBulk.matchedDocuments).toBe(MAX_CANDIDATE_DOCUMENTS);
    });

    it('returns nothing to a caller who cannot read the type they asked for', async () => {
      const result = await search('zarquon', requestUser(alice.id, [PERMISSIONS.NOTES_READ]));

      expect(result.searchedTypes).toEqual(['note']);
      expect(result.results).toHaveLength(0);
    });
  });

  // ===========================================================================
  // 4. Soft deletes
  // ===========================================================================

  describe('soft-deleted rows', () => {
    it('never surfaces a soft-deleted transcript or note', async () => {
      const result = await search('narwhal', requestUser(alice.id));

      expect(result.results).toHaveLength(0);
      expect(result.matchedDocuments).toBe(0);
    });

    it('excludes them from the degraded path too', async () => {
      const result = await search('of the', requestUser(alice.id));

      expect(result.results.map((r) => r.id)).not.toContain(ids.deletedTranscript);
      expect(result.results.map((r) => r.id)).not.toContain(ids.deletedNote);
    });
  });

  // ===========================================================================
  // 5. The roll-up is `max` — and `sum` would give the opposite order
  // ===========================================================================

  describe('document roll-up', () => {
    it('ranks a short recording that is ABOUT the term above a long one that mentions it in passing', async () => {
      const result = await search('vorpal', requestUser(alice.id));
      const order = result.results.map((r) => r.id);

      expect(order.indexOf(ids.vorpalShort)).toBeGreaterThan(-1);
      expect(order.indexOf(ids.vorpalLong)).toBeGreaterThan(-1);
      expect(order.indexOf(ids.vorpalShort)).toBeLessThan(order.indexOf(ids.vorpalLong));
    });

    it('is pinned by the fixture: `sum` really would reverse this order', async () => {
      // THE TEST THAT MAKES THE DECISION UNFALSIFIABLE BY ACCIDENT. It reads
      // the same per-segment scores the service rolls up and shows that the
      // two aggregations disagree — so a future change from `max` to `sum`
      // cannot pass the test above by coincidence.
      const rows = await prisma.$queryRaw<Array<{ id: string; max: number; total: number }>>`
        SELECT s.transcript_id::text AS id,
               max(ts_rank_cd(s.search_vector, plainto_tsquery('english', 'vorpal')))::double precision AS max,
               sum(ts_rank_cd(s.search_vector, plainto_tsquery('english', 'vorpal')))::double precision AS total
        FROM transcript_segments s
        WHERE s.search_vector @@ plainto_tsquery('english', 'vorpal')
        GROUP BY s.transcript_id
      `;

      const byId = new Map(rows.map((row) => [row.id, row]));
      const short = byId.get(ids.vorpalShort)!;
      const long = byId.get(ids.vorpalLong)!;

      expect(Number(short.max)).toBeGreaterThan(Number(long.max));
      expect(Number(long.total)).toBeGreaterThan(Number(short.total));
    });
  });

  // ===========================================================================
  // 6. Snippets are escaped AT the database boundary
  // ===========================================================================

  describe('snippet escaping', () => {
    it('emits no live markup from a segment that contains some', async () => {
      // `ts_headline`'s DEFAULT delimiters are `<b>`/`</b>` — it is a fragment
      // selector, not a sanitiser — so this is the end-to-end proof that the
      // real function, with the real options string, over a real row, cannot
      // put a live tag in front of a user.
      const result = await search('xylophone', requestUser(alice.id));
      const [snippet] = result.results[0].snippets;

      expect(snippet.html).not.toContain('<script');
      expect(snippet.html).not.toContain('</script>');
      expect(snippet.html).toContain('<mark>xylophone</mark>');

      // Every tag in the output is a `<mark>`, and they are balanced.
      expect(snippet.html.match(/<[^>]+>/g)).toEqual(['<mark>', '</mark>']);
    });

    it('escapes the HTML-significant characters that reach it from the corpus', async () => {
      // ⚠ READ THIS BEFORE "SIMPLIFYING" THE ESCAPE AWAY.
      //
      // Postgres's DEFAULT text-search parser tokenises `<script>` as a `tag`
      // token, and `ts_headline` does not re-emit tag tokens — so the angle
      // brackets in the fixture above never reach TypeScript at all, and the
      // assertion in the previous test would pass even with no escaping
      // whatsoever. THAT IS NOT A GUARANTEE THIS CODE MAY RELY ON: it is a
      // property of one parser configuration, it says nothing about the
      // characters below, and `search-snippet.spec.ts` covers the
      // angle-bracket case directly (`<script>alert(1)</script>` in,
      // `&lt;script&gt;` out) precisely because the database will not
      // reproduce it.
      //
      // `&`, `"` and `'` DO survive `ts_headline` verbatim, and each of them
      // is enough on its own to break out of an attribute or corrupt an
      // entity in a rendered snippet. This test proves the pipeline escapes
      // them, with the raw column asserted first so that a fixture whose
      // fragment window moved fails loudly instead of passing vacuously.
      const [raw] = await prisma.$queryRaw<Array<{ headline: string }>>`
        SELECT ts_headline('english'::regconfig, s.text,
                 plainto_tsquery('english'::regconfig, 'xylophone'),
                 'MaxFragments=1, MaxWords=32, MinWords=12') AS headline
        FROM transcript_segments s
        WHERE s.transcript_id = ${ids.escaping}::uuid
      `;

      expect(raw.headline).toContain('&');
      expect(raw.headline).toContain('"');
      expect(raw.headline).toContain("'");

      const result = await search('xylophone', requestUser(alice.id));
      const [snippet] = result.results[0].snippets;

      expect(snippet.html).toContain('&amp;');
      expect(snippet.html).toContain('&quot;');
      expect(snippet.html).toContain('&#39;');
      // Nothing was double-escaped on the way through.
      expect(snippet.html).not.toContain('&amp;amp;');
    });
  });

  // ===========================================================================
  // 7. All-stopword queries degrade rather than returning nothing
  // ===========================================================================

  describe('all-stopword queries', () => {
    it('would match nothing through the full-text index', async () => {
      // The premise, stated against the real dictionary rather than assumed.
      const [row] = await prisma.$queryRaw<Array<{ nodes: number }>>`
        SELECT numnode(plainto_tsquery('english', 'of the'))::int AS nodes
      `;

      expect(row.nodes).toBe(0);
    });

    it('falls back to title matches and says so', async () => {
      const result = await search('of the', requestUser(alice.id));

      expect(result.degraded).toBe('stopwords');
      expect(result.results.map((r) => r.id).sort()).toEqual(
        [ids.stopwordTranscript, ids.stopwordNote].sort(),
      );
    });

    it('marks the literal title match', async () => {
      const result = await search('of the', requestUser(alice.id));

      for (const row of result.results) {
        expect(row.snippets).toHaveLength(1);
        expect(row.snippets[0].field).toBe('title');
        expect(row.snippets[0].html).toContain('<mark>of the</mark>');
      }
    });
  });

  // ===========================================================================
  // 8. Paging
  // ===========================================================================

  describe('paging', () => {
    it('returns disjoint, correctly-ordered pages', async () => {
      const all = await search('paginato', requestUser(alice.id), { limit: 6 });
      expect(all.results).toHaveLength(6);

      const first = await search('paginato', requestUser(alice.id), { limit: 3 });
      expect(first.results).toHaveLength(3);
      expect(first.nextCursor).not.toBeNull();

      const second = await search('paginato', requestUser(alice.id), {
        limit: 3,
        cursor: first.nextCursor!,
      });

      const firstIds = first.results.map((r) => r.id);
      const secondIds = second.results.map((r) => r.id);

      expect(secondIds).toHaveLength(3);
      expect(firstIds.filter((id) => secondIds.includes(id))).toEqual([]);
      // The two pages are the single-page ordering, cut in half.
      expect([...firstIds, ...secondIds]).toEqual(all.results.map((r) => r.id));
      expect(second.nextCursor).toBeNull();
    });

    it('refuses page 1 of one search presented against a different `q`', async () => {
      const first = await search('paginato', requestUser(alice.id), { limit: 3 });

      // A 400, never a silent restart — see `search-cursor.ts`'s header for
      // why the forgiving behaviour is wrong on a relevance list.
      await expect(
        search('zarquon', requestUser(alice.id), { limit: 3, cursor: first.nextCursor! }),
      ).rejects.toThrow(/different search/i);
    });

    it('refuses a cursor presented by a different user', async () => {
      const first = await search('paginato', requestUser(alice.id), { limit: 3 });

      await expect(
        search('paginato', requestUser(bob.id), { limit: 3, cursor: first.nextCursor! }),
      ).rejects.toThrow(/different search/i);
    });
  });

  // ===========================================================================
  // 9. The bounded window
  // ===========================================================================

  describe('the candidate window', () => {
    it('caps matchedDocuments and reports truncated past the cap', async () => {
      const result = await search('capacitor', requestUser(bulk.id));

      expect(result.matchedDocuments).toBe(MAX_CANDIDATE_DOCUMENTS);
      expect(result.matchedDocuments).toBeLessThanOrEqual(MAX_CANDIDATE_DOCUMENTS);
      expect(result.truncated).toBe(true);
    });

    it('reports an exact count and truncated: false below the cap', async () => {
      const result = await search('paginato', requestUser(alice.id));

      expect(result.matchedDocuments).toBe(6);
      expect(result.truncated).toBe(false);
    });

    it('stops paging at the end of the window rather than off it', async () => {
      // The last reachable page is the one ending at the cap; there is no
      // cursor past it, because there is nothing past it to page into.
      let cursor: string | null = null;
      let seen = 0;
      let pages = 0;

      do {
        const page: Awaited<ReturnType<typeof search>> = await search(
          'capacitor',
          requestUser(bulk.id),
          { limit: 50, ...(cursor ? { cursor } : {}) },
        );

        seen += page.results.length;
        cursor = page.nextCursor;
        pages += 1;
      } while (cursor && pages < 10);

      expect(seen).toBe(MAX_CANDIDATE_DOCUMENTS);
      expect(cursor).toBeNull();
    });
  });
  // ===========================================================================
  // 10. The semantic arm and the fusion (#189)
  // ===========================================================================

  describe('hybrid ranking', () => {
    /** Shares no stemmed term with any document in this corpus. */
    const PARAPHRASE = 'invoice amounts billed each month';

    // -------------------------------------------------------------------------
    // The headline criterion of the epic
    // -------------------------------------------------------------------------

    it('the full-text arm really does find nothing for the paraphrase', async () => {
      // THE PREMISE, ASSERTED AGAINST THE REAL DICTIONARY rather than assumed.
      // Without this, the test below could pass because the lexical arm quietly
      // matched something — which is exactly the way a semantic-search test
      // flatters itself.
      const [overlap] = await prisma.$queryRaw<Array<{ matches: boolean }>>`
        SELECT (s.search_vector @@ plainto_tsquery('english'::regconfig, ${PARAPHRASE})) AS matches
        FROM transcript_segments s
        WHERE s.transcript_id = ${ids.semanticTarget}::uuid
      `;

      expect(overlap.matches).toBe(false);

      const keyless = await search(PARAPHRASE, requestUser(alice.id));

      expect(keyless.semantic).toBe(false);
      expect(keyless.results).toHaveLength(0);
    });

    it('finds the right transcript from a paraphrase that shares no word with it', async () => {
      // ⚠ THE TEST THAT PROVES THE EPIC WORKS. `GET /api/search?q=invoice
      // amounts billed each month` returns a recording whose text is "We
      // decided to raise the subscription tariff for enterprise accounts next
      // quarter" — no shared stem anywhere, so no amount of full-text ranking
      // could ever have surfaced it.
      embedAt(AXIS_BILLING);

      const result = await search(PARAPHRASE, requestUser(alice.id));

      expect(result.semantic).toBe(true);
      expect(result.semanticReason).toBeNull();
      expect(result.results[0].id).toBe(ids.semanticTarget);
      expect(result.results[0].title).toBe(`${TITLE_PREFIX}Tariff Decision`);
      // Found by meaning alone, so the lexical arm contributed no snippet.
      expect(result.results[0].snippets).toEqual([]);
    });

    // -------------------------------------------------------------------------
    // ...and exact terms do not get worse
    // -------------------------------------------------------------------------

    it('still ranks the literal token first when another document is nearer in vector space', async () => {
      // The query vector sits exactly on the DECOY's axis, so the decoy is the
      // nearest document in the corpus and contains no `PROJ4471` at all. Pure
      // semantic retrieval gets this wrong; fusion must not.
      embedAt(AXIS_GREENHOUSE);

      const result = await search('PROJ4471', requestUser(alice.id));

      expect(result.semantic).toBe(true);
      expect(result.results[0].id).toBe(ids.lexicalTarget);
      expect(result.results.map((r) => r.id)).toContain(ids.vectorDecoy);
      // Rank 1 lexically and rank 2 semantically — two terms against the
      // decoy's one, which is why cross-arm agreement wins.
      expect(result.results[0].score).toBeCloseTo(1 / (RRF_K + 1) + 1 / (RRF_K + 2), 9);
      expect(result.results[1].score).toBeCloseTo(1 / (RRF_K + 1), 9);
    });

    it('is pinned by the fixture: pure vector search really would reverse that', async () => {
      // THE TEST THAT MAKES THE DECISION UNFALSIFIABLE BY ACCIDENT, in the same
      // spirit as the `max` vs `sum` pinning above: the two arms are shown to
      // disagree, so the fused order cannot be right by coincidence.
      const rows = await prisma.$queryRaw<Array<{ id: string; similarity: number }>>`
        SELECT c.document_id::text AS id,
               max(1 - (e.embedding <=> ${vectorLiteral(AXIS_GREENHOUSE)}::vector))::double precision
                 AS similarity
        FROM search_embeddings e
        JOIN search_chunks c ON c.id = e.chunk_id
        WHERE c.document_id IN (${ids.lexicalTarget}::uuid, ${ids.vectorDecoy}::uuid)
        GROUP BY c.document_id
      `;

      const byId = new Map(rows.map((row) => [row.id, Number(row.similarity)]));

      expect(byId.get(ids.vectorDecoy)).toBeCloseTo(1, 6);
      expect(byId.get(ids.lexicalTarget)).toBeCloseTo(0.6, 6);
      // Both clear the floor, so the decoy's exclusion is not what saved this.
      expect(byId.get(ids.lexicalTarget)!).toBeGreaterThan(MIN_SEMANTIC_SIMILARITY);
    });

    // -------------------------------------------------------------------------
    // Degradation is legible, and never an error
    // -------------------------------------------------------------------------

    it('answers a caller with no API key with EXACTLY the full-text ranking', async () => {
      // The baseline is computed independently, from `ts_rank_cd` over the same
      // rows — not copied from a previous run of the endpoint, which would make
      // this a test of nothing.
      const baseline = await prisma.$queryRaw<Array<{ id: string }>>`
        SELECT s.transcript_id::text AS id,
               max(ts_rank_cd(s.search_vector, plainto_tsquery('english'::regconfig, 'vorpal')))
                 ::double precision AS score
        FROM transcript_segments s
        JOIN transcripts t ON t.id = s.transcript_id
        WHERE s.search_vector @@ plainto_tsquery('english'::regconfig, 'vorpal')
          AND t.deleted_at IS NULL
          AND t.owner_id = ${alice.id}::uuid
        GROUP BY s.transcript_id
        ORDER BY score DESC
      `;

      const result = await search('vorpal', requestUser(alice.id));

      expect(result.semantic).toBe(false);
      expect(result.semanticReason).toBe('ai_key_missing');
      expect(baseline.length).toBeGreaterThan(1);
      expect(result.results.map((r) => r.id)).toEqual(baseline.map((row) => row.id));
    });

    it('tells a user with nothing indexed why, and still answers with full text', async () => {
      // ⚠ ALSO THE PROOF THAT THE PROBE IS CALLER-SCOPED. This deployment has
      // plenty of embedded content — Alice's and Bob's — so a deployment-wide
      // "has anybody indexed anything" check would have said yes here, charged
      // this user's own key for a query vector, and handed back an empty
      // semantic list.
      embedAt(AXIS_BILLING);

      const result = await search('wombat', requestUser(fresh.id));

      expect(result.semantic).toBe(false);
      expect(result.semanticReason).toBe('no_indexed_content');
      expect(result.results.map((r) => r.id)).toEqual([ids.freshTranscript]);
    });

    it('degrades to full text when the provider fails while embedding the query', async () => {
      // A vendor outage, a revoked key, a 429 — all one reason here, because
      // there is no job to defer onto and somebody is waiting.
      plan = { ok: false, reason: 'embedding_failed' };

      const result = await search('zarquon', requestUser(alice.id));

      expect(result.semantic).toBe(false);
      expect(result.semanticReason).toBe('embedding_failed');
      expect(result.results.map((r) => r.id)).toEqual([ids.segmentOnly]);
    });

    // -------------------------------------------------------------------------
    // Visibility, inside the vector arm
    // -------------------------------------------------------------------------

    it("never returns another user's indexed document, however near its vector", async () => {
      // ⚠ BOB'S PRIVATE TRANSCRIPT IS ON THE SAME AXIS AS THE DECOY, so it is
      // TIED FOR NEAREST in the whole corpus. The only thing keeping it out of
      // Alice's results is the visibility predicate inside the vector arm's own
      // `LIMIT` — which is precisely what a top-k ANN rewrite would move.
      embedAt(AXIS_GREENHOUSE);

      const forAlice = await search(PARAPHRASE, requestUser(alice.id));
      const forBob = await search(PARAPHRASE, requestUser(bob.id));

      expect(forAlice.results.map((r) => r.id)).toContain(ids.vectorDecoy);
      expect(forAlice.results.map((r) => r.id)).not.toContain(ids.bobIndexedPrivate);
      expect(forBob.results.map((r) => r.id)).toContain(ids.bobIndexedPrivate);
    });

    it('does reach a transcript that was shared with the caller', async () => {
      // A share raises the ceiling in both arms or in neither; there is no
      // separate access model for semantic retrieval.
      embedAt(AXIS_SHARED);

      const result = await search(PARAPHRASE, requestUser(alice.id));

      expect(result.results.map((r) => r.id)).toEqual([ids.bobShared]);
    });

    it('never returns a note by meaning to somebody who does not own it', async () => {
      embedAt(AXIS_BILLING);

      const result = await search(PARAPHRASE, requestUser(alice.id));

      expect(result.results.map((r) => r.id)).not.toContain(ids.bobNote);
    });

    // -------------------------------------------------------------------------
    // The floor
    // -------------------------------------------------------------------------

    it('leaves out documents below the similarity floor instead of returning the corpus', async () => {
      // Alice can see five embedded documents. The query vector is orthogonal
      // to four of them, so an unfloored nearest-neighbour arm would return all
      // five ordered by irrelevance — and `matchedDocuments` would stop meaning
      // "how much matched".
      embedAt(AXIS_SHARED);

      const result = await search(PARAPHRASE, requestUser(alice.id));

      expect(result.results).toHaveLength(1);
      expect(result.matchedDocuments).toBe(1);
      expect(result.truncated).toBe(false);
    });

    it('can still answer "nothing matched" once the semantic arm is running', async () => {
      // The property the floor exists for, stated at its bluntest.
      embedAt({ 900: 1 });

      const result = await search(PARAPHRASE, requestUser(alice.id));

      expect(result.semantic).toBe(true);
      expect(result.results).toEqual([]);
      expect(result.matchedDocuments).toBe(0);
    });
  });

  // ===========================================================================
  // 11. `unindexedCount`
  // ===========================================================================

  describe('unindexedCount', () => {
    it('counts the caller own documents with no `indexed` state row', async () => {
      // `tidy` owns three transcripts: two `indexed`, one `failed`. A `failed`
      // row and no row at all are the same answer to "why did my search not
      // find it", and one `NOT EXISTS` covers both.
      const result = await search('tidy', requestUser(tidy.id), { types: 'transcript' });

      expect(result.unindexedCount).toBe(1);
    });

    it('is 0 when everything of that type is indexed', async () => {
      const result = await search('tidy', requestUser(tidy.id), { types: 'note' });

      expect(result.unindexedCount).toBe(0);
    });

    it('is scoped to the types actually searched', async () => {
      const both = await search('tidy', requestUser(tidy.id));

      expect(both.unindexedCount).toBe(1);
    });

    it('ignores documents the caller does not own, however visible', async () => {
      // Alice holds a share on one of Bob's transcripts. It is indexed on BOB's
      // key by BOB's pipeline, so counting it in Alice's total would report a
      // number she has no way to move.
      const forBob = await search('grimwald', requestUser(bob.id), { types: 'transcript' });

      // Bob owns three transcripts here; two of them carry `indexed` state.
      expect(forBob.unindexedCount).toBe(1);
    });
  });

  // ===========================================================================
  // 12. The cursor across the semantic axis
  // ===========================================================================

  describe('cursors and the semantic axis', () => {
    it('refuses a full-text cursor once the semantic arm starts running', async () => {
      // Nothing about the REQUEST changed between these two calls — same query,
      // same types, same user. Only whether the caller could embed did.
      const first = await search('paginato', requestUser(alice.id), { limit: 3 });

      expect(first.semantic).toBe(false);
      expect(first.nextCursor).not.toBeNull();

      embedAt(AXIS_BILLING);

      await expect(
        search('paginato', requestUser(alice.id), { limit: 3, cursor: first.nextCursor! }),
      ).rejects.toThrow(/different search/i);
    });

    it('pages a fused window with the cursor that window minted', async () => {
      embedAt(AXIS_BILLING);

      const first = await search('paginato', requestUser(alice.id), { limit: 3 });

      // Six `paginato` notes plus the one document the vector arm reached.
      expect(first.semantic).toBe(true);
      expect(first.matchedDocuments).toBe(7);

      embedAt(AXIS_BILLING);

      const second = await search('paginato', requestUser(alice.id), {
        limit: 3,
        cursor: first.nextCursor!,
      });

      const firstIds = first.results.map((r) => r.id);
      const secondIds = second.results.map((r) => r.id);

      expect(secondIds).toHaveLength(3);
      expect(firstIds.filter((id) => secondIds.includes(id))).toEqual([]);
    });
  });
});
