/**
 * Version history, grouped into editing sessions — issue #31, epic #19.
 *
 * =============================================================================
 * WHY A FLAT LIST OF VERSIONS IS THE WRONG THING TO SHOW A PERSON
 * =============================================================================
 *
 * A version is a save, and a save is what the correction queue produces every
 * 1.5 seconds of idle. Correcting one interview therefore leaves thirty or
 * forty versions behind — a flat list of them is an event log, not a history,
 * and the question a user actually arrives with ("what did I change on
 * Tuesday, and can I go back to before it?") is answered by neither the
 * individual rows nor their count.
 *
 * So consecutive versions by the SAME author on the SAME calendar day become
 * one session. That grouping is deliberately coarse and deliberately not
 * time-window-based: a session is "a person sitting down with this transcript",
 * and somebody who corrects a transcript in the morning and again after lunch
 * genuinely did one day's work on it. A 30-minute-gap rule would split that in
 * two and would also silently re-group the same history differently depending
 * on when it was read.
 *
 * =============================================================================
 * TWO THINGS THAT NEVER MERGE INTO A SESSION
 * =============================================================================
 *
 * **Version 1** stands alone. It is the AI original (`kind: 'ai_original'`,
 * `author: null` meaning the AI, not a missing value) and it is the version
 * this whole epic's thesis is about: it is what was proposed, before anybody
 * controlled it. Folding it into "3 changes by the AI" would bury the one row
 * that is never an edit.
 *
 * **A restore** stands alone too. It is not one more correction in a sitting;
 * it is the moment somebody replaced the whole transcript, and the row above it
 * and the row below it mean different things because of it.
 */

import type {
  TranscriptVersionSummary,
} from '../services/transcriptEditing';

export interface VersionSession {
  /** Stable across re-renders: the newest version's number. */
  key: string;
  /** Who did the work, or null meaning the AI. */
  authorName: string | null;
  /** ISO date of the newest version in the session. */
  latestAt: string;
  /** Newest first, as the API returns them. */
  versions: TranscriptVersionSummary[];
  /** True for the AI original — the badge row. */
  isAiOriginal: boolean;
  isRestore: boolean;
}

/** What the list calls somebody, with the API's null-means-AI convention applied. */
export function authorLabel(version: TranscriptVersionSummary): string {
  if (!version.author) return 'Transcribed automatically';
  return version.author.name || version.author.email || 'Someone';
}

/** `2026-09-14` in the VIEWER's timezone — grouping is by their day, not UTC's. */
function localDayKey(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * Group `versions` (newest first, as the API returns them) into sessions.
 *
 * Pure, and exported for its own test: the rules above are invisible in a
 * rendered list and every one of them is a judgement somebody will later want
 * to change deliberately rather than by accident.
 */
export function groupVersionsIntoSessions(
  versions: readonly TranscriptVersionSummary[],
): VersionSession[] {
  const sessions: VersionSession[] = [];

  for (const version of versions) {
    const standalone = version.kind === 'ai_original' || version.kind === 'restore';
    const current = sessions[sessions.length - 1];
    const sameSession =
      current &&
      !standalone &&
      !current.isAiOriginal &&
      !current.isRestore &&
      current.authorName === authorLabel(version) &&
      localDayKey(current.latestAt) === localDayKey(version.createdAt);

    if (sameSession) {
      current.versions.push(version);
      continue;
    }

    sessions.push({
      key: `v${version.version}`,
      authorName: version.author ? authorLabel(version) : null,
      latestAt: version.createdAt,
      versions: [version],
      isAiOriginal: version.kind === 'ai_original',
      isRestore: version.kind === 'restore',
    });
  }

  return sessions;
}

/**
 * The one line that describes a whole session.
 *
 * Prefers the SERVER's own summaries — they are generated from the ops that
 * were actually recorded ("Merged Speaker C into Speaker A"), which is the only
 * place that information exists. Falls back to a count when a version carries
 * none, and never invents a description of what changed.
 */
export function sessionSummary(session: VersionSession): string {
  if (session.isAiOriginal) return 'The transcription service produced this transcript.';
  if (session.isRestore) {
    const from = session.versions[0]?.restoredFromVersion;
    return from ? `Restored version ${from}.` : 'Restored an earlier version.';
  }

  const summaries = session.versions
    .map((version) => version.summary?.trim())
    .filter((summary): summary is string => Boolean(summary));

  if (summaries.length === 0) {
    const count = session.versions.length;
    return `${count} ${count === 1 ? 'change' : 'changes'}.`;
  }
  // Deduped, because "Edited 1 segment" five times in a row is five saves of
  // one sitting and reads as five separate pieces of work.
  const unique = [...new Set(summaries)];
  const shown = unique.slice(0, 3).join(' · ');
  return unique.length > 3 ? `${shown} · and ${unique.length - 3} more` : shown;
}
