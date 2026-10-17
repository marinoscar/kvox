import providerError from '../__fixtures__/assemblyai/provider-error.json';
import { TranscriptionProviderRegistry } from '../transcription-provider.registry.js';
import { describeTranscriptionProviderConformance } from '../testing/provider-conformance.js';
import { AssemblyAiProvider, type FetchLike } from './assemblyai.provider.js';

// =============================================================================
// AssemblyAI against the provider conformance kit (issue #492, epic #491)
// =============================================================================
//
// The kit is what an extra provider runs against its own class; this is the
// built-in provider proving the same contract, with recorded vendor JSON
// (`__fixtures__/assemblyai`) for the one scenario that needs a body.
// =============================================================================

/** A `fetch` that answers every request the same way. */
function answering(status: number, body: unknown = {}, headers: Record<string, string> = {}): FetchLike {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    json: async () => body,
  });
}

const providerOver = (fetchImpl: FetchLike) =>
  new AssemblyAiProvider(new TranscriptionProviderRegistry(), fetchImpl);

describeTranscriptionProviderConformance(
  'assemblyai',
  () => providerOver(answering(200)),
  { describe, it, expect },
  {
    settings: { region: 'us', speechModel: 'universal-3-5-pro, universal-2' },
    scenarios: {
      unauthorized: () => providerOver(answering(401, 'Unauthorized')),
      rateLimited: () => providerOver(answering(429)),
      inputRejected: () => providerOver(answering(200, providerError)),
      unreachable: () =>
        providerOver(async () => {
          throw new Error('getaddrinfo ENOTFOUND api.assemblyai.com');
        }),
    },
  },
);
