import { KVOX_AI, type KvoxAiPort } from '@marinoscar/kvox-api/ports';

import { AiReadinessService } from '../../src/ai-port/ai-readiness.service';
import { KvoxAiSettings } from '../../src/ai-port/kvox-ai-settings';
import { KvoxAiTargetResolver } from '../../src/ai-port/kvox-ai-target-resolver';
import { PlatformAiRuntime } from '../../src/ai-port/platform-ai-runtime';
import { PlatformTaskModelSource } from '../../src/ai-port/platform-task-model-source';
import { TracedKvoxAiPort } from '../../src/platform-kvox/ai/traced-kvox-ai-port';
import { closeTestApp, createTestApp, type TestContext } from '../helpers/test-app.helper';

// =============================================================================
// KvoxAiModule wiring (issue #475, #579): the real app binds KVOX_AI to createKvoxAi
// =============================================================================
//
// A unit spec cannot show that the binding's factory is satisfiable in the composed
// application (the platform `AiService`, the task-model source the target resolver
// shares, Prisma and the settings slice all come from different modules). Booting
// the test app does.
// =============================================================================

describe('KvoxAiModule', () => {
  let context: TestContext;

  beforeAll(async () => {
    context = await createTestApp();
  });

  afterAll(async () => {
    await closeTestApp(context);
  });

  it('binds KVOX_AI to createKvoxAi over the platform runtime, globally, with the web spans', () => {
    const ai = context.app.get<KvoxAiPort>(KVOX_AI);

    expect(ai).toBeInstanceOf(TracedKvoxAiPort);
    expect(ai.countTokens({ provider: 'openai', model: 'm', contextWindowTokens: 1, maxOutputTokens: 1, source: 'default' }, 'abcdefghi')).toBe(3);
  });

  it('provides the runtime and the readiness reader the binding is built from', () => {
    expect(context.app.get(PlatformAiRuntime)).toBeInstanceOf(PlatformAiRuntime);
    expect(context.app.get(AiReadinessService)).toBeInstanceOf(AiReadinessService);
  });

  it('shares ONE task-model source between the platform target resolver and the binding', () => {
    const source = context.app.get(PlatformTaskModelSource, { strict: false });
    const resolver = context.app.get(KvoxAiTargetResolver, { strict: false });

    expect(source).toBeInstanceOf(PlatformTaskModelSource);
    const invalidate = jest.spyOn(source, 'invalidateCache');
    resolver.invalidateCache();
    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  it('exports the typed reader of the extended ai namespace', () => {
    expect(context.app.get(KvoxAiSettings)).toBeInstanceOf(KvoxAiSettings);
  });
});
