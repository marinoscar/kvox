// =============================================================================
// Reading a transcript for a name check (issue #328, epic #326)
// =============================================================================
//
// One reader, two callers: `TranscriptNameCheckService` (the request-time
// estimate) and `TranscriptNameCheckHandler` (the run). They must read the
// segments in the same order, because a discovery chunk addresses segments by
// their index in this list and an estimate packed from a differently ordered
// list would be an estimate of a different request.
//
// ⚠ READS THE LIVE TABLES, NOT `materialize()`. A check always runs against the
// transcript as it is now (`currentVersion`), and the live tables ARE that
// version by construction (spec §4.4) — materializing would replay the log to
// arrive at the rows this query reads directly.
// =============================================================================

import type { Prisma } from '@prisma/client';

import type { PrismaService } from '../prisma/prisma.service';
import type { CandidateSegment, CandidateWord } from './name-check/candidates';

export interface NameCheckSpeaker {
  id: string;
  label: string | null;
  displayName: string;
}

export interface NameCheckInput {
  segments: CandidateSegment[];
  speakers: NameCheckSpeaker[];
  /** Speaker id → display name, for the prompts. */
  speakerNames: Map<string, string>;
  /** Segment id → index into `segments`. */
  segmentIndex: Map<string, number>;
}

/**
 * The transcript's segments in reading order (`startMs`, then `ordinal`) and
 * its speakers.
 *
 * `withWords` loads the provider's word confidences for the phonetic pass's
 * low-confidence bonus; the estimate skips them — they are the largest column
 * in the schema and move a candidate's score by a few hundredths at most.
 */
export async function loadNameCheckInput(
  client: PrismaService | Prisma.TransactionClient,
  transcriptId: string,
  withWords: boolean,
): Promise<NameCheckInput> {
  const [speakers, rows] = await Promise.all([
    client.transcriptSpeaker.findMany({
      where: { transcriptId },
      orderBy: { colorIndex: 'asc' },
      select: { id: true, label: true, displayName: true },
    }),
    client.transcriptSegment.findMany({
      where: { transcriptId },
      orderBy: [{ startMs: 'asc' }, { ordinal: 'asc' }],
      select: { id: true, rev: true, speakerId: true, startMs: true, text: true, words: withWords },
    }),
  ]);

  const segments: CandidateSegment[] = rows.map((row) => ({
    id: row.id,
    rev: row.rev,
    speakerId: row.speakerId,
    startMs: row.startMs,
    text: row.text,
    ...(withWords ? { words: readWords((row as { words?: unknown }).words) } : {}),
  }));

  return {
    segments,
    speakers,
    speakerNames: new Map(speakers.map((s) => [s.id, s.displayName])),
    segmentIndex: new Map(segments.map((s, i) => [s.id, i])),
  };
}

/** `{t,s,e,c}` JSONB → `{t,c}`, defensively: anything malformed is skipped. */
function readWords(raw: unknown): CandidateWord[] {
  if (!Array.isArray(raw)) return [];
  const out: CandidateWord[] = [];
  for (const w of raw) {
    if (typeof w !== 'object' || w === null) continue;
    const { t, c } = w as { t?: unknown; c?: unknown };
    if (typeof t !== 'string') continue;
    out.push({ t, c: typeof c === 'number' && Number.isFinite(c) ? c : null });
  }
  return out;
}
