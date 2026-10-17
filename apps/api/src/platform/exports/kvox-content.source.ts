// =============================================================================
// The `kvox-content` export source (issue #532, epic #479)
// =============================================================================
//
// The part of "Download your data" the platform's `user-data` source cannot do. That
// source exports a model's rows from the user-owned registry alone: an owner-keyed model
// by its owner column, an ACTOR-ONLY model by its actor columns. Four datasets of this app are
// the user's content but have no owner column of their own, and exporting them by actor
// would be wrong both ways:
//
//   * `TranscriptSegment.editedById` / `NoteVersion.authorId` name who EDITED a row.
//     Filtered by them, the export would carry the segments the user merely corrected in
//     SOMEONE ELSE'S shared transcript (a privacy leak) and miss the segments of their own
//     transcript that a collaborator edited.
//   * `TranscriptSpeaker` and `AskMessage` have no user column at all.
//
// So these models are `exclude` in the registry (`app-registrations/user-owned-models.ts`)
// and exported HERE, each keyed by ownership of the PARENT row: the transcript's or the
// note's `ownerId`, the conversation's `ownerId`. `KgAttributeDef` is also exported here,
// not by the platform source, so a definition classed `sensitive` can be left out (a
// sensitive definition is never exported, as in the ontology and RDF artefacts).
//
// EVERY query names its owner through the relation (`where`); the bypass client lifts
// row-level security, so that filter is the boundary. Read-only, paged by `modelTable`.
// The default redaction rule (`isRedactedExportField`) applies to every column; none of
// these models holds a secret.
//
// Columns left out, each with its reason:
//   * `TranscriptSegment.words` / `wordsAlignment`: per-word timings, the largest thing in
//     the schema and derived from the text, which stays with its start and end.
//   * `AskMessage.toolCalls`: the agent's execution trace (arguments, summaries, timings).
//     The question, the answer and the citations stay.
//
// Registered by `exports.config.ts`, AFTER `ExportsModule.forRoot` (so the platform's
// `user-data` stays the first, default source in the dialog) and BEFORE the application is
// created (the registry freezes at bootstrap). Permission `user_settings:read`, the string
// `user-data` enforces: every role may export its own data.
// =============================================================================

import { z } from 'zod';
import {
  CSV_EXPORT_WRITER,
  JSON_EXPORT_WRITER,
  MODEL_TABLE_COLUMN_TYPES,
  XLSX_EXPORT_WRITER,
  modelTable,
  type ExportContext,
  type ExportSource,
  type ExportTable,
} from '@marinoscar/platform-api/exports';

/** The source id. PERMANENT once export jobs carry it. */
export const KVOX_CONTENT_EXPORT_SOURCE_ID = 'kvox-content';

/** The permission the route enforces: the one `user-data` uses, held by every role. */
export const KVOX_CONTENT_EXPORT_PERMISSION = 'user_settings:read';

/** One dataset of the source: a model, how its rows are tied to the user, and what is left out. */
export interface KvoxContentDataset {
  /** The Prisma model. */
  readonly model: string;
  /** The `where` of its rows: always an ownership condition on the user, reached through the parent. */
  readonly where: (userId: string) => Record<string, unknown>;
  /** Columns left out (see the file header). */
  readonly omit?: readonly string[];
}

/** The datasets, in export order. */
export const KVOX_CONTENT_DATASETS: readonly KvoxContentDataset[] = [
  { model: 'TranscriptSpeaker', where: (userId) => ({ transcript: { ownerId: userId } }) },
  {
    model: 'TranscriptSegment',
    where: (userId) => ({ transcript: { ownerId: userId } }),
    omit: ['words', 'wordsAlignment'],
  },
  { model: 'NoteVersion', where: (userId) => ({ note: { ownerId: userId } }) },
  {
    model: 'AskMessage',
    where: (userId) => ({ conversation: { ownerId: userId } }),
    omit: ['toolCalls'],
  },
  {
    // `OR`, not `not: 'sensitive'`: SQL `<>` drops the NULLs, and a definition with no
    // classification of its own is the common case.
    model: 'KgAttributeDef',
    where: (userId) => ({
      ownerId: userId,
      OR: [{ sensitivity: null }, { sensitivity: { not: 'sensitive' } }],
    }),
  },
];

/** The datasets of one user's export. Exposed for the policy spec. */
export async function* kvoxContentTables(ctx: ExportContext): AsyncGenerator<ExportTable> {
  for (const dataset of KVOX_CONTENT_DATASETS) {
    const model = ctx.datamodel.models.find((candidate) => candidate.name === dataset.model);
    if (!model) continue;

    yield modelTable(ctx, { model, where: dataset.where(ctx.subjectId), omit: dataset.omit ?? [] });
  }
}

/**
 * Transcript speakers and segments, note history, Ask messages and the owner's non-sensitive
 * attribute definitions, each tied to the user through its parent row. No request options.
 */
export const KVOX_CONTENT_EXPORT_SOURCE: ExportSource<Record<string, never>> = {
  id: KVOX_CONTENT_EXPORT_SOURCE_ID,
  scope: 'user',
  label: 'Transcript, note and Ask content',
  description:
    'The text of your own transcripts (speakers and segments), the version history of your notes, your Ask conversations and your custom graph attributes. Your transcripts, notes and graph entities themselves are in "Your data".',
  permission: KVOX_CONTENT_EXPORT_PERMISSION,
  requestSchema: z.object({}).strict(),
  // LISTED, unlike `user-data`: the built-in writers attach only to the platform's own source ids
  // (`PLATFORM_SOURCE_IDS`), so a source of the app's must name them or it offers no format at all.
  formats: [JSON_EXPORT_WRITER.id, CSV_EXPORT_WRITER.id, XLSX_EXPORT_WRITER.id],
  columnTypes: MODEL_TABLE_COLUMN_TYPES,
  collect: (ctx) => kvoxContentTables(ctx),
};
