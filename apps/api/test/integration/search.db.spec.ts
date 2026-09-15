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
// =============================================================================

import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';

import type { RequestUser } from '../../src/auth/interfaces/authenticated-user.interface';
import { PERMISSIONS } from '../../src/common/constants/roles.constants';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { MAX_CANDIDATE_DOCUMENTS } from '../../src/search/dto/search.dto';
import { SearchService } from '../../src/search/search.service';
import { createDbClient, resolveDbSuite } from '../jobs/db-test-support';

const { describeWithDb } = resolveDbSuite('search.db.spec');

/** Every row this suite creates is named with one of these, and cleaned by it. */
const TITLE_PREFIX = 'search-ep-';
const EMAIL_PREFIX = 'search-endpoint-test';
const KEY_PREFIX = 'test-search-endpoint/';

/** Long enough that `sum` would beat `max` by an order of magnitude. */
const PASSING_MENTIONS = 30;

describeWithDb('GET /api/search (real Postgres)', () => {
  let prisma: PrismaClient;
  let service: SearchService;

  let alice: { id: string };
  let bob: { id: string };
  let bulk: { id: string };

  const ids: Record<string, string> = {};

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
    service = new SearchService(prisma as unknown as PrismaService);

    alice = await createUser('alice');
    bob = await createUser('bob');
    bulk = await createUser('bulk');

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
});
