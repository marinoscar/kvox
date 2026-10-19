// =============================================================================
// Which sections of Home are drawn, and when the account counts as new
// =============================================================================

/**
 * The sections of the Home page, in the order the page draws them.
 *
 * @remarks
 * - `hero`: the greeting, the host's actions, New note and the transcript search.
 * - `journey`: the first-run walkthrough, drawn instead of everything below it
 *   for an account with nothing yet.
 * - `counts`: the four numbers (transcript-led: it needs `recentTranscripts`).
 * - `inProgress`: uploads, transcripts and notes that are moving right now.
 * - `needsAttention`: failed work with a retry.
 * - `recentTranscripts`: the newest transcripts. **Listing it is also what makes the
 *   page read the transcript summary**, which `counts`, `inProgress`,
 *   `needsAttention`, `sharedWithMe` and the new-account test lean on; a host without
 *   transcription leaves it out and the page never asks for one.
 * - `recentNotes`: the newest notes (also gated on `notes:read`).
 * - `knowledge`: the graph drafts waiting for review and the recent people and
 *   organizations (also gated on `graph:read`).
 * - `sharedWithMe`: transcripts others shared.
 *
 * @stability experimental
 */
export type KvoxHomeSection =
  | 'hero'
  | 'journey'
  | 'counts'
  | 'inProgress'
  | 'needsAttention'
  | 'recentTranscripts'
  | 'recentNotes'
  | 'knowledge'
  | 'sharedWithMe';

/**
 * Every section, in page order: the default of `KvoxHomePage`'s `sections`.
 *
 * @stability experimental
 */
export const KVOX_HOME_SECTIONS: readonly KvoxHomeSection[] = [
  'hero',
  'journey',
  'counts',
  'inProgress',
  'needsAttention',
  'recentTranscripts',
  'recentNotes',
  'knowledge',
  'sharedWithMe',
];

/**
 * What {@link isNewAccount} reads.
 *
 * @stability experimental
 */
export interface NewAccountFacts {
  /** The transcript half has been read (or is not part of this page). */
  transcriptsSettled: boolean;
  /** Transcripts the person owns. */
  ownedTranscripts: number;
  /** Rows in the recent list. */
  recentTranscripts: number;
  /** Transcripts shared with the person. */
  sharedTranscripts: number;
  /** Transcripts or uploads in flight. */
  inProgress: number;
  /** Notes the person has; a notes read that has not answered counts as none. */
  notes: number;
}

/**
 * Whether the account has nothing yet, which swaps the page for the journey.
 *
 * @remarks
 * A transcript summary that has not been read (or failed) is NOT a new account:
 * nothing was read, so nothing is known to be missing. The notes half is looser by
 * design, as it always was: a person without `notes:read` has no notes to count.
 *
 * @param facts - what the summaries said.
 * @returns `true` for a first-run account.
 *
 * @stability experimental
 */
export function isNewAccount(facts: NewAccountFacts): boolean {
  return (
    facts.transcriptsSettled &&
    facts.recentTranscripts === 0 &&
    facts.sharedTranscripts === 0 &&
    facts.inProgress === 0 &&
    facts.ownedTranscripts === 0 &&
    facts.notes === 0
  );
}
