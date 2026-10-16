import { KVOX_AI } from '../../src/ai-port/kvox-ai';
import { KvoxAiSettings } from '../../src/ai-port/kvox-ai-settings';
import { PlatformKvoxAi } from '../../src/ai-port/platform-kvox-ai';
import { closeTestApp, createTestApp, type TestContext } from '../helpers/test-app.helper';

// =============================================================================
// KvoxAiModule wiring (issue #475): the real app resolves the port
// =============================================================================
//
// A unit spec cannot show that `PlatformKvoxAi`'s constructor is satisfiable in the
// composed application (the platform `AiService`, the target resolver, Prisma and
// the settings slice all come from different modules). Booting the test app does.
// =============================================================================

describe('KvoxAiModule', () => {
  let context: TestContext;

  beforeAll(async () => {
    context = await createTestApp();
  });

  afterAll(async () => {
    await closeTestApp(context);
  });

  it('provides KVOX_AI as the platform-backed adapter, globally', () => {
    const ai = context.app.get(KVOX_AI);

    expect(ai).toBeInstanceOf(PlatformKvoxAi);
    expect(ai.embeddingCapability()).toEqual({
      model: 'text-embedding-3-small',
      dimensions: 1536,
      maxInputTokens: 8191,
      maxBatchSize: 128,
    });
  });

  it('exports the typed reader of the extended ai namespace', () => {
    expect(context.app.get(KvoxAiSettings)).toBeInstanceOf(KvoxAiSettings);
  });
});
