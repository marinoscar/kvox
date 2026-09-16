// =============================================================================
// `GET /api/search/index-status` and `POST /api/search/index` (issue #191,
// epic #165) — the shapes behind the one place a user can see, and change,
// what of their own library is semantically searchable
// =============================================================================
//
// ZOD, NOT class-validator, matching `user-data/dto/*`, `notes/dto/*` and
// `transcripts/dto/*`: the global `ZodValidationPipe` is what actually runs, so
// a `class-validator` decorator on a body it never inspects is a validation
// that LOOKS present in the source and is inert at runtime.
//
// -----------------------------------------------------------------------------
// EVERY COUNT IS OWNER-SCOPED, AND THAT IS A BILLING STATEMENT
// -----------------------------------------------------------------------------
//
// These numbers cover the documents the caller OWNS — not the transcripts
// somebody shared with them. A share lets you read another person's recording;
// it does not make their indexing bill yours. Indexing spends the DOCUMENT
// OWNER'S own vendor key (`search-index.handler.ts` step 2 resolves the owner's
// credential, never the caller's), so a page that counted shares would be
// offering a button whose cost lands on somebody else's account — and whose
// work this endpoint could not queue anyway, because the handler would resolve
// the other user's key and index it on their behalf whether or not this caller
// pressed anything.
//
// -----------------------------------------------------------------------------
// `unindexed` IS NOT A `SearchIndexStatus`, AND IT IS THE IMPORTANT ONE
// -----------------------------------------------------------------------------
//
// The enum has five members (`pending`, `indexing`, `indexed`, `failed`,
// `skipped`) and every one of them requires a `search_index_state` row to
// exist. The state a user most needs to see has NO ROW AT ALL: a document that
// predates this epic, or one whose owner has never had a key, was never
// enqueued and therefore never wrote a row. Reporting only the five would show
// a library of four hundred recordings as "0 indexed, 0 pending, 0 failed" —
// three zeroes that look like a healthy empty state and are in fact the whole
// degradation. So `unindexed` is derived (`total` minus the rows) and is what
// the "Index my library" button acts on.
//
// `indexing` is folded into `pending` on the wire. The distinction is real in
// the database (claimed versus queued) and is not a distinction a person
// staring at their own library can act on — both mean "not done yet", and
// splitting them would put two progress numbers on a page whose question is
// "is it finished".
// =============================================================================

import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { SEARCH_DOCUMENT_TYPES } from '../job-types';

/**
 * The per-call ceiling on how many documents one press of "Index my library"
 * may queue.
 *
 * ⚠ TWO HUNDRED, AND THE NUMBER IS ARGUED RATHER THAN PICKED.
 *
 * The requirement is a bound, not a particular bound: a user with ten thousand
 * documents must not get ten thousand `search.index` rows from one button
 * press. Three things decide where between 1 and 10,000 it lands.
 *
 *   1. IT SHOULD FINISH THE JOB FOR ALMOST EVERYBODY. A cap low enough to make
 *      an ordinary library take five presses turns an explicit action into a
 *      chore, and a user who stops pressing half way is left in exactly the
 *      half-indexed state this page exists to make visible. Two hundred
 *      recordings is a heavy user of an application whose unit of content is a
 *      meeting.
 *   2. THE BILL HAS TO STAY KNOWABLE. At `MAX_CHUNK_CHARS = 1600`, an
 *      hour-long recording is a few hundred chunks and on the order of ten
 *      thousand tokens of embedding input. Two hundred of them is a couple of
 *      million tokens — cents at current embedding prices, and, far more to the
 *      point, a figure of the same ORDER as what the user has just been shown
 *      on screen. Ten thousand documents is not.
 *   3. THE QUEUE IS SHARED. Every row queued here sits in the same `jobs` table
 *      an administrator reads (`/admin/settings/jobs`) and the same worker
 *      slots a transcription is competing for. `search.index` runs at
 *      priority 10 — deliberately behind anything a person is watching — so a
 *      large batch delays nobody, but ten thousand rows from one press would
 *      still bury every other row in the admin list.
 *
 * The cap is not a limit on how much a user may index: `remaining` says how
 * much is left and the button can be pressed again. It is a limit on how much
 * ONE PRESS can commit them to, which is the property that makes the action
 * safe to offer at all.
 */
export const SEARCH_INDEX_REQUEST_CAP = 200;

/**
 * How many per-document failures `GET /api/search/index-status` reports.
 *
 * Twenty, newest first. A failure list is a diagnostic aid, not an inventory:
 * the counts above it already say how many there are, and a page that streamed
 * four hundred identical rows would bury the one row that is different. A user
 * whose whole library failed has one cause, and it is in the first twenty.
 */
export const SEARCH_INDEX_FAILURE_LIMIT = 20;

/** `transcript` | `note` — the document kinds this build can index. */
export const searchIndexDocumentTypeSchema = z.enum(
  SEARCH_DOCUMENT_TYPES as unknown as [string, ...string[]],
);

// -----------------------------------------------------------------------------
// GET /api/search/index-status
// -----------------------------------------------------------------------------

export const searchIndexTypeCountsSchema = z.object({
  type: searchIndexDocumentTypeSchema.describe('Which kind of document these counts describe.'),
  indexed: z
    .number()
    .int()
    .describe('Documents that are semantically searchable right now.'),
  pending: z
    .number()
    .int()
    .describe(
      'Documents queued for indexing or being indexed at this moment. The two database states ' +
        '(`pending`, `indexing`) are reported as one: both mean "not done yet".',
    ),
  failed: z
    .number()
    .int()
    .describe('Documents whose last indexing attempt ended in an error. See `failures`.'),
  skipped: z
    .number()
    .int()
    .describe(
      'Documents indexing deliberately declined to embed — most often because no API key was ' +
        'saved when the attempt ran. A skip is a fact about the account or the deployment, ' +
        'not a fault in the document, and it clears the moment the cause does.',
    ),
  unindexed: z
    .number()
    .int()
    .describe(
      'Documents with **no indexing record at all** — never queued, so never skipped and never ' +
        'failed. This is the ordinary state of everything that predates semantic search, and ' +
        'it is what "Index my library" acts on.',
    ),
  total: z.number().int().describe('Every document of this kind you own, deleted ones excluded.'),
});

export class SearchIndexTypeCountsDto extends createZodDto(searchIndexTypeCountsSchema) {}

export const searchIndexFailureSchema = z.object({
  type: searchIndexDocumentTypeSchema,
  id: z.string().describe('The document id, so a client can link to it.'),
  title: z.string().describe("The document's title as it is shown in the library."),
  reason: z
    .string()
    .nullable()
    .describe(
      'A short diagnostic token — `ai_key_invalid`, `dimension_mismatch`, … — **not an enum**: ' +
        'the column is plain text and grows new values as new failure modes are found, so a ' +
        'client must render an unrecognised value as itself rather than dropping the row.',
    ),
  lastError: z
    .string()
    .nullable()
    .describe("The provider's or the job's own error text, when there was one."),
});

export class SearchIndexFailureDto extends createZodDto(searchIndexFailureSchema) {}

export const searchIndexStatusSchema = z.object({
  types: z
    .array(searchIndexTypeCountsSchema)
    .describe('One entry per indexable document kind, always present even when the count is zero.'),
  model: z
    .string()
    .nullable()
    .describe(
      "The embedding model this deployment's active provider would use. `null` when there is " +
        'no provider, or the provider offers no embeddings.',
    ),
  hasKey: z
    .boolean()
    .describe(
      '⚠ Whether **you** have saved an API key for the active provider — per-caller, never ' +
        'per-deployment. This application holds no key of its own; indexing your documents ' +
        'authenticates as you and is billed to your account.',
    ),
  available: z
    .boolean()
    .describe(
      'Whether this deployment can embed anything at all: AI is switched on, a provider is ' +
        'chosen, this build implements it, and that provider declares an embedding capability. ' +
        'Independent of `hasKey` — the two have different fixes and different people to talk to.',
    ),
  reason: z
    .string()
    .nullable()
    .describe(
      'Why indexing is unavailable, when it is: `ai_not_configured` (no provider chosen, or AI ' +
        'is off), `embedding_unsupported` (the chosen provider does not do embeddings), or ' +
        '`ai_key_missing` (the deployment is ready and you have saved no key). `null` when ' +
        'indexing can run.',
    ),
  failures: z
    .array(searchIndexFailureSchema)
    .describe(
      `Up to ${SEARCH_INDEX_FAILURE_LIMIT} documents whose indexing did not succeed, newest ` +
        'first. Deliberately **excludes** skips that are facts about your account or the ' +
        'deployment rather than about a document (`ai_key_missing`, `ai_not_configured`, ' +
        '`embedding_unsupported`) — those are already reported once, above, by `reason`, and ' +
        'listing them per document would turn one sentence into four hundred rows.',
    ),
});

export class SearchIndexStatusDto extends createZodDto(searchIndexStatusSchema) {}

// -----------------------------------------------------------------------------
// POST /api/search/index
// -----------------------------------------------------------------------------

export const searchIndexRequestResultSchema = z.object({
  queued: z
    .number()
    .int()
    .describe('How many `search.index` jobs this call actually enqueued.'),
  remaining: z
    .number()
    .int()
    .describe(
      'How many of your documents still need indexing after this call — `0` when the library ' +
        'is fully queued. Non-zero means the per-call cap was reached; press again.',
    ),
  cap: z
    .number()
    .int()
    .describe(
      'The per-call ceiling this deployment applies, so a client can say "200 of 900 queued" ' +
        'rather than leaving the shortfall unexplained.',
    ),
});

export class SearchIndexRequestResultDto extends createZodDto(searchIndexRequestResultSchema) {}

/** `GET /api/search/index-status`, as the service builds it. */
export type SearchIndexStatusResponse = z.infer<typeof searchIndexStatusSchema>;
/** `POST /api/search/index`, as the service builds it. */
export type SearchIndexRequestResult = z.infer<typeof searchIndexRequestResultSchema>;
