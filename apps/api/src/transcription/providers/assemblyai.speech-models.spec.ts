import { DEFAULT_SYSTEM_SETTINGS } from '../../common/types/settings.types';
import { TranscriptionProviderRegistry } from '../transcription-provider.registry';
import { createProviderContext } from './transcription-provider.interface';
import {
  ASSEMBLYAI_DEFAULT_SPEECH_MODELS,
  AssemblyAiProvider,
  normalizeAssemblyAiTranscript,
  resolveAssemblyAiSpeechModels,
  type FetchLike,
  type FetchLikeResponse,
} from './assemblyai.provider';

// =============================================================================
// The `speech_models` fix (issue #95, epic #19)
// =============================================================================
//
// AssemblyAI now REFUSES the singular `speech_model` parameter with an HTTP
// 400 ("The speech_model parameter is deprecated. Use speech_models: [...]"),
// which exhausted `transcription.submit` on every upload. This file pins the
// three things that fix has to get right, kept separate from
// `assemblyai.provider.spec.ts` (already committed, not to be touched here):
//
//   1. `resolveAssemblyAiSpeechModels` — the stored comma-separated setting
//      string maps onto the array the vendor now requires, including its
//      legacy-id fallback to the current default.
//   2. `submit()` sends `speech_models` (an array), resolved from the stored
//      setting, and NEVER the retired singular `speech_model`.
//   3. `normalizeAssemblyAiTranscript` reads the model the vendor actually
//      used back from `speech_model_used`, falling back to the pre-#95
//      `speech_model` field for an older stored payload.
// =============================================================================

const API_KEY = 'aai-super-secret-key-value-9f2b';

interface RecordedCall {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
}

interface CannedResponse {
  ok?: boolean;
  status?: number;
  headers?: Record<string, string>;
  text?: () => Promise<string>;
  json?: () => Promise<unknown>;
}

function fakeFetch(responses: CannedResponse[]): { impl: FetchLike; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  let index = 0;

  const impl: FetchLike = async (url, init): Promise<FetchLikeResponse> => {
    calls.push({ url, method: init?.method, headers: init?.headers, body: init?.body });

    const canned = responses[Math.min(index, responses.length - 1)];
    index += 1;

    return {
      ok: canned.ok ?? true,
      status: canned.status ?? 200,
      headers: { get: () => null },
      text: canned.text ?? (async () => ''),
      json: canned.json ?? (async () => ({})),
    };
  };

  return { impl, calls };
}

function buildProvider(fetchImpl: FetchLike): AssemblyAiProvider {
  return new AssemblyAiProvider(new TranscriptionProviderRegistry(), fetchImpl);
}

function ctx(speechModel: string) {
  return createProviderContext(API_KEY, { region: 'us' as const, speechModel });
}

// -----------------------------------------------------------------------------
// resolveAssemblyAiSpeechModels
// -----------------------------------------------------------------------------

describe('resolveAssemblyAiSpeechModels', () => {
  it.each<[string | null | undefined, string[]]>([
    // A single legacy id, alone, resolves to the current default list.
    ['universal', ['universal-3-5-pro', 'universal-2']],
    // Case-insensitive legacy match.
    ['UNIVERSAL', ['universal-3-5-pro', 'universal-2']],
    // Blank/absent input resolves to the default too.
    ['', ['universal-3-5-pro', 'universal-2']],
    ['   ', ['universal-3-5-pro', 'universal-2']],
    [null, ['universal-3-5-pro', 'universal-2']],
    [undefined, ['universal-3-5-pro', 'universal-2']],
    // The current default string, verbatim, round-trips in the same order.
    ['universal-3-5-pro, universal-2', ['universal-3-5-pro', 'universal-2']],
    // A single current model.
    ['universal-2', ['universal-2']],
    // Whitespace trimmed and an exact duplicate dropped, keeping first order.
    [' universal-3-5-pro ,universal-3-5-pro, ', ['universal-3-5-pro']],
    // A legacy id mixed with a current one: the legacy id is dropped, the
    // current one passes through.
    ['nano, universal-2', ['universal-2']],
    // Free text the vendor might add later passes straight through.
    ['my-new-model', ['my-new-model']],
    // Every legacy id at once resolves to the default list.
    ['best, slam-1', ['universal-3-5-pro', 'universal-2']],
  ])('resolves %p to %p', (setting, expected) => {
    expect(resolveAssemblyAiSpeechModels(setting)).toEqual(expected);
  });

  it('returns a FRESH array for the default — mutating the result must not change the constant', () => {
    const first = resolveAssemblyAiSpeechModels('');
    first.push('should-not-leak');

    expect(ASSEMBLYAI_DEFAULT_SPEECH_MODELS).toEqual(['universal-3-5-pro', 'universal-2']);

    // A second call is unaffected by the mutation of the first result too.
    expect(resolveAssemblyAiSpeechModels('')).toEqual(['universal-3-5-pro', 'universal-2']);
  });
});

// -----------------------------------------------------------------------------
// submit() — the request body
// -----------------------------------------------------------------------------

describe('AssemblyAiProvider.submit — speech_models', () => {
  const request = {
    audio: { kind: 'url' as const, url: 'https://storage.invalid/a.mp3' },
    options: { detectLanguage: true },
  };

  it('resolves a legacy stored setting ("universal") into the current default list', async () => {
    const fetch = fakeFetch([{ ok: true, status: 200, json: async () => ({ id: 'abc123' }) }]);

    await buildProvider(fetch.impl).submit(ctx('universal'), request);

    const body = JSON.parse(fetch.calls[0].body as string);
    expect(body.speech_models).toEqual(['universal-3-5-pro', 'universal-2']);
  });

  it('resolves a custom stored setting ("universal-2") to just that model', async () => {
    const fetch = fakeFetch([{ ok: true, status: 200, json: async () => ({ id: 'abc123' }) }]);

    await buildProvider(fetch.impl).submit(ctx('universal-2'), request);

    const body = JSON.parse(fetch.calls[0].body as string);
    expect(body.speech_models).toEqual(['universal-2']);
  });

  it('NEVER sends the retired singular `speech_model` key', async () => {
    const fetch = fakeFetch([{ ok: true, status: 200, json: async () => ({ id: 'abc123' }) }]);

    await buildProvider(fetch.impl).submit(ctx('universal'), request);

    const body = JSON.parse(fetch.calls[0].body as string);
    expect(body).not.toHaveProperty('speech_model');
    expect(body).toHaveProperty('speech_models');
  });
});

// -----------------------------------------------------------------------------
// normalizeAssemblyAiTranscript — reading the model back
// -----------------------------------------------------------------------------

describe('normalizeAssemblyAiTranscript — provider.model', () => {
  it('reports the model from speech_model_used (the current field)', () => {
    const result = normalizeAssemblyAiTranscript(
      { status: 'completed', speech_model_used: 'universal-3-5-pro' },
      'remote-1',
    );

    expect(result.provider.model).toBe('universal-3-5-pro');
  });

  it('prefers speech_model_used over the legacy speech_model when both are present', () => {
    const result = normalizeAssemblyAiTranscript(
      {
        status: 'completed',
        speech_model_used: 'universal-3-5-pro',
        speech_model: 'universal',
      },
      'remote-1',
    );

    expect(result.provider.model).toBe('universal-3-5-pro');
  });

  it('falls back to the legacy speech_model when speech_model_used is absent', () => {
    const result = normalizeAssemblyAiTranscript(
      { status: 'completed', speech_model: 'universal' },
      'remote-1',
    );

    expect(result.provider.model).toBe('universal');
  });

  it('reports null when neither field is present', () => {
    const result = normalizeAssemblyAiTranscript({ status: 'completed' }, 'remote-1');

    expect(result.provider.model).toBeNull();
  });
});

// -----------------------------------------------------------------------------
// The field descriptor and the seeded default agree
// -----------------------------------------------------------------------------

describe('the speechModel field descriptor', () => {
  it('defaults to the same string the settings default carries', () => {
    const provider = buildProvider(fakeFetch([]).impl);
    const descriptor = provider.fieldDescriptors.find((d) => d.key === 'speechModel');

    expect(descriptor?.defaultValue).toBe('universal-3-5-pro, universal-2');
    expect(descriptor?.defaultValue).toBe(
      DEFAULT_SYSTEM_SETTINGS.transcription.providers.assemblyai.speechModel,
    );
  });
});
