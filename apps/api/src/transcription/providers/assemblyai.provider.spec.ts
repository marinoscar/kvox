import { Readable } from 'node:stream';

import { RateLimitError } from '../../jobs/rate-limit.error';
import { ProviderAuthError, ProviderInputError } from '../errors';
import { MAX_SEGMENT_MS } from '../normalized-transcript';
import { TranscriptionProviderRegistry } from '../transcription-provider.registry';
import { createProviderContext } from './transcription-provider.interface';
import {
  AssemblyAiProvider,
  normalizeAssemblyAiTranscript,
  type FetchLike,
  type FetchLikeResponse,
} from './assemblyai.provider';

import twoSpeakers from '../__fixtures__/assemblyai/two-speakers.json';
import longMonologue from '../__fixtures__/assemblyai/long-monologue.json';
import languageDetected from '../__fixtures__/assemblyai/language-detected.json';
import emptyResult from '../__fixtures__/assemblyai/empty.json';
import providerError from '../__fixtures__/assemblyai/provider-error.json';
import unpunctuated from '../__fixtures__/assemblyai/unpunctuated-monologue.json';

// =============================================================================
// AssemblyAI provider (issue #23, epic #19)
// =============================================================================
//
// TWO HALVES, TESTED DIFFERENTLY:
//
//   • NORMALIZATION, against recorded vendor JSON in `../__fixtures__`. Pure,
//     offline, no container. What these pin is the SHAPE this file expects — so
//     when the vendor changes a field name or a unit (the two things that
//     silently break a provider integration), it shows up here as a failing
//     assertion rather than as a transcript whose timings are 1000× wrong.
//
//   • ERROR MAPPING, against a fake `fetch`. Every branch of `assertOk` gets a
//     case, because the cost of getting one wrong is specific and bad: a
//     misclassified 429 fails a job permanently on a condition that was never
//     its fault, and a misclassified provider `error` status pays the vendor
//     twice for the same refusal.
//
// THE API KEY IS ASSERTED NEVER TO ESCAPE. Not just "we do not log it" as a
// comment — the fake `fetch` records every request, and the last describe block
// walks those records plus the probe's own output.
// =============================================================================

const API_KEY = 'aai-super-secret-key-value-9f2b';

/** One recorded request. */
interface RecordedCall {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
}

interface FakeFetch {
  impl: FetchLike;
  calls: RecordedCall[];
}

/**
 * One canned response.
 *
 * Declared rather than derived from `Partial<FetchLikeResponse>`, because
 * `headers` means two different things on the two sides: the real response
 * exposes a `get(name)` accessor, while a test wants to write a plain object
 * of header names. Intersecting the two types produces something no literal
 * can satisfy.
 */
interface CannedResponse {
  ok?: boolean;
  status?: number;
  headers?: Record<string, string>;
  text?: () => Promise<string>;
  json?: () => Promise<unknown>;
}

/**
 * A `fetch` that answers from a queue of canned responses.
 *
 * `headers.get` is case-insensitive, matching a real `Headers` instance — the
 * `Retry-After` tests depend on that, and a case-sensitive fake would make them
 * pass against a provider that only works if the vendor happens to lowercase.
 */
function fakeFetch(responses: CannedResponse[]): FakeFetch {
  const calls: RecordedCall[] = [];
  let index = 0;

  const impl: FetchLike = async (url, init): Promise<FetchLikeResponse> => {
    calls.push({
      url,
      method: init?.method,
      headers: init?.headers,
      body: init?.body,
    });

    const canned = responses[Math.min(index, responses.length - 1)];
    index += 1;

    const headerMap = new Map(
      Object.entries(canned.headers ?? {}).map(([key, value]) => [
        key.toLowerCase(),
        value,
      ]),
    );

    return {
      ok: canned.ok ?? true,
      status: canned.status ?? 200,
      headers: { get: (name: string) => headerMap.get(name.toLowerCase()) ?? null },
      text: canned.text ?? (async () => ''),
      json: canned.json ?? (async () => ({})),
    };
  };

  return { impl, calls };
}

function buildProvider(fetchImpl: FetchLike): AssemblyAiProvider {
  return new AssemblyAiProvider(new TranscriptionProviderRegistry(), fetchImpl);
}

function ctx(region: 'us' | 'eu' = 'us', speechModel = 'universal') {
  return createProviderContext(API_KEY, { region, speechModel });
}

// -----------------------------------------------------------------------------
// Normalization
// -----------------------------------------------------------------------------

describe('normalizeAssemblyAiTranscript', () => {
  describe('a two-speaker conversation', () => {
    const result = normalizeAssemblyAiTranscript(twoSpeakers, 'remote-1');

    it('lists both speakers, in first-appearance order', () => {
      expect(result.speakers).toEqual([{ label: 'A' }, { label: 'B' }]);
    });

    it("keeps the provider's speaker labels verbatim rather than renaming them", () => {
      // `A`/`B`, not `Speaker 1`/`Speaker 2`. Renaming here would bake a
      // presentation choice into stored data and leave a UI unable to show
      // what the provider actually said.
      expect(result.segments.map((s) => s.speakerLabel)).toEqual(['A', 'B', 'A']);
    });

    it('converts audio_duration from SECONDS to milliseconds', () => {
      // THE SINGLE MOST LIKELY PLACE FOR A VENDOR CHANGE TO GO UNNOTICED: the
      // fixture says 27.5 and word timings are already milliseconds, so a
      // missing conversion would put `durationMs: 27.5` next to segments
      // ending at 20000 and nothing would throw.
      expect(twoSpeakers.audio_duration).toBe(27.5);
      expect(result.durationMs).toBe(27_500);
    });

    it('reports the language and the model the provider actually used', () => {
      expect(result.language).toBe('en_us');
      expect(result.provider).toEqual({
        id: 'assemblyai',
        model: 'universal',
        remoteId: 'remote-1',
      });
    });

    it('carries word timings through untouched', () => {
      const first = result.segments[0];
      expect(first.words.length).toBeGreaterThan(0);
      expect(first.words[0].startMs).toBe(twoSpeakers.utterances[0].words[0].start);
      expect(first.startMs).toBe(twoSpeakers.utterances[0].start);
      expect(first.endMs).toBe(twoSpeakers.utterances[0].end);
    });

    it('leaves short utterances unsplit', () => {
      expect(result.segments).toHaveLength(twoSpeakers.utterances.length);
    });
  });

  describe('a long monologue', () => {
    const result = normalizeAssemblyAiTranscript(longMonologue, 'remote-2');
    const sourceWords = longMonologue.utterances[0].words;

    it('is one utterance in the fixture and longer than the segment ceiling', () => {
      // Guards the fixture itself: if it were shortened, every assertion below
      // would pass vacuously over an unsplit segment.
      expect(longMonologue.utterances).toHaveLength(1);
      expect(
        longMonologue.utterances[0].end - longMonologue.utterances[0].start,
      ).toBeGreaterThan(MAX_SEGMENT_MS);
    });

    it('splits it into several segments, none over the ceiling', () => {
      expect(result.segments.length).toBeGreaterThan(1);
      for (const segment of result.segments) {
        expect(segment.endMs - segment.startMs).toBeLessThanOrEqual(MAX_SEGMENT_MS);
      }
    });

    it('cuts at sentence punctuation', () => {
      // Every piece but the last ends on a terminator — which is the whole
      // point of preferring punctuation over a fixed width.
      for (const segment of result.segments.slice(0, -1)) {
        expect(segment.text.trim()).toMatch(/[.!?…]["')\]]*$/);
      }
    });

    it('partitions the words across the split — none duplicated, none dropped', () => {
      const flattened = result.segments.flatMap((segment) => segment.words);

      expect(flattened).toHaveLength(sourceWords.length);
      flattened.forEach((word, index) => {
        expect(word.text).toBe(sourceWords[index].text);
        expect(word.startMs).toBe(sourceWords[index].start);
        expect(word.endMs).toBe(sourceWords[index].end);
      });
    });

    it('keeps the one speaker on every piece', () => {
      expect(result.speakers).toEqual([{ label: 'A' }]);
      for (const segment of result.segments) {
        expect(segment.speakerLabel).toBe('A');
      }
    });

    it('tiles the original span exactly, with no gap and no overlap', () => {
      expect(result.segments[0].startMs).toBe(longMonologue.utterances[0].start);
      expect(result.segments[result.segments.length - 1].endMs).toBe(
        longMonologue.utterances[0].end,
      );
    });
  });

  describe('a long monologue with no punctuation at all', () => {
    const result = normalizeAssemblyAiTranscript(unpunctuated, 'remote-6');
    const sourceWords = unpunctuated.utterances[0].words;

    it('still splits, falling back to a word count', () => {
      expect(result.segments.length).toBeGreaterThan(1);
      for (const segment of result.segments) {
        expect(segment.endMs - segment.startMs).toBeLessThanOrEqual(MAX_SEGMENT_MS);
      }
    });

    it('partitions the words correctly on the fallback path too', () => {
      const flattened = result.segments.flatMap((segment) => segment.words);
      expect(flattened.map((w) => w.text)).toEqual(
        sourceWords.map((w) => w.text),
      );
    });
  });

  describe('language detection', () => {
    const result = normalizeAssemblyAiTranscript(languageDetected, 'remote-3');

    it('reports the language the provider detected', () => {
      expect(result.language).toBe('fr');
    });

    it('does not invent a language when the provider reported none', () => {
      const withoutLanguage = normalizeAssemblyAiTranscript(
        { ...languageDetected, language_code: null },
        'remote-3',
      );

      // `null`, never a default of `'en'`. Guessing the language here would
      // make a French transcript claim to be English with nothing to say so.
      expect(withoutLanguage.language).toBeNull();
    });
  });

  describe('an empty result', () => {
    const result = normalizeAssemblyAiTranscript(emptyResult, 'remote-4');

    it('produces no segments and no speakers rather than throwing', () => {
      // A completed job with nothing in it is a real outcome (silence, a track
      // with no speech), and it has to normalize to an empty transcript rather
      // than to an exception — the job succeeded.
      expect(result.segments).toEqual([]);
      expect(result.speakers).toEqual([]);
    });

    it('still reports the provider block, so the record is addressable', () => {
      expect(result.provider.remoteId).toBe('remote-4');
      expect(result.durationMs).toBe(0);
    });
  });

  describe('a response with words but no utterances (diarization off)', () => {
    const body = {
      status: 'completed',
      audio_duration: 3,
      language_code: 'en_us',
      speech_model: 'universal',
      text: 'one two three.',
      words: [
        { text: 'one', start: 0, end: 400, confidence: 0.9 },
        { text: 'two', start: 500, end: 900, confidence: 0.8 },
        { text: 'three.', start: 1000, end: 1400, confidence: 0.95 },
      ],
    };

    it('falls back to one segment carrying every word', () => {
      const result = normalizeAssemblyAiTranscript(body, 'remote-5');

      expect(result.segments).toHaveLength(1);
      expect(result.segments[0].words).toHaveLength(3);
      expect(result.segments[0].startMs).toBe(0);
      expect(result.segments[0].endMs).toBe(1400);
    });

    it('labels the speaker "unknown" rather than inventing turns from pauses', () => {
      // Inventing speaker turns would be this application asserting something
      // the provider declined to.
      const result = normalizeAssemblyAiTranscript(body, 'remote-5');
      expect(result.speakers).toEqual([{ label: 'unknown' }]);
    });
  });
});

// -----------------------------------------------------------------------------
// testConnection
// -----------------------------------------------------------------------------

describe('AssemblyAiProvider.testConnection', () => {
  it('reports success with a latency and the region it reached', async () => {
    const fetch = fakeFetch([{ ok: true, status: 200, json: async () => ({}) }]);
    const result = await buildProvider(fetch.impl).testConnection(ctx('us'));

    expect(result.ok).toBe(true);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.detail).toContain('US');
    expect(fetch.calls[0].url).toBe(
      'https://api.assemblyai.com/v2/transcript?limit=1',
    );
  });

  it('names BOTH a wrong key and a wrong region on a 401', async () => {
    // The vendor cannot tell those two apart, so a message that names only one
    // of them sends an administrator to fix the wrong thing half the time.
    const fetch = fakeFetch([{ ok: false, status: 401, text: async () => 'Unauthorized' }]);
    const result = await buildProvider(fetch.impl).testConnection(ctx('us'));

    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/key is wrong/i);
    expect(result.detail).toMatch(/other region/i);
  });

  it('reaches the EU host when the region says eu, and distinguishes a wrong-region key', async () => {
    const fetch = fakeFetch([{ ok: false, status: 401, text: async () => 'Unauthorized' }]);
    const result = await buildProvider(fetch.impl).testConnection(ctx('eu'));

    expect(fetch.calls[0].url).toBe(
      'https://api.eu.assemblyai.com/v2/transcript?limit=1',
    );
    expect(result.detail).toContain('EU');
  });

  it('says the configuration is fine when the account is merely rate-limited', async () => {
    // A 429 during a probe is NOT a misconfiguration, and reporting it as one
    // sends an administrator to rotate a key that works.
    const fetch = fakeFetch([{ ok: false, status: 429 }]);
    const result = await buildProvider(fetch.impl).testConnection(ctx());

    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/rate-limited/i);
    expect(result.detail).toMatch(/nothing is wrong with the configuration/i);
  });

  it('reports a network failure as a network failure, not a credential failure', async () => {
    const failing: FetchLike = async () => {
      throw new Error('getaddrinfo ENOTFOUND api.assemblyai.com');
    };

    const result = await buildProvider(failing).testConnection(ctx());

    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/network or DNS/i);
    expect(result.detail).toContain('ENOTFOUND');
    // And it must NOT read as an authentication problem — the fix is a network
    // fix, and conflating the two is the single most expensive wrong turn an
    // administrator can be sent on from this screen.
    expect(result.detail).not.toMatch(/key is wrong/i);
  });

  it('never throws, whatever the transport does', async () => {
    const exploding: FetchLike = async () => {
      throw 'not even an Error';
    };

    await expect(
      buildProvider(exploding).testConnection(ctx()),
    ).resolves.toMatchObject({ ok: false });
  });
});

// -----------------------------------------------------------------------------
// Error mapping
// -----------------------------------------------------------------------------

describe('AssemblyAiProvider error mapping', () => {
  const request = {
    audio: { kind: 'url' as const, url: 'https://storage.invalid/a.mp3' },
    options: { detectLanguage: true },
  };

  it('maps 401 to ProviderAuthError', async () => {
    const fetch = fakeFetch([{ ok: false, status: 401, text: async () => 'Unauthorized' }]);

    await expect(
      buildProvider(fetch.impl).submit(ctx(), request),
    ).rejects.toBeInstanceOf(ProviderAuthError);
  });

  it('maps 403 to ProviderAuthError too', async () => {
    const fetch = fakeFetch([{ ok: false, status: 403, text: async () => 'Forbidden' }]);

    await expect(
      buildProvider(fetch.impl).submit(ctx(), request),
    ).rejects.toBeInstanceOf(ProviderAuthError);
  });

  it('maps 429 with Retry-After in SECONDS to a RateLimitError carrying that delay', async () => {
    const fetch = fakeFetch([
      { ok: false, status: 429, headers: { 'Retry-After': '120' } },
    ]);

    await expect(
      buildProvider(fetch.impl).submit(ctx(), request),
    ).rejects.toMatchObject({
      name: 'RateLimitError',
      retryAfterMs: 120_000,
    });
  });

  it('maps 429 with an HTTP-DATE Retry-After to a RateLimitError with a positive delay', async () => {
    // RFC 9110 allows both forms and providers genuinely use both. Reading the
    // date form as unparseable would silently drop the vendor's own guidance.
    const when = new Date(Date.now() + 90_000).toUTCString();
    const fetch = fakeFetch([
      { ok: false, status: 429, headers: { 'retry-after': when } },
    ]);

    let thrown: unknown;
    try {
      await buildProvider(fetch.impl).submit(ctx(), request);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(RateLimitError);
    const retryAfterMs = (thrown as RateLimitError).retryAfterMs;
    expect(retryAfterMs).toBeGreaterThan(30_000);
    expect(retryAfterMs).toBeLessThanOrEqual(90_000);
  });

  it('maps 429 with NO Retry-After to a RateLimitError with no opinion — never zero', async () => {
    const fetch = fakeFetch([{ ok: false, status: 429 }]);

    let thrown: unknown;
    try {
      await buildProvider(fetch.impl).submit(ctx(), request);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(RateLimitError);
    // `undefined`, NOT 0. Zero is read downstream as "retry immediately",
    // which is the one thing a throttled caller must not do.
    expect((thrown as RateLimitError).retryAfterMs).toBeUndefined();
    expect((thrown as RateLimitError).retryAfterMs).not.toBe(0);
  });

  it('maps a provider `status: "error"` body to ProviderInputError, carrying the reason', async () => {
    const fetch = fakeFetch([{ ok: true, status: 200, json: async () => providerError }]);

    let thrown: unknown;
    try {
      await buildProvider(fetch.impl).fetchResult(ctx(), 'remote-9');
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(ProviderInputError);
    expect((thrown as ProviderInputError).providerMessage).toBe(
      'Audio file does not appear to contain audio.',
    );
    // The vendor's explanation reaches the message too, because "silent",
    // "truncated" and "not audio" need different fixes and `lastError` is
    // where an operator reads them.
    expect((thrown as Error).message).toContain('does not appear to contain audio');
  });

  it('does not classify a provider error as a rate limit or an auth failure', async () => {
    const fetch = fakeFetch([{ ok: true, status: 200, json: async () => providerError }]);

    let thrown: unknown;
    try {
      await buildProvider(fetch.impl).fetchResult(ctx(), 'remote-9');
    } catch (err) {
      thrown = err;
    }

    // Retrying a domain error is a second upload and a second charge for an
    // answer already known.
    expect(thrown).not.toBeInstanceOf(RateLimitError);
    expect(thrown).not.toBeInstanceOf(ProviderAuthError);
  });

  it('maps a 5xx to a plain retryable Error', async () => {
    const fetch = fakeFetch([
      { ok: false, status: 503, text: async () => 'upstream unavailable' },
    ]);

    let thrown: unknown;
    try {
      await buildProvider(fetch.impl).submit(ctx(), request);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(ProviderAuthError);
    expect(thrown).not.toBeInstanceOf(ProviderInputError);
    expect(thrown).not.toBeInstanceOf(RateLimitError);
    expect((thrown as Error).message).toContain('503');
  });

  it('bounds the error body it quotes', async () => {
    const fetch = fakeFetch([
      { ok: false, status: 500, text: async () => 'x'.repeat(10_000) },
    ]);

    let thrown: unknown;
    try {
      await buildProvider(fetch.impl).submit(ctx(), request);
    } catch (err) {
      thrown = err;
    }

    // This message reaches `Job.lastError` and a log line; a ten-kilobyte HTML
    // error page in a database column helps nobody.
    expect((thrown as Error).message.length).toBeLessThan(1000);
  });

  it('survives a response body that will not read', async () => {
    const fetch = fakeFetch([
      {
        ok: false,
        status: 502,
        text: async () => {
          throw new Error('socket hang up');
        },
      },
    ]);

    // A throw from inside error-reporting would replace a useful message with
    // a useless one and lose the status code, which is the part that matters.
    await expect(buildProvider(fetch.impl).submit(ctx(), request)).rejects.toThrow(
      /502/,
    );
  });
});

// -----------------------------------------------------------------------------
// Lifecycle
// -----------------------------------------------------------------------------

describe('AssemblyAiProvider job lifecycle', () => {
  it('submits with diarization, the configured model and language detection', async () => {
    const fetch = fakeFetch([
      { ok: true, status: 200, json: async () => ({ id: 'abc123' }) },
    ]);

    const result = await buildProvider(fetch.impl).submit(ctx('eu', 'slam-1'), {
      audio: { kind: 'url', url: 'https://storage.invalid/a.mp3' },
      options: { detectLanguage: true, speakersExpected: 3 },
    });

    expect(result).toEqual({ remoteId: 'abc123' });

    const body = JSON.parse(fetch.calls[0].body as string);
    expect(body).toEqual({
      audio_url: 'https://storage.invalid/a.mp3',
      speaker_labels: true,
      speech_models: ['universal-3-5-pro', 'universal-2'],
      language_detection: true,
      speakers_expected: 3,
    });
    expect(fetch.calls[0].url).toBe('https://api.eu.assemblyai.com/v2/transcript');
  });

  it('sends language_code OR language_detection, never both', async () => {
    // The vendor rejects a request carrying both, so resolving the conflict
    // here means a caller can pass a `defaultLanguage` and `detectLanguage`
    // from two different settings without having to know they conflict.
    const fetch = fakeFetch([
      { ok: true, status: 200, json: async () => ({ id: 'abc123' }) },
    ]);

    await buildProvider(fetch.impl).submit(ctx(), {
      audio: { kind: 'url', url: 'https://storage.invalid/a.mp3' },
      options: { language: 'de', detectLanguage: true },
    });

    const body = JSON.parse(fetch.calls[0].body as string);
    expect(body.language_code).toBe('de');
    expect(body).not.toHaveProperty('language_detection');
  });

  it('omits speakers_expected when there is no opinion', async () => {
    const fetch = fakeFetch([
      { ok: true, status: 200, json: async () => ({ id: 'abc123' }) },
    ]);

    await buildProvider(fetch.impl).submit(ctx(), {
      audio: { kind: 'url', url: 'https://storage.invalid/a.mp3' },
      options: { detectLanguage: false, speakersExpected: null },
    });

    expect(JSON.parse(fetch.calls[0].body as string)).not.toHaveProperty(
      'speakers_expected',
    );
  });

  it('uploads the bytes first for a stream source, then submits the upload_url', async () => {
    const fetch = fakeFetch([
      {
        ok: true,
        status: 200,
        json: async () => ({ upload_url: 'https://cdn.assemblyai.invalid/u/1' }),
      },
      { ok: true, status: 200, json: async () => ({ id: 'abc123' }) },
    ]);

    await buildProvider(fetch.impl).submit(ctx(), {
      audio: {
        kind: 'stream',
        stream: Readable.from(['bytes']),
        size: 5,
        mimeType: 'audio/mpeg',
      },
      options: { detectLanguage: true },
    });

    expect(fetch.calls[0].url).toBe('https://api.assemblyai.com/v2/upload');
    // `content-length` because the endpoint rejects a chunked body of unknown
    // size, and `duplex: 'half'` because undici refuses a streaming request
    // body without it — with an error that names neither.
    expect(fetch.calls[0].headers).toMatchObject({ 'content-length': '5' });

    const submitBody = JSON.parse(fetch.calls[1].body as string);
    expect(submitBody.audio_url).toBe('https://cdn.assemblyai.invalid/u/1');
  });

  it('rejects a 2xx submission that carried no id, retryably', async () => {
    const fetch = fakeFetch([{ ok: true, status: 200, json: async () => ({}) }]);

    await expect(
      buildProvider(fetch.impl).submit(ctx(), {
        audio: { kind: 'url', url: 'https://storage.invalid/a.mp3' },
        options: { detectLanguage: true },
      }),
    ).rejects.toThrow(/no transcript id/i);
  });

  it.each([
    ['queued', 'queued'],
    ['processing', 'processing'],
    ['completed', 'completed'],
    ['error', 'failed'],
  ])("maps the provider status %s to %s", async (providerStatus, expected) => {
    const fetch = fakeFetch([
      { ok: true, status: 200, json: async () => ({ status: providerStatus }) },
    ]);

    await expect(
      buildProvider(fetch.impl).getStatus(ctx(), 'remote-1'),
    ).resolves.toBe(expected);
  });

  it('treats an unrecognised status as still processing, not as a failure', async () => {
    // Reporting it as `failed` would abandon a job over a vocabulary the
    // vendor widened; treating it as in-flight costs one more poll and
    // self-corrects.
    const fetch = fakeFetch([
      { ok: true, status: 200, json: async () => ({ status: 'transcoding' }) },
    ]);

    await expect(
      buildProvider(fetch.impl).getStatus(ctx(), 'remote-1'),
    ).resolves.toBe('processing');
  });

  it('refuses to normalize a job that is not finished', async () => {
    const fetch = fakeFetch([
      { ok: true, status: 200, json: async () => ({ status: 'processing' }) },
    ]);

    await expect(
      buildProvider(fetch.impl).fetchResult(ctx(), 'remote-1'),
    ).rejects.toThrow(/not finished/i);
  });

  it('returns the raw body alongside the normalized one', async () => {
    const fetch = fakeFetch([{ ok: true, status: 200, json: async () => twoSpeakers }]);

    const result = await buildProvider(fetch.impl).fetchResult(ctx(), 'remote-1');

    // A normalization bug that drops a field must be repairable from data
    // already paid for, rather than by re-running the job.
    expect(result.raw).toEqual(twoSpeakers);
    expect(result.normalized.segments).toHaveLength(3);
  });

  it('treats an already-deleted transcript as a successful delete', async () => {
    const fetch = fakeFetch([{ ok: false, status: 404 }]);

    // The caller's goal is "this is not on the vendor's servers", and a 404
    // means that goal is met. Turning it into an error would make a retried
    // ingest fail on its cleanup step.
    await expect(
      buildProvider(fetch.impl).deleteRemote(ctx(), 'remote-1'),
    ).resolves.toBeUndefined();
  });

  it('issues a DELETE against the region-correct URL', async () => {
    const fetch = fakeFetch([{ ok: true, status: 200 }]);

    await buildProvider(fetch.impl).deleteRemote(ctx('eu'), 'remote/1');

    expect(fetch.calls[0].method).toBe('DELETE');
    // The id is URL-encoded, so a provider id containing a slash cannot escape
    // the path it belongs in.
    expect(fetch.calls[0].url).toBe(
      'https://api.eu.assemblyai.com/v2/transcript/remote%2F1',
    );
  });
});

// -----------------------------------------------------------------------------
// The key never escapes
// -----------------------------------------------------------------------------

describe('the API key', () => {
  it('is sent in `authorization` with NO Bearer prefix', async () => {
    // The vendor's scheme, and easy to "fix" into a bearer token — which
    // produces a 401 that looks exactly like a wrong key.
    const fetch = fakeFetch([{ ok: true, status: 200, json: async () => ({}) }]);
    await buildProvider(fetch.impl).testConnection(ctx());

    expect(fetch.calls[0].headers?.authorization).toBe(API_KEY);
    expect(fetch.calls[0].headers?.authorization).not.toMatch(/^Bearer /);
  });

  it('never appears in a testConnection detail, on any outcome', async () => {
    const outcomes: CannedResponse[] = [
      { ok: true, status: 200, json: async () => ({}) },
      { ok: false, status: 401, text: async () => 'Unauthorized' },
      { ok: false, status: 429 },
      { ok: false, status: 404 },
      { ok: false, status: 500, text: async () => 'boom' },
    ];

    for (const outcome of outcomes) {
      const fetch = fakeFetch([outcome]);
      const result = await buildProvider(fetch.impl).testConnection(ctx());
      expect(result.detail).not.toContain(API_KEY);
      expect(JSON.stringify(result)).not.toContain(API_KEY);
    }
  });

  it('never appears in a thrown error from any lifecycle method', async () => {
    const failures: CannedResponse[] = [
      { ok: false, status: 401, text: async () => 'Unauthorized' },
      { ok: false, status: 429 },
      { ok: false, status: 500, text: async () => 'boom' },
    ];

    for (const failure of failures) {
      const provider = buildProvider(fakeFetch([failure]).impl);

      let thrown: unknown;
      try {
        await provider.submit(ctx(), {
          audio: { kind: 'url', url: 'https://storage.invalid/a.mp3' },
          options: { detectLanguage: true },
        });
      } catch (err) {
        thrown = err;
      }

      // Guards the loop itself: a case that stopped throwing would otherwise
      // pass these assertions vacuously.
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).not.toContain(API_KEY);
      expect((thrown as Error).stack ?? '').not.toContain(API_KEY);
    }
  });

  it('is redacted when a provider context is serialised by accident', () => {
    // A backstop, not permission: the rule is still "never log a context". But
    // the most common accidental leak is a context reaching `JSON.stringify`
    // through a log serialiser or an error's `cause`, and this makes that
    // inert.
    const context = ctx();

    expect(JSON.stringify(context)).not.toContain(API_KEY);
    expect(JSON.stringify(context)).toContain('[redacted]');
    // The real value is still readable by the code that needs it.
    expect(context.apiKey).toBe(API_KEY);
  });
});
