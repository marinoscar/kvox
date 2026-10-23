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
 * The knowledge-first cards (#721, epic #708), drawn as one responsive grid under
 * the hero, before everything else. None is in {@link KVOX_HOME_SECTIONS}; a host
 * lists them (or passes {@link KVOX_KNOWLEDGE_HOME_SECTIONS}):
 *
 * - `ask`: a question box; sending it opens Ask with the question asked
 *   (`graph:read` and connected knowledge on).
 * - `reviewQueue`: drafts waiting and safe rows, a way into `/graph/review-queue`
 *   (`graph:read` and connected knowledge on).
 * - `libraries`: how many note libraries, files imported, failures, last sync, or
 *   "Add your notes folder" when there is none (`notes:read`).
 * - `graphStats`: entity and relation counts and the recently changed entities
 *   (`graph:read` and connected knowledge on).
 * - `recentImports`: the latest import batches with their status (`notes:read`).
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
  | 'sharedWithMe'
  | 'ask'
  | 'reviewQueue'
  | 'libraries'
  | 'graphStats'
  | 'recentImports';

/**
 * The classic sections, in page order: the default of `KvoxHomePage`'s `sections`
 * (KVox web). The knowledge-first cards are not among them; see
 * {@link KVOX_KNOWLEDGE_HOME_SECTIONS}.
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

/**
 * The knowledge-first Home (#721, epic #708): the hero, then Ask, the Review Queue,
 * the note libraries, the graph and the recent imports, then the first-run journey,
 * what is moving, what failed and the recent notes. No transcripts: the home of a
 * host whose content is imported notes (KVox Desktop). What `kvoxHomeRoutes` draws.
 *
 * @stability experimental
 */
export const KVOX_KNOWLEDGE_HOME_SECTIONS: readonly KvoxHomeSection[] = [
  'hero',
  'ask',
  'reviewQueue',
  'libraries',
  'graphStats',
  'recentImports',
  'journey',
  'inProgress',
  'needsAttention',
  'recentNotes',
];
