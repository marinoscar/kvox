import '../../kvox.manifest';

import { systemSettingsNamespaceRegistry } from '@marinoscar/platform-api/settings';

import { KVOX_AI_EXTENSION_DEFAULTS, kvoxAiStoredSchema } from './ai-settings.extension';

// =============================================================================
// The `ai` namespace extension (issue #473): the registered namespace carries this
// app's fields, keeps their stored names and bounds, and holds no key
// =============================================================================

type Schema = { shape?: Record<string, unknown> };

/** Names that contain "token" because they COUNT tokens; neither can hold a credential. */
const TOKEN_COUNT_FIELDS = ['maxInputTokens', 'maxOutputTokens'];
const SECRET_LOOKING = /key|secret|token/i;

function secretLooking(names: string[]): string[] {
  return names.filter((name) => !TOKEN_COUNT_FIELDS.includes(name) && SECRET_LOOKING.test(name));
}

function registered() {
  const namespace = systemSettingsNamespaceRegistry.get('ai');
  if (!namespace) throw new Error('the ai namespace is not registered');
  return namespace;
}

describe('KVOX_AI_SETTINGS_EXTENSION', () => {
  it('has no field whose name looks like a key, secret or token', () => {
    expect(secretLooking(Object.keys(kvoxAiStoredSchema.shape))).toEqual([]);
  });

  it('keeps no secret-looking field in any schema of the folded namespace either', () => {
    const namespace = registered();
    const schemas = [
      namespace.storedSchema,
      namespace.patchSchema,
      namespace.putSchema,
      namespace.wirePatchSchema,
      namespace.responseSchema,
    ] as Array<Schema | null | undefined>;
    const added = Object.keys(kvoxAiStoredSchema.shape);

    for (const schema of schemas) {
      // Platform fields such as `keyPolicy` are the platform's; the fields THIS app added are checked.
      const names = Object.keys(schema?.shape ?? {}).filter((name) => added.includes(name));
      expect(secretLooking(names)).toEqual([]);
    }
  });

  it('adds exactly the eight fields, with the old stored names', () => {
    expect(Object.keys(kvoxAiStoredSchema.shape).sort()).toEqual(
      [
        'defaultModel',
        'graphEnabled',
        'maxDocumentBytes',
        'maxInputTokens',
        'maxOutputTokens',
        'reasoningEffort',
        'requestTimeoutMs',
        'taskModels',
      ].sort(),
    );
  });

  it('defaults are the old defaults', () => {
    expect(KVOX_AI_EXTENSION_DEFAULTS).toEqual({
      taskModels: {},
      graphEnabled: false,
      defaultModel: null,
      maxInputTokens: null,
      maxOutputTokens: null,
      requestTimeoutMs: 600_000,
      reasoningEffort: 'none',
      maxDocumentBytes: 26_214_400,
    });
    expect(kvoxAiStoredSchema.safeParse(KVOX_AI_EXTENSION_DEFAULTS).success).toBe(true);
  });

  it('copies the old bounds exactly', () => {
    const ok = (patch: Record<string, unknown>) =>
      kvoxAiStoredSchema.safeParse({ ...KVOX_AI_EXTENSION_DEFAULTS, ...patch }).success;

    expect(ok({ maxInputTokens: 255 })).toBe(false);
    expect(ok({ maxInputTokens: 256 })).toBe(true);
    expect(ok({ maxInputTokens: 2_000_001 })).toBe(false);
    expect(ok({ maxOutputTokens: 63 })).toBe(false);
    expect(ok({ maxOutputTokens: 200_001 })).toBe(false);
    expect(ok({ requestTimeoutMs: 999 })).toBe(false);
    expect(ok({ requestTimeoutMs: 3_600_001 })).toBe(false);
    expect(ok({ maxDocumentBytes: 65_535 })).toBe(false);
    expect(ok({ maxDocumentBytes: 268_435_457 })).toBe(false);
    expect(ok({ reasoningEffort: 'xhigh' })).toBe(true);
    expect(ok({ reasoningEffort: 'minimal' })).toBe(false);
    expect(ok({ defaultModel: '' })).toBe(false);
    expect(ok({ taskModels: { 'graph.brief': { model: 'x' } } })).toBe(false); // there is no such task
    expect(ok({ taskModels: { 'graph.extract': { model: 'x', reasoningEffort: 'xhigh' } } })).toBe(false);
  });
});

describe('the registered `ai` namespace', () => {
  it('defaults carry the platform fields and the added ones', () => {
    const defaults = registered().defaults as Record<string, unknown>;

    expect(defaults).toMatchObject({ enabled: false, keyPolicy: 'byok', ...KVOX_AI_EXTENSION_DEFAULTS });
  });

  it('merges a patch field by field: a present field replaces, an absent one keeps', () => {
    const namespace = registered();
    const current = namespace.defaults as Record<string, unknown>;

    const merged = namespace.merge(
      { ...current, taskModels: { 'graph.extract': { model: 'a' } }, maxInputTokens: 1_000 },
      { taskModels: {}, maxOutputTokens: 4_096, graphEnabled: true, defaultModel: 'gpt-5.4' },
    ) as Record<string, unknown>;

    expect(merged.taskModels).toEqual({}); // wholesale
    expect(merged.maxOutputTokens).toBe(4_096);
    expect(merged.graphEnabled).toBe(true);
    expect(merged.defaultModel).toBe('gpt-5.4');
    expect(merged.maxInputTokens).toBe(1_000); // untouched
    expect(merged.requestTimeoutMs).toBe(600_000);
  });

  it('null clears the nullable fields', () => {
    const namespace = registered();
    const current = namespace.defaults as Record<string, unknown>;

    const merged = namespace.merge(
      { ...current, maxInputTokens: 1_000, defaultModel: 'gpt-5.4' },
      { maxInputTokens: null, defaultModel: null },
    ) as Record<string, unknown>;

    expect(merged.maxInputTokens).toBeNull();
    expect(merged.defaultModel).toBeNull();
  });
});
