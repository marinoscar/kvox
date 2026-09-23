/**
 * How a transcript is spelled on screen — issue #30, epic #19.
 *
 * Status words, pipeline stages and speaker colours, in one module because all
 * three are the same kind of decision: a mapping from something the API states
 * as an enum to something a person reads. Keeping them out of the components
 * means the library card, the viewer's stepper and the home page's "in
 * progress" list (#32) cannot describe the same transcript differently.
 *
 * NOTHING HERE BRANCHES ON ROLE OR PERMISSION. These are labels; who may see
 * them is settled before any of this is called.
 */

import type {
  PlaybackStatus,
  TranscriptListItem,
  TranscriptStatus,
} from '../services/transcripts';

// =============================================================================
// Speaker colour
// =============================================================================

/**
 * The speaker palette, indexed by `TranscriptSpeaker.colorIndex`.
 *
 * TWO LISTS, ONE PER THEME MODE, rather than one list of theme-agnostic hues.
 * A speaker's colour is used as TEXT on the page background (the name above
 * each segment) and as a filled band in the scrubber, so it has to clear a
 * contrast bar against two very different grounds — a mid-tone that reads
 * cleanly on white is muddy on near-black and vice versa. Picking per mode is
 * the only way both surfaces stay legible without a per-use lightness
 * calculation the components would each have to remember to do.
 *
 * `colorIndex` is assigned server-side and is STABLE for a speaker's lifetime,
 * which is what makes a colour a usable identity cue at all: the same person is
 * the same colour on every visit, in every view, and after every edit.
 *
 * The modulo in `speakerColor` means a transcript with more speakers than
 * colours REUSES them rather than running off the end. Eight is comfortably
 * past the "expected speakers" ceiling the New-transcript form offers (1–10)
 * for anything a human will actually read, and a two-colour collision in a
 * twelve-speaker recording is a far better failure than `undefined`.
 *
 * -----------------------------------------------------------------------------
 * THREE RULES, ALL OF THEM EASY TO BREAK FROM OUTSIDE THIS FILE (issue #110)
 * -----------------------------------------------------------------------------
 *
 * 1. **INDEX ORDER IS PART OF THE DATA, NOT A PRESENTATION CHOICE.**
 *    `transcript_speakers.color_index` is PERSISTED, per speaker, at ingest.
 *    Re-ordering these arrays — sorting them by hue, moving a colour somebody
 *    dislikes to the end, inserting a ninth in the middle — silently recolours
 *    every speaker in every transcript that already exists, including ones a
 *    user has already read, annotated and shared. Both arrays must therefore be
 *    edited POSITIONALLY: a colour may be replaced in place (issue #110 did
 *    exactly that, eight times), and colours may be APPENDED, but nothing may
 *    move. The two lists must also stay the same length as each other, because
 *    a speaker keeps one index across both modes.
 *
 * 2. **NO INDIGO IN EITHER LIST.** Indigo is the brand colour
 *    (`theme/tokens.ts`), which in this application means "selected", "active"
 *    or "link" — a tab indicator, a focus ring, a selected row's wash, every
 *    `<Link>` in body text. A speaker name drawn in the brand hue reads as a
 *    control, and in the segment list (where the name sits directly above
 *    tappable text) it reads as one the user has already activated. The two
 *    blues that ARE here — `#0e7490` (cyan-leaning teal) and `#0369a1` (a true
 *    blue) — are far enough around the wheel from `#4f46e5` to be told apart
 *    beside it. Every hue is otherwise deliberately spread: teal, magenta,
 *    green, orange, purple, blue, amber-brown, slate.
 *
 * 3. **EVERY COLOUR CLEARS WCAG AA (4.5:1) AS TEXT ON BOTH SURFACES OF ITS
 *    MODE**, and `src/__tests__/theme/tokens.test.ts` recomputes that on every
 *    run rather than trusting this comment. The measured floors, as the lists
 *    stand:
 *
 *      light  min 4.60:1 on `#f6f7fb` (`background.default`, the page ground)
 *             — `#a16207`, index 6; min 4.92:1 on `#ffffff` (`paper`)
 *      dark   min 9.58:1 on `#171a23` (`paper`) — `#f9a8d4`, index 1;
 *             min 10.41:1 on `#0f1117` (`background.default`)
 *
 *    This rule is why the change happened at all. The light list this replaced
 *    contained `#e65100` (3.48:1) and `#00838f` (4.15:1) on the old `#f5f5f5`
 *    ground: both had failed AA since the day they were written, and neither
 *    was noticed, because a palette nothing measures is a palette nobody has
 *    checked. The dark list had far more headroom than it needed and was
 *    replaced for hue consistency with the light one, not for contrast.
 */
const SPEAKER_COLORS_LIGHT = [
  '#0e7490',
  '#be185d',
  '#15803d',
  '#c2410c',
  '#7e22ce',
  '#0369a1',
  '#a16207',
  '#475569',
] as const;

const SPEAKER_COLORS_DARK = [
  '#67e8f9',
  '#f9a8d4',
  '#86efac',
  '#fdba74',
  '#d8b4fe',
  '#7dd3fc',
  '#fde68a',
  '#cbd5e1',
] as const;

/**
 * The two lists, exported for the contrast test ONLY.
 *
 * Not for rendering: a component resolves a speaker's colour through
 * `speakerColor`, which owns the modulo and the negative-index guard. Exported
 * because a test that re-declared the eight values would be checking its own
 * copy, which is precisely the failure mode rule 3 above describes.
 */
export const SPEAKER_PALETTES = {
  light: SPEAKER_COLORS_LIGHT,
  dark: SPEAKER_COLORS_DARK,
} as const;

/** How many distinct colours exist before the palette repeats. */
export const SPEAKER_COLOR_COUNT = SPEAKER_COLORS_LIGHT.length;

/**
 * The colour for a speaker, in the given theme mode.
 *
 * A NEGATIVE OR NON-INTEGER `colorIndex` still answers a colour. The value
 * comes from the API and is typed as an integer, but `-1 % 8` is `-1` in
 * JavaScript and would index off the front of the array — a blank name rather
 * than a wrong colour, which is the worse failure of the two.
 */
export function speakerColor(colorIndex: number, mode: 'light' | 'dark'): string {
  const palette = mode === 'dark' ? SPEAKER_COLORS_DARK : SPEAKER_COLORS_LIGHT;
  const safe = Number.isFinite(colorIndex) ? Math.abs(Math.trunc(colorIndex)) : 0;
  return palette[safe % palette.length];
}

// =============================================================================
// Status
// =============================================================================

/** What a status chip says and which MUI colour it wears. */
export interface StatusDescriptor {
  label: string;
  color: 'default' | 'primary' | 'success' | 'warning' | 'error' | 'info';
}

/**
 * The top-level status, as a chip.
 *
 * `deleting` is `error`-coloured and not `default`: it is irreversible (the
 * purge job removes every object the transcript ever owned), and a neutral grey
 * chip is how an irreversible state gets mistaken for a transient one.
 */
export function transcriptStatusDescriptor(status: TranscriptStatus): StatusDescriptor {
  switch (status) {
    case 'uploading':
      return { label: 'Uploading', color: 'info' };
    case 'processing':
      return { label: 'Processing', color: 'warning' };
    case 'ready':
      return { label: 'Ready', color: 'success' };
    case 'failed':
      return { label: 'Failed', color: 'error' };
    case 'deleting':
      return { label: 'Deleting', color: 'error' };
    default:
      return { label: status, color: 'default' };
  }
}

/**
 * The label an `uploading` transcript wears when no upload in THIS browser is
 * carrying its bytes — issue #322.
 */
export const UPLOAD_INTERRUPTED_LABEL = 'Upload interrupted';

/**
 * Is this transcript stuck in `uploading` with nothing moving its bytes?
 *
 * Issue #322. The server only knows a transcript is `uploading`; whether the
 * bytes are actually moving is known ONLY to the browser doing the upload (the
 * app-wide upload manager, #22). So "interrupted" is a LOCAL judgement:
 * `uploading`, and no live upload in this browser's manager names this
 * transcript id.
 *
 * `liveTranscriptIds === null` means "no upload manager to ask" (a surface
 * rendered outside the authenticated shell, or a test without the provider) —
 * the answer is then `false`, so the rendering is exactly what it was before
 * this issue rather than a guess. A missing `id` is treated the same way.
 *
 * ⚠ An upload running in ANOTHER tab or on another device reads as interrupted
 * here. That is the honest limit of a per-browser fact, and the cost is a
 * warning chip on a row that will flip to `processing` on the next refetch;
 * the server's own abandoned-upload purge (`transcription.abandonedUploadHours`)
 * is what actually decides whether the transcript is dead.
 */
export function isUploadInterrupted(
  item: Pick<TranscriptListItem, 'status'> & { id?: string },
  liveTranscriptIds: ReadonlySet<string> | null,
): boolean {
  if (item.status !== 'uploading') return false;
  if (!liveTranscriptIds || !item.id) return false;
  return !liveTranscriptIds.has(item.id);
}

/**
 * The sub-pipeline stage a PROCESSING transcript is actually in, as one short
 * phrase — or `null` when there is nothing more specific to say.
 *
 * Both sub-pipelines can be in flight at once (spec §1.4), so this deliberately
 * reports ONE of them by priority rather than trying to say both: the
 * transcription round trip is the long pole and the thing a waiting user cares
 * about, so it wins whenever it is still moving, and the transcode is reported
 * only while it is the only thing left.
 *
 * Returns `null` — never an empty string — so a caller renders nothing rather
 * than an empty line with a separator around it.
 */
export function processingStageLabel(
  item: Pick<TranscriptListItem, 'transcriptionStatus' | 'playbackStatus' | 'status'>,
): string | null {
  if (item.status !== 'processing' && item.status !== 'uploading') return null;

  switch (item.transcriptionStatus) {
    case 'queued':
    case 'submitting':
      return 'Sending to the transcription service';
    case 'submitted':
    case 'processing':
      return 'Transcribing';
    case 'waiting_input':
      break;
    default:
      break;
  }

  if (item.playbackStatus === 'pending' || item.playbackStatus === 'processing') {
    return 'Preparing audio';
  }
  if (item.status === 'uploading') return 'Waiting for the upload to finish';
  return null;
}

/**
 * The four steps of the pipeline stepper, in order.
 *
 * A UI CONCEPT, not a database one. The API has three status fields with
 * fourteen values between them (spec §1.1–1.3), and showing a person any of
 * that vocabulary would be showing them the implementation. These four are what
 * the wait actually consists of.
 */
export const PIPELINE_STEPS = [
  'Uploaded',
  'Preparing audio',
  'Transcribing',
  'Ready',
] as const;

export type PipelineStep = (typeof PIPELINE_STEPS)[number];

/**
 * Which step the transcript is ON — an index into `PIPELINE_STEPS`.
 *
 * `4` (past the last step) means finished. Every step before the returned index
 * is rendered complete, which is why this returns a single number rather than a
 * per-step state: the steps are strictly sequential from the user's point of
 * view even though the two sub-pipelines overlap underneath.
 */
export function pipelineStepIndex(
  item: Pick<
    TranscriptListItem,
    'status' | 'transcriptionStatus' | 'playbackStatus'
  >,
): number {
  if (item.status === 'ready') return PIPELINE_STEPS.length;
  if (item.status === 'uploading') return 0;

  switch (item.transcriptionStatus) {
    case 'queued':
    case 'submitting':
    case 'submitted':
    case 'processing':
    case 'completed':
      return 2;
    default:
      break;
  }

  if (item.playbackStatus === 'pending' || item.playbackStatus === 'processing') return 1;
  return 1;
}

/**
 * The sentence shown when a transcript failed, always non-empty.
 *
 * A cancelled transcript is not a failure the API can explain — the user did
 * it — so `failureReason` is legitimately null there, and "Transcription
 * failed" would be a lie about what happened.
 */
export function failureMessage(
  item: Pick<TranscriptListItem, 'failureReason' | 'transcriptionStatus'>,
): string {
  if (item.failureReason) return item.failureReason;
  if (item.transcriptionStatus === 'cancelled') return 'Cancelled before it finished.';
  return 'Something went wrong while processing this recording.';
}

/** Is this transcript still doing work, and therefore worth polling quickly? */
export function isTranscriptInFlight(
  item: Pick<TranscriptListItem, 'status'> | null | undefined,
): boolean {
  return item?.status === 'uploading' || item?.status === 'processing';
}

/** `playbackStatus` says a purpose-built, seekable rendition exists. */
export function hasPlaybackRendition(status: PlaybackStatus): boolean {
  return status === 'ready' || status === 'not_needed';
}

/**
 * Is there audio a list row can honestly offer a single Play button for?
 *
 * Issue #98. A row has one control and nowhere to explain itself, so this has
 * to be stricter than "the API would answer `GET /:id/audio` with something".
 * Three facts decide it, and the two that are deliberately absent matter as
 * much as the one that is present.
 *
 * **`status === 'ready'` is required.** It is the app's existing notion of
 * "there is audio here": `TranscriptPage` hands the playback engine a
 * transcript id only once the transcript is ready, on the stated grounds that
 * before then `GET /:id/audio` has nothing to sign. A row still `uploading` has
 * no finished object; a `deleting` one is having its objects purged underneath
 * it; a `failed` one may never have got an object at all. None of the three is
 * a control worth rendering.
 *
 * **A transcode still in flight is required to be absent.** `pending` and
 * `processing` mean the seekable rendition is still being produced, so the only
 * candidate is the user's original upload — which is exactly the engine's
 * `preparing` state, a third outcome that is neither playback nor an error and
 * that a row cannot render. Every other `playbackStatus` has settled: `ready`
 * and `not_needed` have a rendition or never needed one, and `failed` means the
 * server will sign the original, which the API's own `audio()` documents as the
 * deliberate fallback because most browsers play most uploads directly. If this
 * particular browser will not, the row reports it — the preview's error path
 * exists for precisely that, and refusing to offer playback on the chance of a
 * codec mismatch would silence far more rows than it saved.
 *
 * **`durationMs` is NOT consulted.** It is null until the pipeline measures the
 * media, which makes it a missing fact ABOUT the audio rather than evidence the
 * audio is missing — and a preview needs no duration, having no scrubber.
 *
 * **`access` is NOT consulted.** Every role that can see the row holds view
 * access, and view access is what `GET /:id/audio` checks. There is nothing for
 * a role gate to add.
 */
export function hasPlayableAudio(
  item: Pick<TranscriptListItem, 'status' | 'playbackStatus'>,
): boolean {
  if (item.status !== 'ready') return false;
  return item.playbackStatus !== 'pending' && item.playbackStatus !== 'processing';
}

/** A byte count for a card. Decimal units, because that is what a file manager shows. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1000) return `${bytes} B`;
  const units = ['kB', 'MB', 'GB', 'TB'];
  let value = bytes / 1000;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

// =============================================================================
// The scrubber's speaker bands
// =============================================================================

/** One coloured band on the scrubber, as percentages of the whole duration. */
export interface ScrubberRegion {
  /** Left edge, 0–100. */
  startPct: number;
  /** Width, 0–100. */
  widthPct: number;
  /** The speaker's palette index — resolve with `speakerColor`. */
  colorIndex: number;
}

/**
 * How many columns the timeline is sampled into for the scrubber.
 *
 * ⚠ THE BANDS ARE SAMPLED, NOT DRAWN PER SEGMENT, and that is the whole reason
 * this function exists. A ten-hour recording is tens of thousands of segments;
 * one `<span>` per segment is tens of thousands of absolutely positioned
 * elements behind a control four pixels tall, most of them sub-pixel wide. The
 * scrubber's job is to show the SHAPE of the conversation — who holds the floor
 * where — and 240 columns is finer than the control can resolve on any screen
 * this application runs on.
 */
const SCRUBBER_BUCKETS = 240;

/**
 * Sample `segments` into at most `SCRUBBER_BUCKETS` bands, merging neighbours
 * that belong to the same speaker.
 *
 * The dominant speaker wins each bucket — the one holding the floor longest
 * inside it — rather than the first or the last, so a two-second interjection
 * inside a two-minute monologue does not repaint the whole bucket.
 *
 * Returns `[]` for a zero or unknown duration, which renders as a plain rail:
 * before `loadedmetadata` there is genuinely nothing to say about the shape of
 * the recording, and dividing by zero would say it wrongly.
 */
export function buildScrubberRegions(
  segments: readonly { speakerId: string; startMs: number; endMs: number }[],
  durationMs: number,
  speakerColorIndex: (speakerId: string) => number,
): ScrubberRegion[] {
  if (!Number.isFinite(durationMs) || durationMs <= 0 || segments.length === 0) {
    return [];
  }

  const bucketMs = durationMs / SCRUBBER_BUCKETS;
  /** Per bucket: speaker id → milliseconds held. */
  const buckets: Map<string, number>[] = Array.from(
    { length: SCRUBBER_BUCKETS },
    () => new Map<string, number>(),
  );

  for (const segment of segments) {
    const start = Math.max(0, Math.min(durationMs, segment.startMs));
    const end = Math.max(start, Math.min(durationMs, segment.endMs));
    const first = Math.min(SCRUBBER_BUCKETS - 1, Math.floor(start / bucketMs));
    const last = Math.min(SCRUBBER_BUCKETS - 1, Math.floor(end / bucketMs));
    for (let index = first; index <= last; index += 1) {
      const bucketStart = index * bucketMs;
      const overlap =
        Math.min(end, bucketStart + bucketMs) - Math.max(start, bucketStart);
      if (overlap <= 0) continue;
      const map = buckets[index];
      map.set(segment.speakerId, (map.get(segment.speakerId) ?? 0) + overlap);
    }
  }

  const width = 100 / SCRUBBER_BUCKETS;
  const regions: ScrubberRegion[] = [];
  for (let index = 0; index < SCRUBBER_BUCKETS; index += 1) {
    let dominant: string | null = null;
    let best = 0;
    for (const [speakerId, held] of buckets[index]) {
      if (held > best) {
        best = held;
        dominant = speakerId;
      }
    }
    if (dominant === null) continue;

    const colorIndex = speakerColorIndex(dominant);
    const previous = regions[regions.length - 1];
    // Merged only when ADJACENT: a gap of silence between two buckets of the
    // same speaker is part of the shape and must stay visible.
    if (
      previous &&
      previous.colorIndex === colorIndex &&
      Math.abs(previous.startPct + previous.widthPct - index * width) < 1e-9
    ) {
      previous.widthPct += width;
      continue;
    }
    regions.push({ startPct: index * width, widthPct: width, colorIndex });
  }

  return regions;
}
