import { TRANSCRIPTION_THROTTLE_KEY } from '../../core/index.js';
import { ProviderAuthError, ProviderInputError, RateLimitError } from '../errors.js';
import { createProviderContext } from '../provider-context.js';
import type {
  TranscriptionProvider,
  TranscriptionRequest,
} from '../providers/transcription-provider.interface.js';
import { TranscriptionProviderRegistry } from '../transcription-provider.registry.js';

// =============================================================================
// describeTranscriptionProviderConformance (issue #492, epic #491)
// =============================================================================
//
// The executable proof that a transcription provider is correct. The built-in
// AssemblyAI provider passes it (`transcription-provider.conformance.spec.ts`),
// and an extra provider registered through `extraProviders` runs it against its
// own class. Test-runner neutral: the caller hands over `describe`, `it` and
// `expect`, so it works under Jest and Vitest alike.
//
// WHAT NEEDS NO NETWORK runs always: identity, capabilities, the field
// descriptors, and the guarantee that a context never serialises its key.
//
// WHAT NEEDS THE UPSTREAM TO MISBEHAVE needs the caller to say how: a provider
// cannot be made to answer 401 from the outside. Each `scenarios` hook returns a
// provider wired to a transport that fails that way (for AssemblyAI, a fake
// `fetch`). A hook the author does not supply is skipped, and the rules that
// need it are not asserted: the kit never calls a vendor on its own.
// =============================================================================

/** A string no real credential looks like, used to prove a key never escapes. */
const SENTINEL_KEY = 'conformance-sentinel-key-do-not-use-0000';

/** The names a settings field must never have: a secret goes through the secrets port. */
const SECRET_FIELD_NAMES = /^(api[_-]?key|key|token|secret|password|authorization|access[_-]?key[_-]?id|secret[_-]?access[_-]?key)$/i;

/** The ids the settings and credential addresses accept. */
const PROVIDER_ID = /^[a-z][a-z0-9_-]*$/;

/** A request every provider accepts; the scenarios' transports fail before reading it. */
const REQUEST: TranscriptionRequest = {
  audio: { kind: 'url', url: 'https://storage.invalid/conformance.mp3' },
  options: { detectLanguage: true },
};

/**
 * The test runner's functions, so the kit runs under Jest or Vitest.
 *
 * @stability experimental
 */
export interface TranscriptionConformanceHarness {
  /** Opens a group of tests. */
  describe(name: string, fn: () => void): void;
  /** Declares one test. */
  it(name: string, fn: (...args: any[]) => any): void;
  /** Starts an assertion. */
  expect(actual: unknown): any;
}

/**
 * Providers wired to a misbehaving upstream, one per failure the contract names.
 * Every hook is optional.
 *
 * @stability experimental
 */
export interface TranscriptionConformanceScenarios {
  /** The upstream answers HTTP 401. `submit` and `testConnection` are exercised. */
  unauthorized?: () => TranscriptionProvider;
  /** The upstream answers HTTP 429 with no `Retry-After`. `submit` is exercised. */
  rateLimited?: () => TranscriptionProvider;
  /** The upstream reports that the job failed because of the input. `fetchResult` is exercised. */
  inputRejected?: () => TranscriptionProvider;
  /** The transport throws (DNS, reset). `testConnection` is exercised. */
  unreachable?: () => TranscriptionProvider;
}

/**
 * Options of {@link describeTranscriptionProviderConformance}.
 *
 * @stability experimental
 */
export interface TranscriptionConformanceOptions {
  /**
   * The failing upstreams.
   *
   * @extensionPoint
   */
  scenarios?: TranscriptionConformanceScenarios;
  /**
   * A valid settings block for the provider. Default: what its own
   * `settingsSchema` accepts for `{}`, which is enough for a provider with no
   * required setting.
   */
  settings?: unknown;
}

/** Awaits `run` and returns what it threw, or `undefined`. */
async function failureOf(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  return undefined;
}

/**
 * Registers the transcription provider conformance suite.
 *
 * @example
 * ```ts
 * describeTranscriptionProviderConformance(
 *   'assemblyai',
 *   () => new AssemblyAiProvider(new TranscriptionProviderRegistry(), fakeFetch(...)),
 *   { describe, it, expect },
 *   { scenarios: { unauthorized: () => providerOver(status(401)) }, settings: { region: 'us', speechModel: 'x' } },
 * );
 * ```
 *
 * @param name - what is under test, for the group title.
 * @param factory - builds the provider (a fresh one per call).
 * @param api - the test runner's `describe`, `it` and `expect`.
 * @param options - the failing upstreams and a valid settings block.
 * @stability experimental
 */
export function describeTranscriptionProviderConformance(
  name: string,
  factory: () => TranscriptionProvider,
  api: TranscriptionConformanceHarness,
  options: TranscriptionConformanceOptions = {},
): void {
  const { describe, it, expect } = api;
  const scenarios = options.scenarios ?? {};

  const settingsFor = (provider: TranscriptionProvider): unknown => {
    if (options.settings !== undefined) return options.settings;
    const parsed = provider.settingsSchema.safeParse({});
    return parsed.success ? parsed.data : {};
  };
  const contextFor = (provider: TranscriptionProvider) =>
    createProviderContext(SENTINEL_KEY, settingsFor(provider));

  describe(`transcription provider conformance: ${name}`, () => {
    describe('identity and capabilities', () => {
      it('has a stable id and a label', () => {
        const provider = factory();
        expect(typeof provider.id).toBe('string');
        expect(PROVIDER_ID.test(provider.id)).toBe(true);
        expect(typeof provider.label).toBe('string');
        expect(provider.label.trim().length > 0).toBe(true);
      });

      it('declares every capability, with usable limits', () => {
        const { capabilities: c } = factory();
        for (const flag of [
          'diarization',
          'wordTimestamps',
          'languageDetection',
          'speakersExpectedHint',
          'acceptsUrl',
          'acceptsUpload',
          'remoteDelete',
          'cancel',
        ] as const) {
          expect(`${flag}:${typeof c[flag]}`).toBe(`${flag}:boolean`);
        }
        expect(c.maxInputBytes > 0).toBe(true);
        expect(c.maxDurationMs > 0).toBe(true);
        expect(c.acceptedMimeTypes.length > 0).toBe(true);
        for (const mime of c.acceptedMimeTypes) expect(mime).toBe(mime.toLowerCase());
        // Required-but-nullable, never absent: an absent key would read as "unknown".
        expect(c.keyterms === null || (c.keyterms.maxTerms > 0 && c.keyterms.maxWordsPerTerm > 0)).toBe(true);
        // A way in for the audio, or the provider cannot be used at all.
        expect(c.acceptsUrl || c.acceptsUpload).toBe(true);
      });

      it('implements cancel exactly when it advertises it', () => {
        const provider = factory();
        expect(typeof provider.cancel === 'function').toBe(provider.capabilities.cancel);
      });

      it('registers with the provider registry', () => {
        const registry = new TranscriptionProviderRegistry();
        registry.register(factory());
        expect(registry.ids().length).toBe(1);
      });
    });

    describe('what the admin form is told', () => {
      it('describes fields that carry no secret and have unique keys', () => {
        const { fieldDescriptors } = factory();
        const keys = fieldDescriptors.map((field) => field.key);
        expect(new Set(keys).size).toBe(keys.length);
        for (const field of fieldDescriptors) {
          expect(`${field.key}:${SECRET_FIELD_NAMES.test(field.key)}`).toBe(`${field.key}:false`);
          if (field.type === 'select') expect((field.options ?? []).length > 0).toBe(true);
        }
      });

      it('publishes a description that is plain data and never mentions a key', () => {
        const registry = new TranscriptionProviderRegistry();
        registry.register(factory());
        const text = JSON.stringify(registry.describeAll());
        expect(text.includes(SENTINEL_KEY)).toBe(false);
        expect(Object.keys(registry.describeAll()[0]).sort()).toEqual(['capabilities', 'fieldDescriptors', 'id', 'label']);
      });

      it('validates its own settings block, and that schema accepts no secret field', () => {
        const provider = factory();
        expect(typeof provider.settingsSchema.safeParse).toBe('function');
        const withKey = provider.settingsSchema.safeParse({ ...(settingsFor(provider) as object), apiKey: SENTINEL_KEY });
        // Either refused, or stripped: the key must not survive the parse.
        expect(JSON.stringify(withKey.success ? withKey.data : {}).includes(SENTINEL_KEY)).toBe(false);
      });
    });

    describe('the context', () => {
      it('never serialises the key', () => {
        const context = contextFor(factory());
        expect(JSON.stringify(context).includes(SENTINEL_KEY)).toBe(false);
        expect(context.apiKey).toBe(SENTINEL_KEY);
      });
    });

    describe('testConnection', () => {
      const cases: Array<[string, (() => TranscriptionProvider) | undefined, boolean]> = [
        ['an upstream that refuses the key', scenarios.unauthorized, true],
        ['an upstream that throttles', scenarios.rateLimited, true],
        ['an unreachable upstream', scenarios.unreachable, true],
      ];

      for (const [label, build, mustFail] of cases) {
        if (!build) continue;

        it(`resolves rather than throws, and never echoes the key, against ${label}`, async () => {
          const provider = build();
          let result: unknown;
          const error = await failureOf(async () => {
            result = await provider.testConnection(contextFor(provider));
          });

          expect(error).toBeUndefined();
          const probe = result as { ok: boolean; latencyMs: number; detail: string };
          expect(typeof probe.ok).toBe('boolean');
          expect(typeof probe.latencyMs).toBe('number');
          expect(typeof probe.detail).toBe('string');
          expect(probe.detail.length > 0).toBe(true);
          expect(JSON.stringify(probe).includes(SENTINEL_KEY)).toBe(false);
          if (mustFail) expect(probe.ok).toBe(false);
        });
      }
    });

    describe('failure mapping', () => {
      if (scenarios.unauthorized) {
        const build = scenarios.unauthorized;

        it('maps a refused key to ProviderAuthError without echoing it', async () => {
          const provider = build();
          const error = await failureOf(() => provider.submit(contextFor(provider), REQUEST));

          expect(error).toBeInstanceOf(ProviderAuthError);
          expect((error as Error).message.includes(SENTINEL_KEY)).toBe(false);
        });
      }

      if (scenarios.rateLimited) {
        const build = scenarios.rateLimited;

        it('maps a throttle to RateLimitError on the shared transcription bucket, never a zero delay', async () => {
          const provider = build();
          const error = await failureOf(() => provider.submit(contextFor(provider), REQUEST));

          expect(error).toBeInstanceOf(RateLimitError);
          expect((error as RateLimitError).throttleKey).toBe(TRANSCRIPTION_THROTTLE_KEY);
          const delay = (error as RateLimitError).retryAfterMs;
          // Absent means "no opinion"; zero would read as "retry immediately".
          expect(delay === undefined || delay > 0).toBe(true);
        });
      }

      if (scenarios.inputRejected) {
        const build = scenarios.inputRejected;

        it('maps a rejected input to ProviderInputError, not a retryable failure', async () => {
          const provider = build();
          const error = await failureOf(() => provider.fetchResult(contextFor(provider), 'remote-conformance'));

          expect(error).toBeInstanceOf(ProviderInputError);
          expect((error as ProviderInputError).isDomainError).toBe(true);
        });
      }
    });
  });
}
