/**
 * The New-transcript screen's pure decisions — issue #30, epic #19.
 *
 * Separated from the page so the rules that REJECT a file can be tested without
 * a file picker, a drag event or a mounted React tree. Every function here is a
 * total function of its arguments.
 *
 * ⚠ NONE OF THIS IS A SECURITY BOUNDARY. `POST /api/transcripts` re-checks the
 * size against the active provider's ceiling, and the multipart upload checks
 * the REAL byte count when it completes. These checks exist so a user learns
 * that their four-gigabyte file is too big BEFORE spending twenty minutes
 * uploading it — a usability decision wearing the shape of a validation.
 */

/**
 * Extensions the picker accepts, beyond the `audio/*` wildcard.
 *
 * ⚠ THE WILDCARD IS NOT ENOUGH ON ITS OWN, which is the whole reason this list
 * exists. Browsers derive a file's `type` from the extension via an OS table
 * that is missing entries on every platform: `.m4a` is frequently `''` on
 * Windows, `.amr` (what a lot of phone voice recorders produce) is `''` almost
 * everywhere, and `.opus` is inconsistent. A picker filtered on `audio/*`
 * alone therefore greys out exactly the files a voice-memo user is trying to
 * select. Naming the extensions as well is what makes them selectable.
 */
export const ACCEPTED_AUDIO_EXTENSIONS = [
  '.m4a',
  '.mp3',
  '.wav',
  '.flac',
  '.ogg',
  '.opus',
  '.aac',
  '.amr',
  '.webm',
  '.wma',
] as const;

/** The `accept` attribute for the file input and the drop zone. */
export const AUDIO_ACCEPT_ATTRIBUTE = ['audio/*', ...ACCEPTED_AUDIO_EXTENSIONS].join(',');

/** `"recording 2024-05-01.m4a"` → `"recording 2024-05-01"`. */
export function titleFromFileName(fileName: string): string {
  const trimmed = fileName.trim();
  const dot = trimmed.lastIndexOf('.');
  // A leading dot is the whole name of a dotfile, not an extension — and an
  // extension-less name has nothing to strip.
  const base = dot > 0 ? trimmed.slice(0, dot) : trimmed;
  return base || trimmed;
}

/** Lowercase extension including the dot, or `''`. */
export function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot > 0 ? fileName.slice(dot).toLowerCase() : '';
}

export interface FileCheckResult {
  ok: boolean;
  /** The sentence shown to the user. `null` when `ok`. */
  error: string | null;
}

/**
 * Is this file one this deployment can accept?
 *
 * TYPE FIRST, THEN SIZE, because the two failures want different words and a
 * `.docx` that is also too large should be rejected for being a `.docx`.
 *
 * The type test is deliberately GENEROUS: it passes when the browser reports
 * any `audio/*` type OR when the extension is one of ours. A file whose type is
 * `''` and whose extension is `.m4a` is the ordinary iPhone voice memo, and
 * refusing it would refuse the single most common input this feature has.
 */
export function checkAudioFile(
  file: { name: string; size: number; type: string },
  maxUploadBytes: number,
): FileCheckResult {
  const extension = extensionOf(file.name);
  const looksLikeAudio =
    file.type.startsWith('audio/') ||
    (ACCEPTED_AUDIO_EXTENSIONS as readonly string[]).includes(extension);

  if (!looksLikeAudio) {
    return {
      ok: false,
      error: `${file.name} does not look like an audio file. Accepted formats: ${ACCEPTED_AUDIO_EXTENSIONS.join(', ')}.`,
    };
  }

  // `maxUploadBytes` is 0 when no provider is usable — the config endpoint says
  // so explicitly — and treating 0 as "nothing may be uploaded" here would
  // produce a confusing size error on a screen that is already showing the
  // not-configured state for the real reason.
  if (maxUploadBytes > 0 && file.size > maxUploadBytes) {
    return {
      ok: false,
      error: `This file is ${formatMegabytes(file.size)}, and the limit is ${formatMegabytes(maxUploadBytes)}.`,
    };
  }

  return { ok: true, error: null };
}

/**
 * Is the measured duration within the provider's ceiling?
 *
 * BEST-EFFORT, and separate from `checkAudioFile` for that reason: the duration
 * comes from asking a hidden `<audio>` element to load the file's metadata,
 * which fails silently for a container the browser cannot parse — the exact
 * case the server-side transcode exists to handle. A `null` duration therefore
 * means "could not tell", and "could not tell" must never mean "rejected".
 */
export function checkAudioDuration(
  durationMs: number | null,
  maxDurationMs: number,
): FileCheckResult {
  if (durationMs === null || maxDurationMs <= 0) return { ok: true, error: null };
  if (durationMs <= maxDurationMs) return { ok: true, error: null };

  const hours = (maxDurationMs / 3_600_000).toFixed(1).replace(/\.0$/, '');
  return {
    ok: false,
    error: `This recording is longer than the ${hours}-hour limit for the configured transcription service.`,
  };
}

/** Megabytes, one decimal, decimal units — what a file manager shows. */
export function formatMegabytes(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

/**
 * Read a media file's duration through a throwaway `<audio>` element.
 *
 * Resolves `null` rather than rejecting on every failure path — an unsupported
 * container, a browser that reports `Infinity` for a stream with no known
 * length, a metadata load that simply never completes. The caller treats `null`
 * as "no opinion" (see `checkAudioDuration`), so a probe that cannot answer
 * costs the user nothing.
 *
 * The object URL is revoked on every path. Without that, picking a dozen files
 * in one session pins a dozen multi-gigabyte blobs in memory for the life of
 * the document.
 */
export function probeAudioDurationMs(
  file: File,
  timeoutMs = 5_000,
): Promise<number | null> {
  return new Promise((resolve) => {
    if (typeof document === 'undefined' || typeof URL?.createObjectURL !== 'function') {
      resolve(null);
      return;
    }

    let settled = false;
    const url = URL.createObjectURL(file);
    const audio = document.createElement('audio');

    const finish = (value: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      audio.removeAttribute('src');
      URL.revokeObjectURL(url);
      resolve(value);
    };

    // A hard ceiling, because `loadedmetadata` genuinely never fires for some
    // containers in some browsers — there is no error event for "I am still
    // thinking about it", and a hung promise here would hang the wizard.
    const timer = setTimeout(() => finish(null), timeoutMs);

    audio.preload = 'metadata';
    audio.onloadedmetadata = () => {
      const seconds = audio.duration;
      finish(Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : null);
    };
    audio.onerror = () => finish(null);
    audio.src = url;
  });
}

/**
 * Languages the form offers, beyond "detect automatically".
 *
 * A SHORT LIST, not an exhaustive one. The API takes any BCP-47-ish string and
 * the provider's own detection is the default and usually right; this exists
 * for the case where detection is known to be wrong (a bilingual recording, a
 * heavy accent) and the user knows better. A 180-entry dropdown would make the
 * common case — leaving it alone — harder to see.
 */
export const TRANSCRIPT_LANGUAGES: readonly { value: string; label: string }[] = [
  { value: 'en', label: 'English' },
  { value: 'es', label: 'Spanish' },
  { value: 'fr', label: 'French' },
  { value: 'de', label: 'German' },
  { value: 'it', label: 'Italian' },
  { value: 'pt', label: 'Portuguese' },
  { value: 'nl', label: 'Dutch' },
  { value: 'ja', label: 'Japanese' },
  { value: 'ko', label: 'Korean' },
  { value: 'zh', label: 'Chinese' },
  { value: 'hi', label: 'Hindi' },
];

/** Expected-speaker choices. The API accepts 1–50; the form offers 1–10. */
export const SPEAKER_COUNT_OPTIONS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;

/** Bytes per second → "1.4 MB/s". */
export function formatSpeed(bytesPerSecond: number): string {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return '—';
  if (bytesPerSecond < 1_000_000) return `${Math.round(bytesPerSecond / 1000)} kB/s`;
  return `${(bytesPerSecond / 1_000_000).toFixed(1)} MB/s`;
}

/** Seconds remaining → "about 4 min left". `null` before a speed is known. */
export function formatEta(etaSeconds: number | null): string {
  if (etaSeconds === null || !Number.isFinite(etaSeconds) || etaSeconds < 0) {
    return 'Estimating…';
  }
  if (etaSeconds < 60) return `about ${Math.max(1, Math.round(etaSeconds))} sec left`;
  const minutes = Math.round(etaSeconds / 60);
  if (minutes < 60) return `about ${minutes} min left`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder === 0
    ? `about ${hours} hr left`
    : `about ${hours} hr ${remainder} min left`;
}

// -----------------------------------------------------------------------------
// Keyterms (#327, epic #326)
// -----------------------------------------------------------------------------

/** Longest single keyterm, in characters — mirrors the API's `MAX_KEYTERM_LENGTH`. */
export const MAX_KEYTERM_LENGTH = 100;

/** Most words one keyterm may contain — mirrors the API's `MAX_KEYTERM_WORDS`. */
export const MAX_KEYTERM_WORDS = 6;

/** Trim and collapse internal whitespace, exactly as the server normalises. */
export function normalizeKeyterm(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ');
}

/** Split a typed or pasted list on commas and newlines. Empties are dropped. */
export function splitKeytermInput(text: string): string[] {
  return text
    .split(/[,\n\r]+/)
    .map(normalizeKeyterm)
    .filter((term) => term.length > 0);
}

export interface AddKeytermsResult {
  /** The list after every acceptable candidate was appended. */
  terms: string[];
  /** Why a candidate was refused, or `null` when nothing was. The FIRST refusal wins. */
  error: string | null;
}

/**
 * Append `candidates` to `current`, enforcing the API's limits client-side so a
 * refusal is shown at the field rather than as a 400 after the user pressed
 * Start. A case-insensitive duplicate is skipped silently — keeping the first
 * spelling, as the server does — because it is not a mistake worth scolding.
 */
export function addKeyterms(
  current: readonly string[],
  candidates: readonly string[],
  maxKeyterms: number,
): AddKeytermsResult {
  const terms = [...current];
  const seen = new Set(terms.map((term) => term.toLowerCase()));
  let error: string | null = null;

  for (const raw of candidates) {
    const term = normalizeKeyterm(raw);
    if (term.length === 0) continue;
    if (seen.has(term.toLowerCase())) continue;

    let refusal: string | null = null;
    if (term.length > MAX_KEYTERM_LENGTH) {
      refusal = `"${term.slice(0, 40)}…" is longer than ${MAX_KEYTERM_LENGTH} characters.`;
    } else if (term.split(' ').length > MAX_KEYTERM_WORDS) {
      refusal = `"${term}" has more than ${MAX_KEYTERM_WORDS} words — use a shorter phrase.`;
    } else if (terms.length >= maxKeyterms) {
      refusal = `At most ${maxKeyterms} names and terms can be added.`;
    }

    if (refusal) {
      error ??= refusal;
      continue;
    }

    seen.add(term.toLowerCase());
    terms.push(term);
  }

  return { terms, error };
}
