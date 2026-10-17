import {
  ProviderAuthError,
  ProviderInputError,
  RateLimitError,
  createProviderContext,
  isTerminalProviderError,
} from '../src/transcription/index.js';
import {
  createFakeTranscriptionProvider,
  describeTranscriptionProviderConformance,
} from '../src/transcription/testing/index.js';

// =============================================================================
// The fake transcription provider (issue #492, epic #491)
// =============================================================================
//
// 6.2 tests its pipeline handlers against this provider, so its scripted
// behaviour is part of the slice's contract. It also passes the provider
// conformance kit, which proves the kit accepts a correct provider that is not
// AssemblyAI.
// =============================================================================

const ctx = createProviderContext('fake-test-api-key-do-not-use', {});
const request = { audio: { kind: 'url' as const, url: 'https://storage.invalid/a.mp3' }, options: { detectLanguage: true } };

describe('createFakeTranscriptionProvider', () => {
  it('submits, reports the scripted statuses (the last repeats) and returns a transcript', async () => {
    const provider = createFakeTranscriptionProvider({ script: { remoteId: 'job-7', statuses: ['queued', 'processing', 'completed'] } });

    await expect(provider.submit(ctx, request)).resolves.toEqual({ remoteId: 'job-7' });
    const seen = [];
    for (let i = 0; i < 4; i += 1) seen.push(await provider.getStatus(ctx, 'job-7'));
    expect(seen).toEqual(['queued', 'processing', 'completed', 'completed']);

    const result = await provider.fetchResult(ctx, 'job-7');
    expect(result.normalized.provider.id).toBe('fake');
    expect(result.normalized.segments).toHaveLength(1);
  });

  it('fails the operations it is told to, with the error each class means', async () => {
    const failing = (fail: 'auth' | 'input' | 'rate_limit' | 'transient') =>
      createFakeTranscriptionProvider({ script: { fail: { submit: fail }, retryAfterMs: 5_000 } }).submit(ctx, request);

    await expect(failing('auth')).rejects.toBeInstanceOf(ProviderAuthError);
    await expect(failing('input')).rejects.toBeInstanceOf(ProviderInputError);
    await expect(failing('rate_limit')).rejects.toMatchObject({ retryAfterMs: 5_000 });
    await expect(failing('rate_limit')).rejects.toBeInstanceOf(RateLimitError);
    const transient = await failing('transient').catch((e: unknown) => e);
    expect(transient).toBeInstanceOf(Error);
    expect(isTerminalProviderError(transient)).toBe(false);
  });

  it('records every call, and never the key', async () => {
    const provider = createFakeTranscriptionProvider();
    await provider.submit(ctx, request);
    await provider.deleteRemote(ctx, 'r1');

    expect(provider.calls.map((call) => call.operation)).toEqual(['submit', 'deleteRemote']);
    expect(JSON.stringify(provider.calls)).not.toContain('fake-test-api-key');
  });
});

describeTranscriptionProviderConformance(
  'the fake provider',
  () => createFakeTranscriptionProvider(),
  { describe, it, expect },
  {
    scenarios: {
      unauthorized: () => createFakeTranscriptionProvider({ script: { fail: { submit: 'auth', testConnection: 'auth' } } }),
      rateLimited: () => createFakeTranscriptionProvider({ script: { fail: { submit: 'rate_limit', testConnection: 'rate_limit' } } }),
      inputRejected: () => createFakeTranscriptionProvider({ script: { fail: { fetchResult: 'input' } } }),
      unreachable: () => createFakeTranscriptionProvider({ script: { fail: { testConnection: 'transient' } } }),
    },
  },
);
