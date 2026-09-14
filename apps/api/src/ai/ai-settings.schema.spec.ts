import { AiProviderRegistry } from './ai-provider.registry';
import {
  aiAllowedModelEntrySchema,
  aiProvidersSchema,
} from './ai-settings.schema';
import { resolveAllowedModel } from './ai-model-resolution';
import { OpenAiProvider } from './providers/openai.provider';

// =============================================================================
// Legacy `allowedModels: string[]` compatibility (issue #78, epic #45)
// =============================================================================
//
// ⚠ THIS IS THE REGRESSION THAT SILENTLY WIPES A DEPLOYMENT'S MODEL POLICY.
// Every existing installation has `allowedModels: ["gpt-4o", …]` in JSONB right
// now, and `SystemSettingsService.readKnownSettings` degrades a namespace that
// fails to parse to `DEFAULT_SYSTEM_SETTINGS` — silently, with no error and no
// log line an administrator could find. A schema that rejected the bare-string
// form would not fail loudly; it would quietly reset every deployment's
// `allowedModels` to `[]` and `enabled` to `false`, and the first anyone would
// know is users reporting AI had stopped working.
// =============================================================================

/** The catalogue a real, registered `OpenAiProvider` carries — no test double. */
function realCatalogue() {
  return new OpenAiProvider(new AiProviderRegistry(), (async () => {
    throw new Error('not used — this spec never calls fetch');
  }) as never).capabilities.models;
}

describe('aiAllowedModelEntrySchema — the legacy string form', () => {
  it('parses a bare string and normalises it to { id }', () => {
    expect(aiAllowedModelEntrySchema.parse('gpt-4o')).toEqual({ id: 'gpt-4o' });
  });

  it('parses an object entry unchanged, beyond zod defaults', () => {
    const parsed = aiAllowedModelEntrySchema.parse({
      id: 'gpt-6-turbo',
      label: 'My GPT-6',
      contextWindowTokens: 500_000,
      maxOutputTokens: 64_000,
    });

    expect(parsed).toEqual({
      id: 'gpt-6-turbo',
      label: 'My GPT-6',
      contextWindowTokens: 500_000,
      maxOutputTokens: 64_000,
    });
  });

  it('parses a MIXED array of bare strings and objects', () => {
    const schema = aiProvidersSchema.shape.openai.shape.allowedModels;

    const parsed = schema.parse([
      'gpt-4o',
      { id: 'gpt-6-turbo', contextWindowTokens: 400_000, maxOutputTokens: 32_000 },
      'gpt-4o-mini',
    ]);

    expect(parsed).toEqual([
      { id: 'gpt-4o' },
      { id: 'gpt-6-turbo', contextWindowTokens: 400_000, maxOutputTokens: 32_000 },
      { id: 'gpt-4o-mini' },
    ]);
  });

  it('rejects an empty string — the id remains required', () => {
    expect(() => aiAllowedModelEntrySchema.parse('')).toThrow();
  });

  it('a normalised legacy string resolves through the catalogue to exactly what it resolved to before #78', () => {
    // Before this change, every consumer looked a bare id up directly against
    // the build's `MODELS` catalogue. After normalisation, the SAME lookup
    // must produce the SAME descriptor — otherwise every deployment holding
    // `["gpt-4o"]` today would silently lose (or gain) something the moment
    // this build starts.
    const catalogue = realCatalogue();
    const legacy = aiAllowedModelEntrySchema.parse('gpt-4o');
    const direct = catalogue.find((m) => m.id === 'gpt-4o');

    expect(direct).toBeDefined();
    expect(resolveAllowedModel(legacy, catalogue)).toEqual(direct);
  });

  it('a legacy string for a model the build does NOT know resolves to null, exactly as before', () => {
    // Pre-#78 behaviour for an id outside the four-entry catalogue was also
    // "cannot be budgeted" — there was nowhere else to look. That has not
    // changed for the STRING form; only an OBJECT entry can now supply its own
    // numbers.
    const catalogue = realCatalogue();
    const legacy = aiAllowedModelEntrySchema.parse('gpt-9-imaginary');

    expect(resolveAllowedModel(legacy, catalogue)).toBeNull();
  });
});
