// =============================================================================
// The one line a version shows in the history list (issue #27, epic #19)
// =============================================================================
//
// `transcript_versions.summary` is what a user reads when deciding whether to
// restore something. "9 operations" tells them nothing; "Renamed Speaker A to
// Dana, corrected 3 lines" tells them whether this is the save they are looking
// for.
//
// ⚠ GENERATED FROM THE RECORDED OPS, AND FROM NOTHING ELSE. A summary written
// from the REQUEST would describe a `transcript.find_replace` that was never
// recorded (spec §4.2 expands it first), and a summary written later from the
// database would have to re-derive intent from rows that no longer remember it.
// The recorded ops are what a replay will produce, so they are what the sentence
// describes.
// =============================================================================

import { OP_TYPES, type RecordedOp } from './ops';

/** Pluralise without importing a library for it. */
function count(n: number, singular: string, plural = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

/** The find & replace a batch was expanded from, for the summary's benefit. */
export interface FindReplaceSummaryInput {
  find: string;
  replace: string;
  segments: number;
  occurrences: number;
}

/**
 * A human-readable description of one saved version.
 *
 * `findReplace` is passed separately because it is the one thing the recorded
 * ops genuinely cannot say: they are `segment.update_text` ops by the time they
 * are written down, and "corrected 12 lines" would lose the fact that the user
 * asked for one replacement across twelve of them.
 */
export function summarizeOps(
  ops: readonly RecordedOp[],
  options: { findReplace?: FindReplaceSummaryInput[]; speakerNames?: Map<string, string> } = {},
): string {
  const speakerNames = options.speakerNames ?? new Map<string, string>();
  const name = (id: string): string => speakerNames.get(id) ?? 'a speaker';

  const parts: string[] = [];

  for (const replacement of options.findReplace ?? []) {
    parts.push(
      `Replaced “${replacement.find}” with “${replacement.replace}” ` +
        `(${count(replacement.occurrences, 'occurrence')} in ` +
        `${count(replacement.segments, 'line')})`,
    );
  }

  let edited = 0;
  let reassigned = 0;
  let split = 0;
  let joined = 0;
  let deleted = 0;
  const renamed: string[] = [];
  const created: string[] = [];
  let restoredFrom: number | null = null;

  const findReplaceCount = (options.findReplace ?? []).reduce(
    (total, entry) => total + entry.segments,
    0,
  );

  for (const op of ops) {
    switch (op.op) {
      case OP_TYPES.UPDATE_TEXT:
        edited += 1;
        break;
      case OP_TYPES.SET_SPEAKER:
        reassigned += 1;
        break;
      case OP_TYPES.SPLIT:
        split += 1;
        break;
      case OP_TYPES.JOIN:
        joined += 1;
        break;
      case OP_TYPES.DELETE:
        deleted += 1;
        break;
      case OP_TYPES.RENAME_SPEAKER:
        renamed.push(op.displayName);
        break;
      case OP_TYPES.CREATE_SPEAKER:
        created.push(op.displayName);
        break;
      case OP_TYPES.MERGE_SPEAKERS:
        parts.push(
          `Merged ${count(op.sourceIds.length, 'speaker')} into ${name(op.targetId)}`,
        );
        break;
      case OP_TYPES.RESTORE:
        restoredFrom = op.fromVersion;
        break;
      /* istanbul ignore next — exhaustive */
      default:
        break;
    }
  }

  if (restoredFrom !== null) return `Restored version ${restoredFrom}`;

  // Text edits produced by a find & replace are already accounted for by the
  // sentence above, so only the surplus is reported as hand corrections.
  const handEdited = Math.max(0, edited - findReplaceCount);

  if (handEdited > 0) parts.push(`Corrected ${count(handEdited, 'line')}`);
  if (reassigned > 0) parts.push(`Reassigned ${count(reassigned, 'line')}`);
  if (split > 0) parts.push(`Split ${count(split, 'line')}`);
  if (joined > 0) parts.push(`Joined ${count(joined, 'pair')}`);
  if (deleted > 0) parts.push(`Deleted ${count(deleted, 'line')}`);
  if (renamed.length > 0) parts.push(`Renamed ${renamed.length === 1 ? `a speaker to ${renamed[0]}` : count(renamed.length, 'speaker')}`);
  if (created.length > 0) parts.push(`Added ${created.length === 1 ? `speaker ${created[0]}` : count(created.length, 'speaker')}`);

  if (parts.length === 0) return 'No changes';

  return parts.join(', ');
}
