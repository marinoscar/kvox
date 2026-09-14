import { describe, it, expect, vi, afterEach } from 'vitest';

import {
  ACCEPTED_AUDIO_EXTENSIONS,
  AUDIO_ACCEPT_ATTRIBUTE,
  checkAudioDuration,
  checkAudioFile,
  extensionOf,
  formatEta,
  formatMegabytes,
  formatSpeed,
  probeAudioDurationMs,
  titleFromFileName,
} from '../../pages/newTranscript';

/**
 * The New-transcript screen's decisions, without a file picker.
 *
 * These are usability checks, not a security boundary — `POST /api/transcripts`
 * re-checks the size and the multipart completion checks the real byte count —
 * so what they have to get right is being GENEROUS in the right places: a
 * `.m4a` whose browser-reported type is empty is the single most common input
 * this feature has.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the accept attribute', () => {
  it('carries the wildcard AND every extension', () => {
    // The wildcard alone greys out exactly the files a voice-memo user is
    // trying to select: browsers derive `type` from an OS table that is
    // missing `.m4a` on Windows and `.amr` almost everywhere.
    expect(AUDIO_ACCEPT_ATTRIBUTE).toContain('audio/*');
    for (const extension of ACCEPTED_AUDIO_EXTENSIONS) {
      expect(AUDIO_ACCEPT_ATTRIBUTE).toContain(extension);
    }
  });

  it('names the ten formats the issue specifies', () => {
    expect([...ACCEPTED_AUDIO_EXTENSIONS]).toEqual([
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
    ]);
  });
});

describe('titleFromFileName', () => {
  it('strips the extension', () => {
    expect(titleFromFileName('standup 2026-01-02.m4a')).toBe('standup 2026-01-02');
  });

  it('leaves an extension-less name alone', () => {
    expect(titleFromFileName('recording')).toBe('recording');
  });

  it('treats a leading dot as the whole name, not as an extension', () => {
    // `.hidden` has no extension to strip; slicing at index 0 would produce an
    // empty title and a blank field the user has to notice and fix.
    expect(titleFromFileName('.hidden')).toBe('.hidden');
  });
});

describe('extensionOf', () => {
  it('lowercases and includes the dot', () => {
    expect(extensionOf('Recording.M4A')).toBe('.m4a');
  });

  it('answers empty for a name with no extension', () => {
    expect(extensionOf('recording')).toBe('');
    expect(extensionOf('.hidden')).toBe('');
  });
});

describe('checkAudioFile — type', () => {
  const MAX = 100_000_000;

  it('accepts a file the browser calls audio/*', () => {
    expect(
      checkAudioFile({ name: 'a.mp3', size: 1000, type: 'audio/mpeg' }, MAX).ok,
    ).toBe(true);
  });

  it('accepts a .m4a whose reported type is EMPTY', () => {
    // The ordinary iPhone voice memo. Refusing it would refuse the single most
    // common input this feature has.
    expect(checkAudioFile({ name: 'memo.m4a', size: 1000, type: '' }, MAX).ok).toBe(true);
  });

  it('accepts a .amr, which almost no platform has a MIME entry for', () => {
    expect(checkAudioFile({ name: 'call.amr', size: 1000, type: '' }, MAX).ok).toBe(true);
  });

  it('rejects a document, naming the accepted formats', () => {
    const result = checkAudioFile(
      { name: 'notes.docx', size: 1000, type: 'application/vnd.openxmlformats' },
      MAX,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain('.m4a');
  });

  it('rejects on TYPE first, even when the file is also too large', () => {
    // A `.docx` that is also 2 GB should be refused for being a `.docx`; the
    // size message would send the user off to compress the wrong thing.
    const result = checkAudioFile(
      { name: 'notes.docx', size: 2_000_000_000, type: 'application/msword' },
      MAX,
    );
    expect(result.error).toContain('does not look like an audio file');
  });
});

describe('checkAudioFile — size', () => {
  it('rejects a file over the ceiling, quoting both numbers', () => {
    const result = checkAudioFile(
      { name: 'long.mp3', size: 250_000_000, type: 'audio/mpeg' },
      100_000_000,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain('250.0 MB');
    expect(result.error).toContain('100.0 MB');
  });

  it('accepts a file exactly AT the ceiling', () => {
    expect(
      checkAudioFile({ name: 'x.mp3', size: 100, type: 'audio/mpeg' }, 100).ok,
    ).toBe(true);
  });

  it('treats a ceiling of 0 as "no opinion", not as "nothing may be uploaded"', () => {
    // `maxUploadBytes` is 0 when no provider is usable, which the screen
    // already reports for the real reason — a confusing size error on top of
    // the not-configured state would send the user off to compress a file.
    expect(
      checkAudioFile({ name: 'x.mp3', size: 999_999_999, type: 'audio/mpeg' }, 0).ok,
    ).toBe(true);
  });
});

describe('checkAudioDuration', () => {
  const TWO_HOURS = 7_200_000;

  it('accepts a recording within the ceiling', () => {
    expect(checkAudioDuration(3_600_000, TWO_HOURS).ok).toBe(true);
  });

  it('rejects one past it, naming the limit in hours', () => {
    const result = checkAudioDuration(10_000_000, TWO_HOURS);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('2-hour');
  });

  it('accepts when the duration could not be measured', () => {
    // `null` means "could not tell" — an unsupported container, which is
    // exactly the case the server-side transcode exists to handle. "Could not
    // tell" must never mean "rejected".
    expect(checkAudioDuration(null, TWO_HOURS).ok).toBe(true);
  });

  it('accepts when the provider declares no duration ceiling', () => {
    expect(checkAudioDuration(99_999_999, 0).ok).toBe(true);
  });
});

describe('probeAudioDurationMs', () => {
  /** A minimal fake element `document.createElement('audio')` will hand back. */
  function stubAudioElement(): Record<string, unknown> {
    const element: Record<string, unknown> = {
      preload: '',
      duration: Number.NaN,
      onloadedmetadata: null,
      onerror: null,
      removeAttribute: vi.fn(),
    };
    Object.defineProperty(element, 'src', {
      set() {
        /* assignment is what a real element would act on */
      },
      configurable: true,
    });
    return element;
  }

  function installProbeStubs(element: Record<string, unknown>) {
    vi.spyOn(document, 'createElement').mockReturnValue(
      element as unknown as HTMLElement,
    );
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: vi.fn(() => 'blob:fake'),
      revokeObjectURL: vi.fn(),
    });
  }

  it('reports the measured duration in milliseconds', async () => {
    const element = stubAudioElement();
    installProbeStubs(element);

    const promise = probeAudioDurationMs(new File([], 'a.m4a'));
    element.duration = 12.5;
    (element.onloadedmetadata as () => void)();

    await expect(promise).resolves.toBe(12_500);
    vi.unstubAllGlobals();
  });

  it('answers null — never rejects — when the browser cannot parse the file', async () => {
    const element = stubAudioElement();
    installProbeStubs(element);

    const promise = probeAudioDurationMs(new File([], 'a.amr'));
    (element.onerror as () => void)();

    await expect(promise).resolves.toBeNull();
    vi.unstubAllGlobals();
  });

  it('answers null for a duration of Infinity', async () => {
    // What a stream with no known length reports. Treating it as a real number
    // would compare Infinity against the ceiling and reject every such file.
    const element = stubAudioElement();
    installProbeStubs(element);

    const promise = probeAudioDurationMs(new File([], 'a.webm'));
    element.duration = Number.POSITIVE_INFINITY;
    (element.onloadedmetadata as () => void)();

    await expect(promise).resolves.toBeNull();
    vi.unstubAllGlobals();
  });

  it('gives up after its timeout rather than hanging the wizard', async () => {
    // `loadedmetadata` genuinely never fires for some containers, and there is
    // no "still thinking about it" event to distinguish that from slowness.
    vi.useFakeTimers();
    const element = stubAudioElement();
    installProbeStubs(element);

    const promise = probeAudioDurationMs(new File([], 'a.wma'), 1000);
    await vi.advanceTimersByTimeAsync(1100);

    await expect(promise).resolves.toBeNull();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('revokes the object URL on every path', async () => {
    // Without this, picking a dozen files in one session pins a dozen
    // multi-gigabyte blobs in memory for the life of the document.
    const element = stubAudioElement();
    installProbeStubs(element);
    const revoke = (URL as unknown as { revokeObjectURL: ReturnType<typeof vi.fn> })
      .revokeObjectURL;

    const promise = probeAudioDurationMs(new File([], 'a.m4a'));
    (element.onerror as () => void)();
    await promise;

    expect(revoke).toHaveBeenCalledWith('blob:fake');
    vi.unstubAllGlobals();
  });
});

describe('progress formatting', () => {
  it('formats a speed in the unit a person reads', () => {
    expect(formatSpeed(250_000)).toBe('250 kB/s');
    expect(formatSpeed(1_400_000)).toBe('1.4 MB/s');
    expect(formatSpeed(0)).toBe('—');
  });

  it('says "Estimating…" before a speed has been measured', () => {
    // `etaSeconds` is legitimately null for the first few seconds of every
    // upload, and "0 sec left" there would be a promise the transfer breaks.
    expect(formatEta(null)).toBe('Estimating…');
  });

  it('formats an ETA in seconds, minutes and hours', () => {
    expect(formatEta(30)).toBe('about 30 sec left');
    expect(formatEta(240)).toBe('about 4 min left');
    expect(formatEta(7200)).toBe('about 2 hr left');
    expect(formatEta(5400)).toBe('about 1 hr 30 min left');
  });

  it('formats megabytes in decimal units, like a file manager', () => {
    expect(formatMegabytes(1_500_000)).toBe('1.5 MB');
  });
});
