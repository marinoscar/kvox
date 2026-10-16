import { aiModelCapabilitiesSchema } from '@marinoscar/platform-api/ai';
import { AI_KEY_POLICIES, systemAiProviderSchema } from '@marinoscar/platform-contract/ai';

import {
  EMBEDDING_MODEL_ID,
  OPENAI_DEFAULT_BASE_URL,
  planAiSettings,
  type LegacyAiValue,
} from './ai-legacy-plan';

// A pre-upgrade `ai` value: the shape this application stored before the
// platform AI slice, with the fields issue #473 kept under their own names.
function legacyValue(overrides: Record<string, unknown> = {}, openai: Record<string, unknown> = {}): LegacyAiValue {
  return {
    enabled: true,
    provider: 'openai',
    providers: {
      openai: {
        baseUrl: OPENAI_DEFAULT_BASE_URL,
        allowedModels: [
          'gpt-4o-mini',
          { id: 'gpt-5.4', label: 'GPT-5.4 (team)' },
          { id: 'acme-private-1', label: 'Acme private', contextWindowTokens: 64_000, maxOutputTokens: 4_096 },
        ],
        defaultModel: 'gpt-4o-mini',
        ...openai,
      },
    },
    maxInputTokens: null,
    maxOutputTokens: 8_000,
    requestTimeoutMs: 600_000,
    reasoningEffort: 'medium',
    maxDocumentBytes: 26_214_400,
    taskModels: { 'graph.extract': { model: 'gpt-4.1', reasoningEffort: 'low' } },
    graphEnabled: true,
    ...overrides,
  } as unknown as LegacyAiValue;
}

describe('planAiSettings', () => {
  describe('settings patch', () => {
    it('writes enabled, keyPolicy byok, the provider slot and the default model', () => {
      const plan = planAiSettings(legacyValue());

      expect(plan.alreadyMigrated).toBe(false);
      expect(plan.patch).toEqual({
        enabled: true,
        keyPolicy: 'byok',
        providers: { openai: { enabled: true } },
        defaultModel: 'gpt-4o-mini',
      });
    });

    it('leaves the provider slot disabled when no provider was chosen or AI was off', () => {
      expect(planAiSettings(legacyValue({ provider: null })).patch.providers).toEqual({ openai: { enabled: false } });
      expect(planAiSettings(legacyValue({ enabled: false })).patch).toMatchObject({
        enabled: false,
        providers: { openai: { enabled: false } },
      });
    });

    it('carries a custom base URL and drops the default one (with or without a trailing slash)', () => {
      const custom = planAiSettings(legacyValue({}, { baseUrl: 'https://gateway.example.test/v1' }));
      expect(custom.patch.providers).toEqual({ openai: { enabled: true, baseUrl: 'https://gateway.example.test/v1' } });

      const slashed = planAiSettings(legacyValue({}, { baseUrl: `${OPENAI_DEFAULT_BASE_URL}/` }));
      expect(slashed.patch.providers).toEqual({ openai: { enabled: true } });
    });

    it('omits defaultModel when none was stored', () => {
      const plan = planAiSettings(legacyValue({}, { defaultModel: '  ' }));
      expect(plan.patch).not.toHaveProperty('defaultModel');
      expect(plan.defaultModel).toBeNull();
    });

    it('produces values the platform contract accepts', () => {
      const plan = planAiSettings(legacyValue({}, { baseUrl: 'https://gateway.example.test/v1' }));
      const slot = (plan.migrated.providers as Record<string, unknown>).openai;

      expect(systemAiProviderSchema.safeParse(slot).success).toBe(true);
      expect(AI_KEY_POLICIES).toContain(plan.migrated.keyPolicy);
    });
  });

  describe('migrated value', () => {
    it('removes the kvox-only keys and nothing else', () => {
      const stored = legacyValue();
      const { migrated } = planAiSettings(stored);

      expect(migrated).not.toHaveProperty('provider');
      const slot = (migrated.providers as Record<string, Record<string, unknown>>).openai;
      expect(slot).not.toHaveProperty('allowedModels');
      expect(slot).not.toHaveProperty('defaultModel');
      expect(slot).not.toHaveProperty('baseUrl');
      expect(migrated.defaultModel).toBe('gpt-4o-mini');
      expect(migrated.keyPolicy).toBe('byok');
    });

    it('keeps taskModels, graphEnabled and the limits byte-identical', () => {
      const stored = legacyValue();
      const before = JSON.stringify(stored.taskModels);
      const { migrated } = planAiSettings(stored);

      expect(JSON.stringify(migrated.taskModels)).toBe(before);
      expect(migrated).toMatchObject({
        graphEnabled: true,
        maxInputTokens: null,
        maxOutputTokens: 8_000,
        requestTimeoutMs: 600_000,
        reasoningEffort: 'medium',
        maxDocumentBytes: 26_214_400,
      });
    });

    it('copies a key it does not know through instead of dropping it', () => {
      const { migrated } = planAiSettings(legacyValue({ futureField: { a: 1 } }));
      expect(migrated.futureField).toEqual({ a: 1 });
    });

    it('does not mutate the stored value', () => {
      const stored = legacyValue();
      const snapshot = JSON.stringify(stored);
      planAiSettings(stored);
      expect(JSON.stringify(stored)).toBe(snapshot);
    });
  });

  describe('models', () => {
    it('plans one enabled admin_override row per entry, then the embedding model', () => {
      const { models, allowed } = planAiSettings(legacyValue());

      expect(allowed).toBe(3);
      expect(models.map((m) => m.modelId)).toEqual(['gpt-4o-mini', 'gpt-5.4', 'acme-private-1', EMBEDDING_MODEL_ID]);
      for (const model of models) {
        expect(model).toMatchObject({ provider: 'openai', enabled: true, capabilitySource: 'admin_override' });
      }
    });

    it('stores the label and resolves numbers from the catalogue', () => {
      const [mini, five] = planAiSettings(legacyValue()).models;

      expect(mini).toMatchObject({ displayName: null, contextWindow: 128_000, maxOutputTokens: 16_384 });
      expect(five).toMatchObject({ displayName: 'GPT-5.4 (team)', contextWindow: 1_050_000, maxOutputTokens: 128_000 });
    });

    it('lets an entry override the numbers', () => {
      const acme = planAiSettings(legacyValue()).models[2];
      expect(acme).toMatchObject({ displayName: 'Acme private', contextWindow: 64_000, maxOutputTokens: 4_096 });
      expect(acme.capabilities).toMatchObject({ contextWindow: 64_000, maxOutputTokens: 4_096 });
    });

    it('derives a dated snapshot from its family', () => {
      const plan = planAiSettings(legacyValue({}, { allowedModels: ['gpt-4o-mini-2024-07-18'] }));
      expect(plan.models[0]).toMatchObject({ contextWindow: 128_000, maxOutputTokens: 16_384 });
    });

    it('falls back to the conservative floor for an unknown id, without structured output or tools', () => {
      const plan = planAiSettings(legacyValue({}, { allowedModels: ['mystery-model'] }));
      const row = plan.models[0];

      expect(row).toMatchObject({ contextWindow: 128_000, maxOutputTokens: 16_384 });
      expect(row.capabilities.capabilities).not.toContain('structured_output');
      expect(row.capabilities.capabilities).not.toContain('tools');
    });

    it('declares the capabilities the chooser reads, in the shape the platform validates', () => {
      for (const model of planAiSettings(legacyValue()).models) {
        expect(aiModelCapabilitiesSchema.safeParse(model.capabilities).success).toBe(true);
      }
      const [mini] = planAiSettings(legacyValue()).models;
      expect(mini.capabilities.capabilities).toEqual(
        expect.arrayContaining(['responses', 'streaming', 'structured_output', 'tools']),
      );
      expect(mini.capabilities.capabilities).not.toContain('reasoning');
    });

    it('marks reasoning families with the capability and their efforts', () => {
      const [five] = planAiSettings(legacyValue()).models.filter((m) => m.modelId === 'gpt-5.4');
      expect(five.capabilities.capabilities).toContain('reasoning');
      expect(five.capabilities.reasoningEfforts).toEqual(['minimal', 'low', 'medium', 'high']);

      const chat = planAiSettings(legacyValue({}, { allowedModels: ['gpt-5-chat-latest'] })).models[0];
      expect(chat.capabilities.capabilities).not.toContain('reasoning');
    });

    it('plans the embedding model with embeddings only, even when it is not listed', () => {
      const embedding = planAiSettings(legacyValue()).models.at(-1)!;

      expect(embedding).toMatchObject({ modelId: 'text-embedding-3-small', contextWindow: null, maxOutputTokens: null });
      expect(embedding.capabilities).toEqual({
        capabilities: ['embeddings'],
        inputModalities: ['text'],
        outputModalities: ['embedding'],
      });
      expect(aiModelCapabilitiesSchema.safeParse(embedding.capabilities).success).toBe(true);
    });

    it('does not duplicate the embedding model when it is listed, and keeps its label', () => {
      const plan = planAiSettings(
        legacyValue({}, { allowedModels: [{ id: 'text-embedding-3-small', label: 'Embeddings' }, 'gpt-4o'] }),
      );
      const rows = plan.models.filter((m) => m.modelId === 'text-embedding-3-small');

      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ displayName: 'Embeddings' });
      expect(rows[0].capabilities.capabilities).toEqual(['embeddings']);
    });

    it('collapses a repeated id and skips an invalid entry, reporting positions only', () => {
      const plan = planAiSettings(
        legacyValue({}, { allowedModels: ['gpt-4o', 'gpt-4o', { label: 'no id' }, 42, ''] }),
      );

      expect(plan.models.map((m) => m.modelId)).toEqual(['gpt-4o', EMBEDDING_MODEL_ID]);
      expect(plan.skippedEntries).toEqual([2, 3, 4]);
      expect(plan.allowed).toBe(5);
    });

    it('plans only the embedding row for an empty allow-list', () => {
      const plan = planAiSettings(legacyValue({}, { allowedModels: [] }));
      expect(plan.models.map((m) => m.modelId)).toEqual([EMBEDDING_MODEL_ID]);
    });
  });

  describe('a value that was already migrated', () => {
    it('plans nothing for settings and only the embedding row for models', () => {
      const first = planAiSettings(legacyValue());
      const second = planAiSettings(first.migrated as unknown as LegacyAiValue);

      expect(second.alreadyMigrated).toBe(true);
      expect(second.patch).toEqual({});
      expect(second.migrated).toEqual(first.migrated);
      expect(second.models.map((m) => m.modelId)).toEqual([EMBEDDING_MODEL_ID]);
    });

    it('is a fixed point: planning the migrated value again changes nothing', () => {
      const once = planAiSettings(legacyValue()).migrated;
      const twice = planAiSettings(once as unknown as LegacyAiValue).migrated;
      expect(twice).toEqual(once);
    });

    it('treats an empty or unusable value as already migrated', () => {
      expect(planAiSettings({} as LegacyAiValue).alreadyMigrated).toBe(true);
      expect(planAiSettings(null as unknown as LegacyAiValue).alreadyMigrated).toBe(true);
    });
  });
});
