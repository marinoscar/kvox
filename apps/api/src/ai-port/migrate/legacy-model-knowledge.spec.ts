import {
  aiAllowedModelEntrySchema,
  deriveOpenAiModelDescriptor,
  OPENAI_DEFAULT_MODEL_FEATURES,
  OPENAI_DEFAULT_MODEL_LIMITS,
  resolveAllowedModel,
  type AiModelKnowledge,
} from './legacy-model-knowledge';

// The frozen copy of the retired stack's model rules (issue #477). These cases pin
// the numbers the migration planner relies on, so a deployment's `ai_models` rows
// come out the way the old settings page would have resolved them.

const KNOWLEDGE: AiModelKnowledge = {
  catalogue: [],
  derive: deriveOpenAiModelDescriptor,
  fallback: OPENAI_DEFAULT_MODEL_LIMITS,
  fallbackFeatures: OPENAI_DEFAULT_MODEL_FEATURES,
};

describe('legacy model knowledge', () => {
  describe('aiAllowedModelEntrySchema', () => {
    it('normalises the bare-id form to an object', () => {
      expect(aiAllowedModelEntrySchema.parse(' gpt-4o ')).toEqual({ id: 'gpt-4o' });
    });

    it('keeps an object entry and rejects an unusable one', () => {
      expect(aiAllowedModelEntrySchema.parse({ id: 'x', label: 'X', contextWindowTokens: 2_048 })).toEqual({
        id: 'x',
        label: 'X',
        contextWindowTokens: 2_048,
      });
      expect(aiAllowedModelEntrySchema.safeParse({ id: 'x', contextWindowTokens: 10 }).success).toBe(false);
      expect(aiAllowedModelEntrySchema.safeParse('').success).toBe(false);
    });
  });

  describe('deriveOpenAiModelDescriptor', () => {
    it('places a dated snapshot in its family', () => {
      expect(deriveOpenAiModelDescriptor('gpt-4o-2024-08-06')).toMatchObject({ id: 'gpt-4o', contextWindowTokens: 128_000 });
      expect(deriveOpenAiModelDescriptor('gpt-4.1-20250414')).toMatchObject({ id: 'gpt-4.1', maxOutputTokens: 32_768 });
    });

    it('takes the LONGEST family: a mini snapshot never gets the flagship window', () => {
      expect(deriveOpenAiModelDescriptor('gpt-5.4-mini-2026-03-17')).toMatchObject({
        id: 'gpt-5.4-mini',
        contextWindowTokens: 400_000,
      });
    });

    it('matches on a hyphen boundary only, and returns null for an unknown id', () => {
      expect(deriveOpenAiModelDescriptor('gpt-4.10-turbo')).toBeNull();
      expect(deriveOpenAiModelDescriptor('acme-private-1')).toBeNull();
      expect(deriveOpenAiModelDescriptor('  ')).toBeNull();
    });
  });

  describe('resolveAllowedModel', () => {
    it('lets the entry win, per number', () => {
      const resolved = resolveAllowedModel({ id: 'gpt-4o', maxOutputTokens: 4_096 }, KNOWLEDGE);
      expect(resolved).toMatchObject({ contextWindowTokens: 128_000, maxOutputTokens: 4_096, source: 'derived', derivedFrom: 'gpt-4o' });
    });

    it('falls back to the conservative floor for an unplaceable id, with no capability claimed', () => {
      expect(resolveAllowedModel({ id: 'acme-private-1' }, KNOWLEDGE)).toMatchObject({
        contextWindowTokens: 128_000,
        maxOutputTokens: 16_384,
        structuredOutput: false,
        toolCalling: false,
        source: 'default',
        derivedFrom: null,
      });
    });

    it('is null when nothing can answer', () => {
      expect(resolveAllowedModel({ id: 'acme-private-1' }, { catalogue: [] })).toBeNull();
    });

    it('reports the weakest source of the two numbers', () => {
      expect(resolveAllowedModel({ id: 'acme', contextWindowTokens: 64_000 }, KNOWLEDGE)).toMatchObject({
        contextWindowTokens: 64_000,
        maxOutputTokens: 16_384,
        source: 'default',
      });
    });
  });
});
