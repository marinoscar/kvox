// =============================================================================
// `ExportDocument` — the one shape every exporter renders from (issue #28, §8.1)
// =============================================================================
//
// PURE, like everything in `../editing/`, and for the same reason: it is built
// once from `materialize(transcriptId, version)` and handed to whichever
// renderer the caller asked for, so the three renderers **cannot disagree about
// what the transcript says** — only about how they format it. A renderer that
// could read a row would be a renderer able to answer a question the other two
// never asked, which is exactly the drift spec §8.1 exists to forbid.
//
// -----------------------------------------------------------------------------
// WHY TALK-TIME PERCENTAGES ARE A SHARE OF SPEECH, NOT OF THE RECORDING
// -----------------------------------------------------------------------------
//
// `talkTimePercent` divides a speaker's talk time by the SUM OF ALL SPEAKERS'
// talk time, not by `durationMs`. Dividing by the recording's length is the
// obvious reading of "talk time percentage" and it is the wrong one: every
// pause, every gap between segments, and every second of music at the top of
// the file is time nobody spoke, so the percentages would sum to something
// under 100 and a reader would reasonably conclude the numbers were broken.
// A share of the SPEECH sums to 100 (modulo rounding) and answers the question
// somebody reading a participants block is actually asking — "who did most of
// the talking" — rather than "how much of the file was speech", which the
// duration already tells them.
//
// Overlapping diarized segments can make the sum exceed `durationMs`. That is
// a property of the input, not an error, and it is another reason not to use
// the recording's length as the denominator: it can produce a percentage above
// 100 for a genuinely valid transcript.
//
// -----------------------------------------------------------------------------
// `durationMs` IS NEVER NULL HERE, EVEN THOUGH THE COLUMN IS NULLABLE
// -----------------------------------------------------------------------------
//
// `transcripts.duration_ms` is null until the provider reports one. The
// published JSON schema (`docs/specs/transcript-export.v1.schema.json`) makes
// `durationMs` a required non-negative integer, so the builder falls back to
// the largest segment end it can see — which is a lower bound on the real
// duration and is exactly what a reader would compute themselves from the
// segments. A null crossing into the document would make every exporter carry
// its own opinion about what to print instead.
// =============================================================================

import type { EditingState, WordsAlignmentValue } from '../editing/index.js';
import { sortForRead } from '../editing/index.js';

/**
 * Who authored the exported version. Null for the AI original (spec §8.2).
 *
 * @stability experimental
 */
export interface ExportAuthor {
  /** The display name. */
  displayName: string;
  /** The address. */
  email: string;
}

/**
 * Which provider produced the AI original this version descends from.
 *
 * @stability experimental
 */
export interface ExportProvider {
  /** The id. */
  id: string;
  /** The model that produced the transcript, or `null`. */
  model: string | null;
}

/**
 * One speaker, with the talk time every renderer reports.
 *
 * @stability experimental
 */
export interface ExportSpeaker {
  /** The id. */
  id: string;
  /** The provider's own diarization label (`"A"`), or null if user-created. */
  label: string | null;
  /** The display name. */
  displayName: string;
  /** Stable index into the speaker palette — the PDF's colour comes from it. */
  colorIndex: number;
  /** Sum of this speaker's segment durations, in milliseconds. */
  talkTimeMs: number;
  /** Share of all speech, 0-100, rounded to one decimal. See the header. */
  talkTimePercent: number;
}

/**
 * One word timing, in the long-form names the public schema publishes.
 *
 * @stability experimental
 */
export interface ExportWord {
  /** The text. */
  text: string;
  /** Start, in milliseconds from the beginning of the recording. */
  startMs: number;
  /** End, in milliseconds from the beginning of the recording. */
  endMs: number;
  /** The provider's confidence, 0 to 1, or `null`. */
  confidence: number | null;
}

/**
 * One segment, in reading order.
 *
 * @stability experimental
 */
export interface ExportSegment {
  /** The id. */
  id: string;
  /** The speaker's id. */
  speakerId: string;
  /** Start, in milliseconds from the beginning of the recording. */
  startMs: number;
  /** End, in milliseconds from the beginning of the recording. */
  endMs: number;
  /** The text. */
  text: string;
  /** The provider's confidence, 0 to 1, or `null`. */
  confidence: number | null;
  /** How trustworthy the word timings are. */
  wordsAlignment: WordsAlignmentValue;
  /** Always present in the document; an exporter decides whether to emit it. */
  words: ExportWord[];
}

/**
 * The provider-neutral document all three exporters render.
 *
 * @stability experimental
 */
export interface ExportDocument {
  /** The transcript. */
  transcriptId: string;
  /** The title. */
  title: string;
  /** The language code, or `null`. */
  language: string | null;
  /** The duration, in milliseconds, or `null`. */
  durationMs: number;
  /** The version the document renders. */
  version: number;
  /** When the exported VERSION was created — not when this file was rendered. */
  createdAt: Date;
  /** When this document was rendered. */
  exportedAt: Date;
  /** Who made the version. */
  author: ExportAuthor | null;
  /** The provider that transcribed it. */
  provider: ExportProvider | null;
  /** The speakers. */
  speakers: ExportSpeaker[];
  /** The segments. */
  segments: ExportSegment[];
}

/**
 * Everything the builder needs that `EditingState` does not carry.
 *
 * @stability experimental
 */
export interface BuildExportDocumentInput {
  /** The transcript. */
  transcriptId: string;
  /** The title. */
  title: string;
  /** The language code, or `null`. */
  language: string | null;
  /** `transcripts.duration_ms`, which may be null. See the header. */
  durationMs: number | null;
  /** The version the document renders. */
  version: number;
  /** When the transcript was created. */
  createdAt: Date;
  /** When the document was rendered. */
  exportedAt: Date;
  /** Who made the version. */
  author: ExportAuthor | null;
  /** The provider that transcribed it. */
  provider: ExportProvider | null;
  /** The resulting state. */
  state: EditingState;
}

/**
 * Build the document. Pure, total, and the only place talk time is computed.
 *
 * Speakers come back ordered by `colorIndex`, matching
 * `TranscriptMaterializeService.loadLiveState`'s own ordering so that a
 * document built from the live tables and one built from a snapshot list the
 * participants in the same order. Segments come back in READING ORDER
 * (`startMs`, then `ordinal`) — the order `GET /:id/segments` uses, so an
 * export and the on-screen transcript can never disagree about what follows
 * what.
  *
  * @stability experimental
 */
export function buildExportDocument(input: BuildExportDocumentInput): ExportDocument {
  const segments = sortForRead(input.state.segments);

  const talkTime = new Map<string, number>();
  let totalTalk = 0;
  let lastEnd = 0;

  for (const segment of segments) {
    // `max(0, …)` because a segment whose end precedes its start is a corrupt
    // row, not a negative contribution to somebody's share of the conversation.
    const span = Math.max(0, segment.endMs - segment.startMs);

    talkTime.set(segment.speakerId, (talkTime.get(segment.speakerId) ?? 0) + span);
    totalTalk += span;
    lastEnd = Math.max(lastEnd, segment.endMs);
  }

  const speakers: ExportSpeaker[] = [...input.state.speakers]
    .sort((a, b) => a.colorIndex - b.colorIndex)
    .map((speaker) => {
      const ms = talkTime.get(speaker.id) ?? 0;

      return {
        id: speaker.id,
        label: speaker.label,
        displayName: speaker.displayName,
        colorIndex: speaker.colorIndex,
        talkTimeMs: ms,
        talkTimePercent: totalTalk > 0 ? Math.round((ms / totalTalk) * 1000) / 10 : 0,
      };
    });

  return {
    transcriptId: input.transcriptId,
    title: input.title,
    language: input.language,
    durationMs: Math.max(0, Math.round(input.durationMs ?? lastEnd)),
    version: input.version,
    createdAt: input.createdAt,
    exportedAt: input.exportedAt,
    author: input.author,
    provider: input.provider,
    speakers,
    segments: segments.map((segment) => ({
      id: segment.id,
      speakerId: segment.speakerId,
      startMs: segment.startMs,
      endMs: segment.endMs,
      text: segment.text,
      confidence: segment.confidence,
      wordsAlignment: segment.wordsAlignment,
      words: segment.words.map((word) => ({
        text: word.t,
        startMs: word.s,
        endMs: word.e,
        confidence: word.c,
      })),
    })),
  };
}

/**
 * A speaker id to its document entry, for renderers walking the segments.
 *
 * @stability experimental
 */
export function speakerIndex(doc: ExportDocument): Map<string, ExportSpeaker> {
  return new Map(doc.speakers.map((speaker) => [speaker.id, speaker]));
}

/**
 * `HH:MM:SS` for a millisecond offset into the media.
 *
 * ALWAYS THREE FIELDS, including for a thirty-second clip (`00:00:30`), which
 * is the form spec §8.3 writes (`**Speaker** · 00:01:23`). A format that
 * dropped the hours for short recordings would make two exports of the same
 * conversation — one before and one after a longer take was appended — differ
 * in a way a diff would report on every single line.
  *
  * @stability experimental
 */
export function formatTimestamp(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;

  return [hours, minutes, seconds].map((part) => String(part).padStart(2, '0')).join(':');
}

/**
 * A human-readable duration: `1h 04m 12s`, `4m 12s`, `12s`.
 *
 * For the cover block and the Markdown front matter, where `01:04:12` reads as
 * a position in the recording rather than as a length of one. The timestamp
 * form above is for positions; this one is for spans, and they are deliberately
 * not the same string.
  *
  * @stability experimental
 */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;

  if (hours > 0) {
    return `${hours}h ${String(minutes).padStart(2, '0')}m ${String(seconds).padStart(2, '0')}s`;
  }

  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, '0')}s`;

  return `${seconds}s`;
}
