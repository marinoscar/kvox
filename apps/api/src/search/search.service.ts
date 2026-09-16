// =============================================================================
// Ranked hybrid search across transcripts and notes
// (issue #175, epic #164; the semantic arm and the fusion are issue #189,
// epic #165)
// =============================================================================
//
// TWO RETRIEVAL ARMS, ONE SEARCH BOX, FUSED BY RECIPROCAL RANK
// -----------------------------------------------------------------------------
//
// The lexical arm is epic #164's and is unchanged below: `ts_rank_cd` over the
// generated `tsvector` columns, rolled up per document by `max`. The semantic
// arm is #189's: cosine distance over `search_embeddings`, rolled up the same
// way. Neither is a mode the user picks. `search-fusion.ts` carries the whole
// argument for WHY the two are combined by rank rather than by normalised
// score, and why a "semantic / keyword" toggle was rejected outright; read it
// before changing how the two lists meet.
//
// The one thing to keep in mind while reading this file is that THE SEMANTIC
// ARM IS OPTIONAL AT RUNTIME AND ITS ABSENCE IS NEVER AN ERROR. Content is
// embedded at index time with its owner's key; the QUERY is embedded with the
// SEARCHER'S key, and a searcher who has not saved one gets the lexical
// ranking, a `200`, and `semantic: false` with a reason. See
// `search-semantic.ts`.
//
// EVERY STATEMENT IN THIS FILE IS A PURE `SELECT`, AND EVERY VALUE IS BOUND
// -----------------------------------------------------------------------------
//
// The same posture `jobs/job-insights.service.ts` takes, adopted here for two
// reasons rather than one.
//
// The first is that file's own: a plain `SELECT` takes `ACCESS SHARE`, which
// conflicts with nothing this application does in normal operation. This
// endpoint reads `transcript_segments` and `notes` - tables the transcript
// pipeline and the note generator write to constantly, the latter appending
// deltas mid-stream - and a search that took any conflicting lock would stall
// the pipeline it is searching the output of.
//
// The second is specific to this endpoint and is sharper: `q` IS A STRING A
// STRANGER TYPED. It reaches four different SQL functions here
// (`plainto_tsquery`, `ts_rank_cd`, `ts_headline`, and `ILIKE` on the degraded
// path), and it reaches every one of them as a BOUND PARAMETER - never as
// text spliced into a statement. `Prisma.sql` tagged templates are what make
// that structural rather than a habit: an interpolation in one of these
// templates becomes a placeholder, and the only way to get raw text into the
// statement is to reach for `Prisma.raw`, which appears exactly twice in this
// file and only ever receives a value from a closed union of literal table
// aliases declared here (see {@link TranscriptAlias}).
//
// The rules for anyone extending this file, unchanged from the insights
// service's list:
//
//   - `$queryRaw` only. NO `$executeRaw`, no write of any kind - not a search
//     log, not a "popular query" counter, not a `last_searched_at` stamp.
//   - NO `FOR UPDATE`, `FOR SHARE`, `LOCK TABLE` or advisory lock. Ever.
//   - Every statement's text begins with `SELECT`, and
//     `search.service.spec.ts` asserts it for every raw statement this file
//     issues - the same assertion `job-insights.service.spec.ts` carries.
//
// -----------------------------------------------------------------------------
// THE FIVE DECISIONS THAT MAKE THIS A RANKING AND NOT A LIST
// -----------------------------------------------------------------------------
//
// 1. VISIBILITY IS INSIDE THE CANDIDATE WINDOW - IN EVERY ARM, INCLUDING THE
//    VECTOR ONE. See the block comment above {@link transcriptVisibleSql} -
//    this is the one that is catastrophic to "optimise" and the one that looks
//    most optimisable, and the semantic arm is where it looks MOST optimisable
//    of all (see {@link transcriptVectorCandidatesSql}).
//
// 2. THE ROLL-UP IS `max`, NEVER `sum`. See {@link transcriptCandidatesSql},
//    and note that the vector arm rolls up by `max(similarity)` for the
//    identical reason - a document's score is its BEST passage's, in both
//    arms, so a fused rank never rewards length.
//
// 3. `ts_rank_cd`, NOT `ts_rank`. `ts_rank` scores a document on term
//    frequency alone: a document that says "pricing" thirty times scores
//    higher than one where "pricing" and "model" appear in the same sentence.
//    `ts_rank_cd` is COVER DENSITY - it rewards query terms appearing CLOSE
//    TOGETHER, which is what "this document is about that phrase" actually
//    looks like in text. Somebody searching "quarterly pricing review" is
//    describing a topic, not listing three independent words, and the
//    paraphrase-adjacent match ("the review of quarterly pricing") is the one
//    they want first. Cover density finds it; frequency does not.
//
// 4. THE WINDOW IS BOUNDED AND PAGED BY OFFSET, NOT BY A KEYSET. A keyset
//    cursor needs a total order that is stable across requests, and a
//    relevance score is neither unique nor stable (two documents tie
//    constantly, and an edit to either moves it). Offset into a bounded window
//    is honest about what it is - and the window's boundedness is what makes
//    `truncated` publishable instead of a `total` that is really a cap. See
//    `dto/search.dto.ts`.
//
// 5. THE TWO ARMS ARE FUSED BY RANK, NOT BY BLENDED SCORE, AND EACH ARM IS
//    RANKED BY THE DATABASE BEFORE FUSION HAPPENS IN TYPESCRIPT. Each arm's
//    `ORDER BY ... LIMIT` is what assigns its ranks, so the fusion function is
//    pure and has no idea what a `ts_rank_cd` or a cosine distance is. See
//    `search-fusion.ts`.
//
// -----------------------------------------------------------------------------
// CANDIDATES AND SNIPPETS ARE SEPARATE QUERIES
// -----------------------------------------------------------------------------
//
// The candidate query returns identifiers, titles and scores for up to
// {@link MAX_CANDIDATE_DOCUMENTS} + 1 documents; the snippet query renders
// `ts_headline` for the ONE PAGE the caller asked for. Splitting them is not a
// micro-optimisation: `ts_headline` re-parses and re-scans the source text for
// every row it touches, so headlining the whole window would do two hundred
// documents' worth of text processing to show twenty. The segment arm bounds
// it further by picking each transcript's best few segments BEFORE headlining
// them.
//
// ⚠ SNIPPETS ARE STILL RENDERED BY `ts_headline`, EVEN FOR A DOCUMENT THE
// VECTOR ARM FOUND AND THE LEXICAL ARM DID NOT. That document simply has no
// snippet - `snippets: []` - rather than a fabricated one, and the DTO already
// promises an array that may be empty. The alternative would be to render the
// nearest CHUNK's text as a snippet, which is a real feature and is
// deliberately not this issue's: a chunk is up to 1,600 characters with
// speaker labels glued on and no notion of which part of it was near the query,
// so shipping it as a "snippet" would put a paragraph where a sentence goes.
// `search_chunks.char_start`/`char_end` exist precisely so that a later issue
// can do it properly.
// =============================================================================

import { BadRequestException, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PERMISSIONS } from '../common/constants/roles.constants';
import {
  toRequestUser,
  type AuthenticatedUser,
  type RequestUser,
} from '../auth/interfaces/authenticated-user.interface';
import { PrismaService } from '../prisma/prisma.service';
import {
  MAX_CANDIDATE_DOCUMENTS,
  type SearchQueryDto,
  type SearchResponse,
} from './dto/search.dto';
import {
  decodeSearchCursor,
  encodeSearchCursor,
  SearchCursorError,
  type SearchCursorScope,
} from './search-cursor';
import {
  isStopwordOnly,
  normalizeQueryText,
  parseTypesParam,
  titleLikePattern,
  SEARCH_TYPES,
  type SearchType,
} from './search-query';
import { reciprocalRankFusion } from './search-fusion';
import { SearchQueryEmbedder } from './search-query-embedder.service';
import { semanticAxis, type SemanticQueryPlan } from './search-semantic';
import {
  HEADLINE_OPTIONS,
  MAX_SNIPPETS_PER_RESULT,
  markLiteral,
  renderHeadlineHtml,
} from './search-snippet';

/**
 * Which permission gates which document type.
 *
 * ONE MAPPING, read by the narrowing below and by nothing else, so "what does
 * a caller need in order to search notes" has a single answer. Both strings
 * are the exact ones their own controllers enforce - `notes.controller.ts`
 * gates every note read on `notes:read` and `transcripts.controller.ts` gates
 * every transcript read on `transcripts:read` - which is the same discipline
 * the admin section registry's `permission` field follows.
 */
const TYPE_PERMISSIONS: Record<SearchType, string> = {
  transcript: PERMISSIONS.TRANSCRIPTS_READ,
  note: PERMISSIONS.NOTES_READ,
};

/**
 * The table aliases {@link Prisma.raw} is ever allowed to see.
 *
 * A closed union of literals declared in this file. `Prisma.raw` splices text
 * into the statement verbatim, so the only safe argument is one that cannot
 * originate anywhere near a request - and a union type is how the compiler
 * enforces that rather than a comment asking nicely.
 */
type TranscriptAlias = 'tt' | 'st' | 't';
type NoteAlias = 'n';

/** `plainto_tsquery`, with `q` BOUND and the configuration explicit. */
function tsQuery(q: string): Prisma.Sql {
  // The two-argument form with an explicit `'english'::regconfig`, matching
  // the generated columns' own expressions exactly (see
  // `20260915120000_add_search_vectors/migration.sql`). The one-argument form
  // reads `default_text_search_config` from session state, so a query using it
  // could silently parse under a different configuration than the one the
  // indexed vectors were built with - and would then match nothing, or match
  // differently, depending on a GUC nobody set on purpose.
  return Prisma.sql`plainto_tsquery('english'::regconfig, ${q})`;
}

/**
 * A transcript this caller may see.
 *
 * ⚠⚠ THIS PREDICATE BELONGS INSIDE THE CANDIDATE QUERY'S OWN `LIMIT`, AND
 * MOVING IT OUTSIDE IS THE SINGLE EASIEST THING TO "OPTIMISE" WRONGLY HERE.
 * -----------------------------------------------------------------------------
 *
 * The tempting shape is: rank the whole corpus, take the top 200, then filter
 * those 200 down to what the caller may read. It looks equivalent, it is
 * obviously cheaper (one visibility check per surviving row instead of one per
 * match), and it is WRONG in a way that produces no error anywhere.
 *
 * Consider a deployment where a user owns 1% of the documents. A query with
 * 20,000 excellent matches across the corpus fills the top 200 with other
 * people's documents; the post-filter removes essentially all of them, and the
 * user is told their search found NOTHING - while 200 of their own documents
 * matched it perfectly and were never looked at. The failure scales with the
 * deployment: it is invisible on a single-user dev database (where the caller
 * owns everything, so pre- and post-filtering agree exactly) and total on a
 * busy one. It is also silent - there is no exception, no log line, no
 * degraded flag, just an empty result list that looks like an honest "no
 * matches".
 *
 * So the `LIMIT` that bounds the candidate window is applied to rows that have
 * ALREADY passed this predicate, in every arm, always. The top 200 is the top
 * 200 OF WHAT THIS CALLER CAN SEE.
 *
 * The predicate itself is `TranscriptsService.scopeWhere`'s, in SQL: not
 * soft-deleted, and either owned by the caller or shared with them. It is
 * duplicated here rather than reused because that one is a
 * `Prisma.TranscriptWhereInput` and this is a raw statement; if the two ever
 * disagree, THIS ONE IS THE BUG - `scopeWhere` is the definition.
 */
function transcriptVisibleSql(alias: TranscriptAlias, userId: string): Prisma.Sql {
  const a = Prisma.raw(alias);

  return Prisma.sql`
    ${a}.deleted_at IS NULL
    AND (
      ${a}.owner_id = ${userId}::uuid
      OR EXISTS (
        SELECT 1 FROM transcript_shares sh
        WHERE sh.transcript_id = ${a}.id AND sh.user_id = ${userId}::uuid
      )
    )
  `;
}

/**
 * A note this caller may see.
 *
 * ⚠ NOTES ARE NOT SHAREABLE, AND THERE IS NO SHARE JOIN HERE ON PURPOSE.
 * `notes` has no `note_shares` table, there is no `notes:read_any` permission
 * for any role including Admin, and `NoteAccessService` scopes every read to
 * `ownerId`. A share join added here "for symmetry" with transcripts would not
 * merely be dead code - it would be this application's first path to reading
 * somebody else's note, built by a file whose job is to find things.
 *
 * The same "inside the LIMIT" rule as {@link transcriptVisibleSql} applies,
 * for the same reason and with the same failure mode.
 */
function noteVisibleSql(alias: NoteAlias, userId: string): Prisma.Sql {
  const a = Prisma.raw(alias);

  return Prisma.sql`${a}.deleted_at IS NULL AND ${a}.owner_id = ${userId}::uuid`;
}

/**
 * Transcript candidates: one row per VISIBLE transcript with at least one
 * matching unit, scored by the best unit it has.
 *
 * ⚠ THE ROLL-UP IS `max(u.score)`, AND IT MUST NEVER BECOME `sum`.
 * -----------------------------------------------------------------------------
 *
 * A transcript is not one document to the index - it is a title plus hundreds
 * of segments, each with its own vector. Something has to turn a bag of unit
 * scores into one document score, and the two obvious choices order the
 * results in opposite directions:
 *
 *   - `sum` measures HOW OFTEN a recording brushed past the term. A three-hour
 *     all-hands that says "pricing" thirty times in passing accumulates thirty
 *     small scores and beats a twenty-minute conversation that IS about
 *     pricing. Worse, it is a length bias wearing a relevance costume: the
 *     longer the recording, the more units it has to add up, so `sum`
 *     systematically promotes long documents over short ones REGARDLESS of
 *     what either is about.
 *   - `max` measures HOW WELL the best passage in this recording matches. The
 *     short, on-topic conversation wins, which is the answer a person asking
 *     "which of my recordings was about pricing" wanted.
 *
 * The transcript title is one of the units in this roll-up rather than a
 * separate score added on top, which is what lets a recording titled
 * "Q3 Pricing Review" surface even when its spoken content never says the
 * word - the case `transcripts.title_search_vector` exists as its own column
 * for (see the migration header).
 *
 * The inner union drives from the GIN indexes (`... @@ tsquery` on an indexed
 * vector) rather than scanning `transcripts` and probing each one, so the
 * matching segments are found by the index and the parent rows are fetched for
 * the handful of transcripts that survived.
 */
function transcriptCandidatesSql(q: string, userId: string): Prisma.Sql {
  return Prisma.sql`
    SELECT
      'transcript'::text AS type,
      t.id::text AS id,
      t.title AS title,
      t.status::text AS status,
      t.updated_at AS updated_at,
      max(u.score)::double precision AS score
    FROM (
      SELECT tt.id AS doc_id, ts_rank_cd(tt.title_search_vector, ${tsQuery(q)}) AS score
      FROM transcripts tt
      WHERE tt.title_search_vector @@ ${tsQuery(q)}
        AND ${transcriptVisibleSql('tt', userId)}
      UNION ALL
      SELECT s.transcript_id AS doc_id, ts_rank_cd(s.search_vector, ${tsQuery(q)}) AS score
      FROM transcript_segments s
      JOIN transcripts st ON st.id = s.transcript_id
      WHERE s.search_vector @@ ${tsQuery(q)}
        AND ${transcriptVisibleSql('st', userId)}
    ) u
    JOIN transcripts t ON t.id = u.doc_id
    GROUP BY t.id, t.title, t.status, t.updated_at
  `;
}

/**
 * Note candidates.
 *
 * No roll-up: a note's title and body are already ONE vector, weighted A and B
 * by the generated column, so `ts_rank_cd` over it is the document score
 * directly. That asymmetry with transcripts is a property of the schema, not
 * an inconsistency - see the migration header for why a note has one vector
 * and a transcript has a parent title vector plus a child table of them.
 */
function noteCandidatesSql(q: string, userId: string): Prisma.Sql {
  return Prisma.sql`
    SELECT
      'note'::text AS type,
      n.id::text AS id,
      n.title AS title,
      n.status::text AS status,
      n.updated_at AS updated_at,
      ts_rank_cd(n.search_vector, ${tsQuery(q)})::double precision AS score
    FROM notes n
    WHERE n.search_vector @@ ${tsQuery(q)}
      AND ${noteVisibleSql('n', userId)}
  `;
}

// ---------------------------------------------------------------------------
// The semantic arm (#189)
// ---------------------------------------------------------------------------

/**
 * A query vector as a pgvector literal, ready to be BOUND and cast.
 *
 * The literal is built here and bound as TEXT - `${literal}::vector` - so the
 * numbers reach the statement as a parameter like everything else in this file,
 * never as text spliced into it. `SearchQueryEmbedder` has already guaranteed
 * the width and that every component is finite, which is what makes `join`
 * safe: a `NaN` or an `undefined` here would render as a word and become a
 * malformed literal, i.e. a 500 from a `SELECT`.
 */
function vectorLiteral(vector: readonly number[]): string {
  return `[${vector.join(',')}]`;
}

/**
 * The cosine similarity a document's best chunk must reach to enter the
 * semantic candidate list at all.
 *
 * ⚠ WITHOUT A FLOOR, "NO RESULTS" STOPS BEING AN ANSWER THIS ENDPOINT CAN GIVE.
 * The lexical arm is self-limiting - a document either contains a lexeme or it
 * does not - but nearest-neighbour search has no such boundary: EVERY embedded
 * document has a distance from the query vector, so an unfloored vector arm
 * returns the caller's entire indexed corpus on every search, ordered by how
 * little it has to do with the question. Three things break at once, and none
 * of them looks like a bug in the fusion: a query about nothing returns 200
 * documents instead of an empty list; `matchedDocuments` becomes "how much have
 * you indexed" rather than "how much matched"; and `truncated` is permanently
 * `true` for anybody with more than {@link MAX_CANDIDATE_DOCUMENTS} documents,
 * which makes the honest count the DTO exists to publish permanently a floor.
 *
 * ⚠ IT IS A CUTOFF, NOT A TUNING KNOB, AND IT IS THE ONE ARBITRARY NUMBER ON
 * THIS PATH. It does not order anything - RRF does that, from ranks - and
 * raising or lowering it cannot make a relevant document outrank an irrelevant
 * one. All it decides is where "related enough to mention" sits. 0.25 is
 * deliberately permissive: for the normalised embeddings this application
 * stores, unrelated text pairs sit near zero and anything a person would call
 * "about the same thing" sits well above it, so the floor removes the long tail
 * without adjudicating the head. If it is ever tuned, it must be tuned against
 * measured recall on a real corpus - and it belongs in
 * `RANKING_MODEL_VERSION`'s list of things a change to invalidates cursors
 * over, because it changes which documents are reachable at all.
 */
export const MIN_SEMANTIC_SIMILARITY = 0.25;

/**
 * Transcript candidates by MEANING: one row per VISIBLE transcript with at
 * least one embedded chunk, scored by its nearest chunk.
 *
 * ⚠⚠ THE VISIBILITY PREDICATE IS INSIDE THIS ARM, AND THEREFORE INSIDE THE
 * OUTER `LIMIT`. THIS IS WHERE THAT RULE IS MOST TEMPTING TO BREAK AND MOST
 * EXPENSIVE TO BREAK.
 * -----------------------------------------------------------------------------
 *
 * The shape every pgvector tutorial shows is
 * `ORDER BY embedding <=> $1 LIMIT k` - a top-k approximate-nearest-neighbour
 * scan that the HNSW index answers directly. Written that way, the k nearest
 * chunks IN THE WHOLE CORPUS are chosen first and this caller's visibility is
 * applied afterwards, which is exactly the failure the block comment above
 * {@link transcriptVisibleSql} describes, with the same silence: a user who
 * owns 1% of the corpus gets an empty semantic arm from a query 200 of their
 * own documents answer well, with no error, no log line and no flag. It is
 * invisible on a single-user dev database and total on a real one.
 *
 * ⚠ SO THIS QUERY IS DELIBERATELY NOT INDEX-SHAPED, AND THAT IS A TRADE THIS
 * FILE MAKES ON PURPOSE. Filtering and grouping before the limit means the
 * planner will generally NOT use `search_embeddings_embedding_hnsw_idx` for the
 * ordering - it computes distances over the caller's own chunks and sorts them.
 * That is affordable precisely because the set is the caller's own documents,
 * not the corpus, and it is CORRECT, which the fast shape is not. Do not
 * "restore" the index scan by hoisting the `LIMIT`. (pgvector gained iterative
 * index scans, which can filter and keep recall, in 0.8; this deployment pins
 * 0.6. Revisiting this is a version upgrade plus a measurement, not an edit.)
 *
 * ⚠ `<=>` IS COSINE DISTANCE AND IT MUST MATCH THE INDEX'S `vector_cosine_ops`
 * OPCLASS - the migration header's point 4 states the consequence of a
 * mismatch and it is worth repeating because it is silent: an HNSW index whose
 * opclass differs from the operator a query uses is simply NOT USED, with no
 * error and no warning, and only `EXPLAIN` says so. Writing `<->` (L2) or `<#>`
 * (inner product) here would still return plausible-looking results - the
 * provider's vectors are normalised, so L2 ordering even agrees with cosine
 * ordering - while permanently orphaning the index. The operator, the opclass
 * and the provider's normalisation are one decision in three places.
 *
 * The roll-up is `max(1 - distance)` - the BEST chunk's similarity - which is
 * the same `max`-not-`sum` rule {@link transcriptCandidatesSql} argues for, and
 * `1 - distance` rather than `min(distance)` so both arms rank by a score where
 * bigger is better and the outer query is one shared `ORDER BY ... DESC`.
 */
function transcriptVectorCandidatesSql(vector: string, userId: string): Prisma.Sql {
  return Prisma.sql`
    SELECT
      'transcript'::text AS type,
      t.id::text AS id,
      t.title AS title,
      t.status::text AS status,
      t.updated_at AS updated_at,
      max(1 - (e.embedding <=> ${vector}::vector))::double precision AS score
    FROM search_embeddings e
    JOIN search_chunks c ON c.id = e.chunk_id
    JOIN transcripts t ON t.id = c.document_id
    WHERE c.document_type = 'transcript'
      AND ${transcriptVisibleSql('t', userId)}
    GROUP BY t.id, t.title, t.status, t.updated_at
    HAVING max(1 - (e.embedding <=> ${vector}::vector)) >= ${MIN_SEMANTIC_SIMILARITY}
  `;
}

/**
 * Note candidates by meaning.
 *
 * Owner-scoped only, with NO share join - see {@link noteVisibleSql}. A
 * semantic arm that joined `transcript_shares` here "because the transcript arm
 * does" would be this application's first path to reading somebody else's note,
 * built by a query that does not even mention notes' own access service.
 */
function noteVectorCandidatesSql(vector: string, userId: string): Prisma.Sql {
  return Prisma.sql`
    SELECT
      'note'::text AS type,
      n.id::text AS id,
      n.title AS title,
      n.status::text AS status,
      n.updated_at AS updated_at,
      max(1 - (e.embedding <=> ${vector}::vector))::double precision AS score
    FROM search_embeddings e
    JOIN search_chunks c ON c.id = e.chunk_id
    JOIN notes n ON n.id = c.document_id
    WHERE c.document_type = 'note'
      AND ${noteVisibleSql('n', userId)}
    GROUP BY n.id, n.title, n.status, n.updated_at
    HAVING max(1 - (e.embedding <=> ${vector}::vector)) >= ${MIN_SEMANTIC_SIMILARITY}
  `;
}

/**
 * Is there an embedded chunk THIS CALLER COULD MATCH, of a type they searched?
 *
 * ⚠ CALLER-SCOPED, NOT DEPLOYMENT-WIDE, and the difference is the whole value
 * of the reason it produces. A deployment-wide "has anybody indexed anything"
 * probe is cheaper and is wrong in the case that matters most: a brand-new user
 * on a busy installation would be told the semantic arm was available, would
 * have their own key charged for a query vector, and would get an empty vector
 * list back - every time - because none of the corpus is theirs. Scoped this
 * way, `no_indexed_content` means what a reader takes it to mean: NOTHING YOU
 * CAN SEARCH BY MEANING HAS BEEN INDEXED YET.
 *
 * It reuses the same visibility predicates the vector arm does, deliberately -
 * a probe that said "yes" about rows the arm would then filter out would be a
 * probe about a different question. `LIMIT 1` inside each arm plus `EXISTS`
 * around the union means Postgres stops at the first hit rather than counting.
 */
function anyVisibleEmbeddingsSql(userId: string, types: readonly SearchType[]): Prisma.Sql {
  const arms: Prisma.Sql[] = [];

  // ⚠ EACH ARM IS PARENTHESISED. A bare `... LIMIT 1 UNION ALL SELECT ...` is a
  // SYNTAX ERROR in Postgres - the `LIMIT` binds to the whole union, not to the
  // branch - so the parentheses are what make the per-arm `LIMIT` mean "stop at
  // the first row of THIS arm" rather than failing outright.
  if (types.includes('transcript')) {
    arms.push(Prisma.sql`
      (SELECT 1
       FROM search_embeddings e
       JOIN search_chunks c ON c.id = e.chunk_id
       JOIN transcripts t ON t.id = c.document_id
       WHERE c.document_type = 'transcript'
         AND ${transcriptVisibleSql('t', userId)}
       LIMIT 1)
    `);
  }

  if (types.includes('note')) {
    arms.push(Prisma.sql`
      (SELECT 1
       FROM search_embeddings e
       JOIN search_chunks c ON c.id = e.chunk_id
       JOIN notes n ON n.id = c.document_id
       WHERE c.document_type = 'note'
         AND ${noteVisibleSql('n', userId)}
       LIMIT 1)
    `);
  }

  return Prisma.sql`
    SELECT EXISTS (${Prisma.join(arms, ' UNION ALL ')}) AS present
  `;
}

/**
 * How many of this caller's OWN transcripts are not in the semantic index.
 *
 * "Not indexed" is "no `search_index_state` row, or one whose status is not
 * `indexed`" - one `NOT EXISTS` expresses both, and the `pending`/`indexing`/
 * `failed`/`skipped` distinction is deliberately NOT published here: the number
 * exists to answer "why did my search not find that recording", and every
 * non-`indexed` status has the same answer.
 */
function transcriptUnindexedSql(userId: string): Prisma.Sql {
  return Prisma.sql`
    SELECT count(*)::int AS n
    FROM transcripts t
    WHERE t.deleted_at IS NULL
      AND t.owner_id = ${userId}::uuid
      AND NOT EXISTS (
        SELECT 1 FROM search_index_state s
        WHERE s.document_type = 'transcript'
          AND s.document_id = t.id
          AND s.status = 'indexed'::"SearchIndexStatus"
      )
  `;
}

/** How many of this caller's own notes are not in the semantic index. */
function noteUnindexedSql(userId: string): Prisma.Sql {
  return Prisma.sql`
    SELECT count(*)::int AS n
    FROM notes n
    WHERE n.deleted_at IS NULL
      AND n.owner_id = ${userId}::uuid
      AND NOT EXISTS (
        SELECT 1 FROM search_index_state s
        WHERE s.document_type = 'note'
          AND s.document_id = n.id
          AND s.status = 'indexed'::"SearchIndexStatus"
      )
  `;
}

/** Degraded (`ILIKE`) transcript candidates. See {@link SearchService.search}. */
function transcriptTitleLikeSql(pattern: string, userId: string): Prisma.Sql {
  return Prisma.sql`
    SELECT
      'transcript'::text AS type,
      t.id::text AS id,
      t.title AS title,
      t.status::text AS status,
      t.updated_at AS updated_at,
      0::double precision AS score
    FROM transcripts t
    WHERE t.title ILIKE ${pattern}
      AND ${transcriptVisibleSql('t', userId)}
  `;
}

/** Degraded (`ILIKE`) note candidates. */
function noteTitleLikeSql(pattern: string, userId: string): Prisma.Sql {
  return Prisma.sql`
    SELECT
      'note'::text AS type,
      n.id::text AS id,
      n.title AS title,
      n.status::text AS status,
      n.updated_at AS updated_at,
      0::double precision AS score
    FROM notes n
    WHERE n.title ILIKE ${pattern}
      AND ${noteVisibleSql('n', userId)}
  `;
}

/** One candidate document, as the database returns it. */
interface CandidateRow {
  type: SearchType;
  id: string;
  title: string;
  status: string;
  updated_at: Date;
  score: number;
}

/** One rendered snippet, still carrying its `ts_headline` sentinels. */
interface SnippetRow {
  type: SearchType;
  doc_id: string;
  field: 'title' | 'body' | 'segment';
  start_ms: number | null;
  raw: string;
}

@Injectable()
export class SearchService {
  private readonly logger = new Logger(SearchService.name);

  constructor(
    private readonly prisma: PrismaService,
    // ⚠ THE ONLY NON-PRISMA DEPENDENCY THIS SERVICE HAS, and it is a LEAF that
    // never throws (see its header). Everything it can fail at is a reason
    // string, so nothing it does can turn a search into an error.
    private readonly embedder: SearchQueryEmbedder,
  ) {}

  /**
   * `GET /api/search`.
   *
   * The whole request, in at most six `SELECT`s: the embeddings-present probe,
   * the stopword probe, the two candidate windows, the page's snippets and the
   * unindexed count.
   */
  async search(
    query: SearchQueryDto,
    user: RequestUser | AuthenticatedUser,
  ): Promise<SearchResponse> {
    const permissions = callerPermissions(user);
    const requested = parseTypesParam(query.types);

    if (requested === null) {
      throw new BadRequestException(
        `\`types\` must be a comma-separated list of: ${SEARCH_TYPES.join(', ')}.`,
      );
    }

    const searchedTypes = narrowToPermitted(requested, permissions);

    if (searchedTypes.length === 0) {
      // The ONE 403 this endpoint issues, and it is not the partial-answer
      // case - see `search.controller.ts`. A caller who holds NEITHER read
      // permission is asking a question this endpoint has no surface to answer
      // at all, which is different from asking for two types and being
      // entitled to one.
      throw new ForbiddenException(
        `Searching requires at least one of: ${PERMISSIONS.TRANSCRIPTS_READ}, ` +
          `${PERMISSIONS.NOTES_READ}.`,
      );
    }

    const q = normalizeQueryText(query.q);

    // -----------------------------------------------------------------------
    // The semantic arm is planned FIRST - before the cursor is even decoded
    // -----------------------------------------------------------------------
    //
    // ⚠ THIS ORDERING IS DELIBERATE AND IT COSTS SOMETHING. The plan includes
    // actually calling the provider, so a request presenting a stale cursor
    // spends one embedding call on the caller's own key before being refused
    // with a 400. That is the price of the alternative being wrong: the cursor
    // fingerprint carries whether the vector arm RAN (see `search-cursor.ts`),
    // and "ran" is not knowable until the vendor has answered. Fingerprinting
    // the INTENTION instead - "this caller has a key, so semantic was
    // available" - would accept a page-2 cursor minted while the provider was
    // healthy against a page 2 computed after it started failing, which is
    // precisely the silent renumbering the whole cursor design exists to
    // prevent. A stale cursor is already an error path; paying one vendor call
    // on it is the cheap side of this trade.
    const plan = await this.planSemantic(q, user.id, searchedTypes);

    const scope: SearchCursorScope = {
      q,
      types: searchedTypes,
      userId: user.id,
      semantic: semanticAxis(plan),
    };
    const offset = this.resolveOffset(query.cursor, scope);

    // -----------------------------------------------------------------------
    // The stopword probe, and why Postgres answers it rather than TypeScript
    // -----------------------------------------------------------------------
    //
    // `plainto_tsquery('english', 'the and of')` is the EMPTY tsquery, which
    // matches no row anywhere. Left alone, the most ordinary-looking search a
    // person can type answers "no results" for a corpus full of documents
    // containing exactly those words. `numnode()` counts what the parser
    // actually produced, so zero is "there was nothing left to search for" -
    // asked of the same dictionary the indexed vectors were built with, which
    // is the only source that cannot drift from them.
    const [probe] = await this.prisma.$queryRaw<Array<{ nodes: number }>>(Prisma.sql`
      SELECT numnode(${tsQuery(q)})::int AS nodes
    `);

    const degraded = isStopwordOnly(probe?.nodes) ? ('stopwords' as const) : null;

    // ⚠ THE VECTOR ARM RUNS ON THE DEGRADED PATH TOO, and that is not an
    // oversight. `degraded: 'stopwords'` is a statement about the LEXICAL arm
    // and nothing else: `plainto_tsquery` produced an empty query, so there is
    // no full-text ranking to be had and the title-substring fallback stands in
    // for it. The vector arm never consults `plainto_tsquery` at all - it
    // compares an embedding of the raw text - so there is no reason for
    // `numnode()` to gate it, and an all-stopword query is exactly where a
    // second, independent signal is most worth having. It also avoids inventing
    // a sixth `semanticReason` for a case where the semantic arm is perfectly
    // healthy.
    //
    // Both arms are issued together: they share no state, and somebody is
    // waiting. The lexical one is issued first so that the statement order this
    // service emits stays stable for the tests that read it positionally.
    const [lexical, vector] = await Promise.all([
      degraded
        ? this.degradedCandidates(q, user.id, searchedTypes)
        : this.rankedCandidates(q, user.id, searchedTypes),
      plan.ok
        ? this.vectorCandidates(vectorLiteral(plan.vector), user.id, searchedTypes)
        : Promise.resolve<CandidateRow[]>([]),
    ]);

    const { window, truncated } = fuseCandidates(lexical, vector);
    const matchedDocuments = window.length;

    const page = window.slice(offset, offset + query.limit);

    // The unindexed count is computed on EVERY request, including one where the
    // semantic arm ran perfectly. It is not a diagnostic for the failure cases:
    // "my search did not find that recording" is asked most often when search
    // is otherwise working, and the answer - "nine of your documents are not in
    // the semantic index yet" - is only available here.
    const [snippets, unindexedCount] = await Promise.all([
      degraded
        ? Promise.resolve(degradedSnippets(page, q))
        : this.rankedSnippets(q, user.id, page),
      this.countUnindexed(user.id, searchedTypes),
    ]);

    const nextOffset = offset + query.limit;

    return {
      results: page.map((row) => ({
        type: row.type,
        id: row.id,
        title: row.title,
        score: Number(row.score),
        updatedAt: row.updated_at.toISOString(),
        status: row.status,
        snippets: snippets.get(snippetKey(row.type, row.id)) ?? [],
      })),
      matchedDocuments,
      truncated,
      nextCursor:
        page.length > 0 && nextOffset < matchedDocuments
          ? encodeSearchCursor(scope, nextOffset)
          : null,
      degraded,
      searchedTypes,
      semantic: plan.ok,
      semanticReason: plan.ok ? null : plan.reason,
      unindexedCount,
    };
  }

  /**
   * Whether the vector arm can run for this caller, and if so the query vector.
   *
   * The evaluation order is the one `search-semantic.ts` lists, and it is
   * cheapest-first ON PURPOSE: three checks that touch neither the database nor
   * the vendor, then one `EXISTS` against `search_embeddings`, and only then a
   * request that spends the caller's own money. Embedding a query for a
   * deployment that has indexed nothing would be a bill for a comparison
   * against an empty table.
   *
   * ⚠ NEVER THROWS. Every branch returns a reason; see the embedder's header.
   */
  private async planSemantic(
    q: string,
    userId: string,
    types: readonly SearchType[],
  ): Promise<SemanticQueryPlan> {
    const resolution = await this.embedder.resolve(userId);

    if (!resolution.ok) return resolution;

    const [row] = await this.prisma.$queryRaw<Array<{ present: boolean }>>(
      anyVisibleEmbeddingsSql(userId, types),
    );

    if (!row?.present) return { ok: false, reason: 'no_indexed_content' };

    return resolution.embed(q);
  }

  /**
   * The cursor's offset, or zero when there is no cursor.
   *
   * A {@link SearchCursorError} becomes a **400**, never a silent restart -
   * the whole argument is in `search-cursor.ts`'s header. It is logged at
   * `debug` rather than `warn`: a refused cursor is a client holding a stale
   * one, which is an ordinary event this endpoint is designed to produce, not
   * an incident.
   */
  private resolveOffset(cursor: string | undefined, scope: SearchCursorScope): number {
    if (!cursor) return 0;

    try {
      return decodeSearchCursor(cursor, scope);
    } catch (error) {
      if (error instanceof SearchCursorError) {
        this.logger.debug(`Refused a search cursor for user ${scope.userId}: ${error.message}`);

        throw new BadRequestException(error.message);
      }

      throw error;
    }
  }

  /** The bounded candidate window, full-text path. */
  private rankedCandidates(
    q: string,
    userId: string,
    types: readonly SearchType[],
  ): Promise<CandidateRow[]> {
    const arms: Prisma.Sql[] = [];

    if (types.includes('transcript')) arms.push(transcriptCandidatesSql(q, userId));
    if (types.includes('note')) arms.push(noteCandidatesSql(q, userId));

    return this.prisma.$queryRaw<CandidateRow[]>(Prisma.sql`
      SELECT d.type, d.id, d.title, d.status, d.updated_at, d.score
      FROM (${Prisma.join(arms, ' UNION ALL ')}) d
      ORDER BY d.score DESC, d.updated_at DESC, d.id ASC
      LIMIT ${MAX_CANDIDATE_DOCUMENTS + 1}
    `);
  }

  /**
   * The bounded candidate window, SEMANTIC path (#189).
   *
   * Structurally identical to {@link SearchService.rankedCandidates} - per-type
   * arms, `UNION ALL`, one shared `ORDER BY ... LIMIT` - which is the point:
   * the outer `LIMIT` is applied to rows that have already passed each arm's
   * own visibility predicate, in both arms, exactly as the lexical path does.
   * Its ordering is what assigns this list's ranks; `fuseCandidates` reads
   * positions and nothing else.
   */
  private vectorCandidates(
    vector: string,
    userId: string,
    types: readonly SearchType[],
  ): Promise<CandidateRow[]> {
    const arms: Prisma.Sql[] = [];

    if (types.includes('transcript')) arms.push(transcriptVectorCandidatesSql(vector, userId));
    if (types.includes('note')) arms.push(noteVectorCandidatesSql(vector, userId));

    return this.prisma.$queryRaw<CandidateRow[]>(Prisma.sql`
      SELECT d.type, d.id, d.title, d.status, d.updated_at, d.score
      FROM (${Prisma.join(arms, ' UNION ALL ')}) d
      ORDER BY d.score DESC, d.updated_at DESC, d.id ASC
      LIMIT ${MAX_CANDIDATE_DOCUMENTS + 1}
    `);
  }

  /**
   * `unindexedCount` - the caller's OWN documents missing from the semantic
   * index, over the types actually searched.
   *
   * Scoped to `searchedTypes` rather than to everything the caller owns, so the
   * number agrees with the answer beside it: a caller who searched only their
   * notes is told how many NOTES are unindexed, not a total that includes
   * recordings this response never looked at.
   */
  private async countUnindexed(userId: string, types: readonly SearchType[]): Promise<number> {
    const arms: Prisma.Sql[] = [];

    if (types.includes('transcript')) arms.push(transcriptUnindexedSql(userId));
    if (types.includes('note')) arms.push(noteUnindexedSql(userId));

    const [row] = await this.prisma.$queryRaw<Array<{ n: number | null }>>(Prisma.sql`
      SELECT coalesce(sum(x.n), 0)::int AS n
      FROM (${Prisma.join(arms, ' UNION ALL ')}) x
    `);

    return Number(row?.n ?? 0);
  }

  /**
   * The bounded candidate window, degraded path.
   *
   * ⚠ THIS IS DELIBERATELY THE SAME BEHAVIOUR `GET /api/transcripts?q=` AND
   * `GET /api/notes?q=` ALREADY HAVE - a case-insensitive title substring,
   * newest first. Neither of those endpoints changes; this one falls back TO
   * them so that an all-stopword query answers with the rows a user would
   * recognise instead of an empty list. `degraded: 'stopwords'` in the
   * response is what lets a client say which of the two happened, rather than
   * presenting title matches as if the full-text index had chosen them.
   *
   * There is no score to rank by (there is no tsquery), so the ordering is
   * `updatedAt` descending - the same ordering the list endpoints use, because
   * it is the same answer.
   */
  private degradedCandidates(
    q: string,
    userId: string,
    types: readonly SearchType[],
  ): Promise<CandidateRow[]> {
    const pattern = titleLikePattern(q);
    const arms: Prisma.Sql[] = [];

    if (types.includes('transcript')) arms.push(transcriptTitleLikeSql(pattern, userId));
    if (types.includes('note')) arms.push(noteTitleLikeSql(pattern, userId));

    return this.prisma.$queryRaw<CandidateRow[]>(Prisma.sql`
      SELECT d.type, d.id, d.title, d.status, d.updated_at, d.score
      FROM (${Prisma.join(arms, ' UNION ALL ')}) d
      ORDER BY d.updated_at DESC, d.id ASC
      LIMIT ${MAX_CANDIDATE_DOCUMENTS + 1}
    `);
  }

  /**
   * `ts_headline` for one page's documents, at most
   * {@link MAX_SNIPPETS_PER_RESULT} per document.
   *
   * ⚠ THE VISIBILITY PREDICATE IS REPEATED HERE. The ids came from a window
   * that was already filtered, so this is redundant TODAY - and it costs an
   * index lookup per row to keep it that way tomorrow, when somebody adds a
   * "fetch snippets for these ids" path that takes its ids from somewhere
   * else. A snippet is the document's text; a snippet query that trusted its
   * ids would be a text-disclosure endpoint one refactor away.
   *
   * The segment arm picks each transcript's best few segments BEFORE
   * headlining them (the inner `row_number()`), because `ts_headline` re-scans
   * the source text per row and a long recording can have hundreds of matching
   * segments. Ranking is cheap and comes off the vector; headlining is not.
   */
  private async rankedSnippets(
    q: string,
    userId: string,
    page: readonly CandidateRow[],
  ): Promise<Map<string, Array<{ html: string; startMs: number | null; field: SnippetRow['field'] }>>> {
    const transcriptIds = page.filter((row) => row.type === 'transcript').map((row) => row.id);
    const noteIds = page.filter((row) => row.type === 'note').map((row) => row.id);

    const arms: Prisma.Sql[] = [];

    if (transcriptIds.length > 0) {
      arms.push(Prisma.sql`
        SELECT
          'transcript'::text AS type,
          t.id::text AS doc_id,
          'title'::text AS field,
          NULL::int AS start_ms,
          ts_headline('english'::regconfig, t.title, ${tsQuery(q)}, ${HEADLINE_OPTIONS}) AS raw,
          ts_rank_cd(t.title_search_vector, ${tsQuery(q)})::double precision AS score,
          0::int AS field_rank
        FROM transcripts t
        WHERE t.id = ANY(${transcriptIds}::uuid[])
          AND t.title_search_vector @@ ${tsQuery(q)}
          AND ${transcriptVisibleSql('t', userId)}
      `);

      arms.push(Prisma.sql`
        SELECT
          'transcript'::text AS type,
          best.transcript_id::text AS doc_id,
          'segment'::text AS field,
          best.start_ms AS start_ms,
          ts_headline('english'::regconfig, best.text, ${tsQuery(q)}, ${HEADLINE_OPTIONS}) AS raw,
          best.score AS score,
          1::int AS field_rank
        FROM (
          SELECT
            s.transcript_id,
            s.start_ms,
            s.text,
            ts_rank_cd(s.search_vector, ${tsQuery(q)})::double precision AS score,
            row_number() OVER (
              PARTITION BY s.transcript_id
              ORDER BY ts_rank_cd(s.search_vector, ${tsQuery(q)}) DESC, s.start_ms ASC
            ) AS srn
          FROM transcript_segments s
          JOIN transcripts st ON st.id = s.transcript_id
          WHERE s.transcript_id = ANY(${transcriptIds}::uuid[])
            AND s.search_vector @@ ${tsQuery(q)}
            AND ${transcriptVisibleSql('st', userId)}
        ) best
        WHERE best.srn <= ${MAX_SNIPPETS_PER_RESULT}
      `);
    }

    if (noteIds.length > 0) {
      // A note's stored vector is title||body, so it cannot say WHICH half
      // matched. The two arms below re-derive each half's own vector for that
      // one purpose - and re-apply `setweight` so the scores they produce are
      // on the same A/B scale the stored column uses, which is what makes a
      // title hit sort above a body hit here exactly as it does in the ranking.
      arms.push(Prisma.sql`
        SELECT
          'note'::text AS type,
          n.id::text AS doc_id,
          'title'::text AS field,
          NULL::int AS start_ms,
          ts_headline('english'::regconfig, n.title, ${tsQuery(q)}, ${HEADLINE_OPTIONS}) AS raw,
          ts_rank_cd(
            setweight(to_tsvector('english'::regconfig, coalesce(n.title, '')), 'A'),
            ${tsQuery(q)}
          )::double precision AS score,
          0::int AS field_rank
        FROM notes n
        WHERE n.id = ANY(${noteIds}::uuid[])
          AND to_tsvector('english'::regconfig, coalesce(n.title, '')) @@ ${tsQuery(q)}
          AND ${noteVisibleSql('n', userId)}
      `);

      arms.push(Prisma.sql`
        SELECT
          'note'::text AS type,
          n.id::text AS doc_id,
          'body'::text AS field,
          NULL::int AS start_ms,
          ts_headline('english'::regconfig, n.body, ${tsQuery(q)}, ${HEADLINE_OPTIONS}) AS raw,
          ts_rank_cd(
            setweight(to_tsvector('english'::regconfig, coalesce(n.body, '')), 'B'),
            ${tsQuery(q)}
          )::double precision AS score,
          1::int AS field_rank
        FROM notes n
        WHERE n.id = ANY(${noteIds}::uuid[])
          AND to_tsvector('english'::regconfig, coalesce(n.body, '')) @@ ${tsQuery(q)}
          AND ${noteVisibleSql('n', userId)}
      `);
    }

    if (arms.length === 0) return new Map();

    const rows = await this.prisma.$queryRaw<SnippetRow[]>(Prisma.sql`
      SELECT y.type, y.doc_id, y.field, y.start_ms, y.raw
      FROM (
        SELECT
          x.type, x.doc_id, x.field, x.start_ms, x.raw,
          row_number() OVER (
            PARTITION BY x.type, x.doc_id
            ORDER BY x.score DESC, x.field_rank ASC, x.start_ms ASC NULLS FIRST
          ) AS rn
        FROM (${Prisma.join(arms, ' UNION ALL ')}) x
      ) y
      WHERE y.rn <= ${MAX_SNIPPETS_PER_RESULT}
      ORDER BY y.type, y.doc_id, y.rn
    `);

    const byDocument = new Map<
      string,
      Array<{ html: string; startMs: number | null; field: SnippetRow['field'] }>
    >();

    for (const row of rows) {
      const key = snippetKey(row.type, row.doc_id);
      const list = byDocument.get(key) ?? [];

      list.push({
        // ESCAPED HERE, MARKED HERE, AND NOWHERE ELSE. `ts_headline` marked
        // the hits with control characters precisely so this one call can
        // escape the corpus text first and introduce the only markup in the
        // string second. See `search-snippet.ts`.
        html: renderHeadlineHtml(row.raw),
        startMs: row.start_ms === null ? null : Number(row.start_ms),
        field: row.field,
      });

      byDocument.set(key, list);
    }

    return byDocument;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** `type:id`, so one map can hold both kinds without their ids colliding. */
function snippetKey(type: SearchType, id: string): string {
  return `${type}:${id}`;
}

/**
 * Fuse the two arms' rankings into the candidate window (#189).
 *
 * Each list arrives ALREADY ORDERED by its own database query, so a document's
 * rank is simply its position - which is what keeps {@link
 * reciprocalRankFusion} pure and ignorant of `ts_rank_cd` and cosine distance
 * alike. Both lists are cut to the cap BEFORE ranking, so the one extra row
 * each query fetches serves only as a "there was more" sentinel and never earns
 * a rank of its own.
 *
 * ⚠ WITH ONLY THE LEXICAL LIST THIS IS THE IDENTITY ON ORDER. RRF over a single
 * list is `1 / (60 + rank)`, which is strictly decreasing in rank, so sorting
 * by it reproduces the SQL's ordering exactly - which is what makes
 * "`semantic: false` answers precisely as the endpoint did before epic #165"
 * true by construction rather than by two code paths kept in step. Only the
 * `score` NUMBER differs from the pre-#189 response; the ids and their order do
 * not.
 *
 * The tie-break is the SQL's own (`updated_at DESC, id ASC`), for the case only
 * fusion can produce: two documents that rank differently in the two arms and
 * land on the same total.
 *
 * `truncated` is true when EITHER arm filled its window or when the union
 * overflows the cap - all three mean the same thing to a reader
 * (`matchedDocuments` is a floor), and reporting only the union's overflow
 * would call a 250-match lexical search "exact" whenever the two arms happened
 * to agree about which 200 documents mattered.
 */
function fuseCandidates(
  lexical: readonly CandidateRow[],
  vector: readonly CandidateRow[],
): { window: CandidateRow[]; truncated: boolean } {
  const lexicalPage = lexical.slice(0, MAX_CANDIDATE_DOCUMENTS);
  const vectorPage = vector.slice(0, MAX_CANDIDATE_DOCUMENTS);

  // One row per document, whichever arm saw it first. Both arms select the same
  // columns from the same parent tables, so "first" is a choice between two
  // identical rows - except for `score`, which is overwritten below anyway.
  const rows = new Map<string, CandidateRow>();

  for (const row of [...lexicalPage, ...vectorPage]) {
    const key = snippetKey(row.type, row.id);

    if (!rows.has(key)) rows.set(key, row);
  }

  const scores = reciprocalRankFusion(
    [lexicalPage, vectorPage]
      .filter((list) => list.length > 0)
      .map((list) => list.map((row) => snippetKey(row.type, row.id))),
  );

  const fused = [...rows.entries()].map(([key, row]) => ({
    ...row,
    score: scores.get(key) ?? 0,
  }));

  fused.sort(
    (a, b) =>
      b.score - a.score ||
      b.updated_at.getTime() - a.updated_at.getTime() ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );

  return {
    window: fused.slice(0, MAX_CANDIDATE_DOCUMENTS),
    truncated:
      lexical.length > MAX_CANDIDATE_DOCUMENTS ||
      vector.length > MAX_CANDIDATE_DOCUMENTS ||
      fused.length > MAX_CANDIDATE_DOCUMENTS,
  };
}

/**
 * The caller's permission strings, whichever shape the request carried.
 *
 * ⚠ THIS IS NOT A NEW MECHANISM - IT IS THE EXISTING ONE, CALLED DIRECTLY,
 * AND THE REASON IT HAS TO BE IS WORTH READING ONCE.
 *
 * `PermissionsGuard` and `RolesGuard` attach `request.requestUser` (the
 * flattened {@link RequestUser}, with its `permissions` array) ONLY when the
 * route declares a role or a permission; otherwise `@CurrentUser()` falls
 * through to `request.user`, which is the raw {@link AuthenticatedUser} the
 * JWT strategy returned and which carries `userRoles`, not `permissions`.
 *
 * This route declares neither, and that is deliberate: `PermissionsGuard`
 * requires ALL declared permissions, and this endpoint's requirement is
 * "EITHER `transcripts:read` OR `notes:read`" (see
 * `search.controller.ts`). Declaring both would 403 exactly the caller the
 * partial-answer rule exists to serve. So the OR is enforced in
 * {@link SearchService.search}, and the permission list is flattened with
 * `toRequestUser` - the same exported function both guards use, so there is
 * still only one definition of "what permissions does this user hold".
 */
function callerPermissions(user: RequestUser | AuthenticatedUser): readonly string[] {
  const asRequestUser = user as RequestUser;

  if (Array.isArray(asRequestUser.permissions)) return asRequestUser.permissions;

  const asAuthenticated = user as AuthenticatedUser;

  if (Array.isArray(asAuthenticated.userRoles)) return toRequestUser(asAuthenticated).permissions;

  return [];
}

/**
 * The requested types, narrowed to the ones this caller may read.
 *
 * Narrowing rather than refusing is the whole point - see
 * `search.controller.ts` for why a partial answer beats a 403 here.
 */
function narrowToPermitted(
  requested: readonly SearchType[],
  permissions: readonly string[],
): SearchType[] {
  return requested.filter((type) => permissions.includes(TYPE_PERMISSIONS[type]));
}

/**
 * Snippets for the degraded path: the matched title, marked in TypeScript.
 *
 * There is no tsquery on this path, so there is nothing for `ts_headline` to
 * highlight and no second query to issue - the candidate rows already carry
 * the titles, and the match is a literal substring of one. Every title still
 * goes through the same escaping rules; see `markLiteral`.
 */
function degradedSnippets(
  page: readonly CandidateRow[],
  q: string,
): Map<string, Array<{ html: string; startMs: number | null; field: SnippetRow['field'] }>> {
  const byDocument = new Map<
    string,
    Array<{ html: string; startMs: number | null; field: SnippetRow['field'] }>
  >();

  for (const row of page) {
    byDocument.set(snippetKey(row.type, row.id), [
      { html: markLiteral(row.title, q), startMs: null, field: 'title' },
    ]);
  }

  return byDocument;
}
