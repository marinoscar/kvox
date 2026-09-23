// =============================================================================
// Speaker identification: naming a voice is not editing a transcript (#323)
// =============================================================================
//
// "Do not increase the version if the change is when a speaker goes from
// Speaker A to Oscar; only increase the version if I change from Oscar to Joe
// or update the text." — the user's own words, and the whole requirement.
//
// The distinction they are drawing is real, not cosmetic. The provider hands
// back anonymous diarization labels (`A`, `B`, …), and ingest turns each into a
// placeholder name, `Speaker A`. Replacing that placeholder with who the voice
// actually belongs to is an IDENTIFICATION: it adds a fact the provider could
// never have known, and it is equally true of every version of the transcript
// — Oscar did not become Oscar at version 4, he was Oscar in the recording.
// Renaming Oscar to Joe is different: it CORRECTS a claim a person already
// made, and a correction is exactly what the version history exists to record.
//
// So an identification is stored beside the version log rather than in it —
// the `transcripts.speaker_identities` map — and `materialize()` overlays it on
// EVERY version (see `applyIdentities` below, and the header of
// `transcript-materialize.service.ts` for why an overlay rather than an op).
//
// -----------------------------------------------------------------------------
// WHY "UNIDENTIFIED" IS DEFINED BY THE NAME, NOT BY A FLAG
// -----------------------------------------------------------------------------
//
// A speaker is unidentified when it has a provider `label` AND its display name
// is still exactly the placeholder ingest gave it. There is no `identified`
// column, deliberately: a flag would be a second source of truth beside the
// name, able to disagree with it after a restore or a versioned rename back to
// the placeholder. Deriving it from `(label, displayName)` makes that
// disagreement unrepresentable, and it is why the default name is a function
// (`defaultSpeakerName`) that ingest itself calls — if the two ever spelled
// the placeholder differently, every speaker would look "already identified"
// and every naming would silently become a version again.
//
// A speaker a person created (`label: null`) is never unidentified: it was
// born with a human-chosen name, so there is no placeholder to replace.
//
// ⚠ PURE, like everything in this directory. No database, no clock.
// =============================================================================

import { createHash } from 'node:crypto';

import type { EditableSpeaker, EditingState } from './editing-state';
import { OP_TYPES, type RecordedOp, type RenameSpeakerOp } from './ops';

/**
 * The placeholder ingest gives a provider-labelled speaker.
 *
 * ⚠ THE ONE SPELLING. `transcription-ingest.handler.ts` calls this rather than
 * writing its own template string, because `isUnidentified` compares against
 * it byte for byte — see the file header.
 */
export function defaultSpeakerName(label: string): string {
  return `Speaker ${label}`;
}

/** Still carrying the placeholder ingest gave it — nobody has named this voice yet. */
export function isUnidentified(speaker: Pick<EditableSpeaker, 'label' | 'displayName'>): boolean {
  return speaker.label !== null && speaker.displayName === defaultSpeakerName(speaker.label);
}

/**
 * How a `speaker.rename` relates to the speaker it targets.
 *
 *   • `identification` — the speaker is unidentified and the new name is a
 *     real name, not the placeholder again. Unversioned.
 *   • `noop` — the trimmed new name is the name the speaker already has. Also
 *     unversioned, and the reason an idempotent retry of an identification
 *     needs no version-row lookup: by the time it arrives the speaker already
 *     carries the name, so the retry classifies as a no-op.
 *   • `versioned` — anything else, including a rename of a speaker that is not
 *     in the state at all (the versioned path owns the honest 409 for that).
 */
export type RenameKind = 'identification' | 'noop' | 'versioned';

export function classifyRename(
  speaker: Pick<EditableSpeaker, 'label' | 'displayName'> | undefined,
  op: Pick<RenameSpeakerOp, 'displayName'>
): RenameKind {
  if (!speaker) return 'versioned';

  const name = op.displayName.trim();

  if (name === speaker.displayName) return 'noop';

  if (
    isUnidentified(speaker) &&
    name.length > 0 &&
    name !== defaultSpeakerName(speaker.label as string)
  ) {
    return 'identification';
  }

  return 'versioned';
}

/**
 * Does this whole batch consist of nothing but identifications and no-op
 * renames, classified against `state`?
 *
 * ⚠ ALL OR NOTHING. A batch that also corrects a line, or renames Oscar to
 * Joe, is versioned anyway — the version bumps for the other op — so its
 * identifications ride along as ordinary recorded renames. Splitting one batch
 * across the two paths would make one user action land as two separate writes
 * with two separate failure modes.
 */
export function isIdentificationBatch(state: EditingState, ops: readonly RecordedOp[]): boolean {
  if (ops.length === 0) return false;

  // A working copy of the names, walked IN BATCH ORDER: `[A → Oscar, A → Joe]`
  // is an identification followed by a correction, and the second op must be
  // classified against the name the first one gave, exactly as the reducers
  // would see it.
  const names = new Map(
    state.speakers.map((speaker) => [
      speaker.id,
      { label: speaker.label, displayName: speaker.displayName },
    ])
  );

  for (const op of ops) {
    if (op.op !== OP_TYPES.RENAME_SPEAKER) return false;

    const speaker = names.get(op.speakerId);

    if (classifyRename(speaker, op) === 'versioned') return false;

    if (speaker) speaker.displayName = op.displayName.trim();
  }

  return true;
}

/**
 * Overlay the identities map onto a state.
 *
 * Only a speaker that is STILL unidentified at this version takes its entry:
 * one that a versioned rename already gave a name keeps that name, because a
 * correction recorded in the log outranks an identification recorded beside
 * it. An entry for a speaker that is not in the state (merged away, or deleted
 * by a restore) is simply ignored.
 *
 * ⚠ `rev` IS NEVER TOUCHED. The identification write path does not bump it
 * either, and that symmetry is what keeps the version log replayable: a later
 * versioned op names the rev replay will actually reproduce. Idempotent, too —
 * a named speaker is no longer unidentified, so a second pass changes nothing.
 */
export function applyIdentities(
  state: EditingState,
  identities: Readonly<Record<string, string>>
): EditingState {
  if (Object.keys(identities).length === 0) return state;

  return {
    ...state,
    speakers: state.speakers.map((speaker) => {
      const name = identities[speaker.id];

      return name !== undefined && isUnidentified(speaker)
        ? { ...speaker, displayName: name }
        : speaker;
    }),
  };
}

/**
 * The `speaker_identities` JSONB column, total over anything unexpected.
 *
 * Same discipline as `readTimedWords`: written by this application, read back
 * as an untyped JSON value, and a malformed row must degrade to "no names"
 * rather than crash every read of the transcript. A non-object is `{}`; a
 * non-string or empty value is dropped.
 */
export function parseSpeakerIdentities(json: unknown): Record<string, string> {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return {};

  const out: Record<string, string> = {};

  for (const [key, value] of Object.entries(json as Record<string, unknown>)) {
    if (typeof value === 'string' && value.trim().length > 0) out[key] = value;
  }

  return out;
}

/**
 * A short, stable fingerprint of an identities map, or `null` when it is empty.
 *
 * Two consumers need "did the names change?" without the version moving: the
 * weak ETag on the two polling routes (a poller holding `W/"v7"` would
 * otherwise get a `304` forever and never see "Oscar"), and the export reuse
 * hash (an export of v7 rendered before the naming would otherwise be handed
 * back after it). `null` for an empty map is what lets both keep their
 * pre-#323 values byte for byte for every transcript nobody has named a
 * speaker on.
 *
 * Entries are sorted by key before hashing so the fingerprint depends on what
 * the map SAYS, never on the order JSONB happened to return its keys in.
 * Deterministic, so it is as pure as anything else in this directory.
 */
export function identitiesFingerprint(identities: Readonly<Record<string, string>>): string | null {
  const entries = Object.entries(identities).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  if (entries.length === 0) return null;

  return createHash('sha256').update(JSON.stringify(entries)).digest('hex').slice(0, 12);
}
