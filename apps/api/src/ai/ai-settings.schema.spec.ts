import { AiProviderRegistry } from './ai-provider.registry';
import {
  aiAllowedModelEntrySchema,
  aiProvidersSchema,
} from './ai-settings.schema';
import { modelKnowledgeOf, resolveAllowedModel } from './ai-model-resolution';
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

/** A real, registered `OpenAiProvider` — no test double. */
function realProvider(): OpenAiProvider {
  return new OpenAiProvider(new AiProviderRegistry(), (async () => {
    throw new Error('not used — this spec never calls fetch');
  }) as never);
}

/**
 * Everything that provider knows: its catalogue, its family derivation and its
 * conservative floor (#97).
 *
 * ⚠ `modelKnowledgeOf` RATHER THAN `capabilities.models`, which is what this
 * spec passed before #97. Passing the bare catalogue would test a resolution
 * NO CALLER PERFORMS any more, and would go green while the real precedence —
 * which has two more ranks under the catalogue — did something else entirely.
 */
function realKnowledge() {
  return modelKnowledgeOf(realProvider());
}

/** The catalogue alone: what a provider declaring neither new rank knows. */
function catalogueOnly() {
  return { catalogue: realProvider().capabilities.models };
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
    const legacy = aiAllowedModelEntrySchema.parse('gpt-4o');
    const direct = realProvider().capabilities.models.find(
      (m) => m.id === 'gpt-4o',
    );

    expect(direct).toBeDefined();
    // The descriptor is unchanged; #97 only ADDS the provenance fields, and
    // for an exact catalogue hit the provenance is `catalogue` with nothing
    // derived — the strongest answer short of an administrator typing one.
    expect(resolveAllowedModel(legacy, realKnowledge())).toEqual({
      ...direct,
      source: 'catalogue',
      derivedFrom: null,
    });
  });

  it('a legacy string for a model NOTHING can describe still resolves to null', () => {
    // ⚠ SUPERSEDED BY #97, AND THE OLD ASSERTION IS KEPT ONLY AS THE
    // CATALOGUE-ONLY CASE. Before #97 an id outside the build catalogue could
    // not be budgeted at all, because there was nowhere else to look. There
    // now is: the family derivation, then the provider's floor. So `null`
    // means "no provider knowledge of any kind", which is what a policy naming
    // an unimplemented provider looks like — and that is what this asserts.
    const legacy = aiAllowedModelEntrySchema.parse('gpt-9-imaginary');

    expect(resolveAllowedModel(legacy, catalogueOnly())).toBeNull();
    expect(resolveAllowedModel(legacy, { catalogue: [] })).toBeNull();
  });

  it('a legacy string for an UNKNOWN model now resolves through the provider floor (#97)', () => {
    // The behaviour change #97 exists for, pinned in the same file that pins
    // the behaviour it replaces: an id this build has never heard of is
    // permittable, on the provider's conservative floor, with nothing typed.
    const legacy = aiAllowedModelEntrySchema.parse('gpt-9-imaginary');

    expect(resolveAllowedModel(legacy, realKnowledge())).toEqual({
      id: 'gpt-9-imaginary',
      label: 'gpt-9-imaginary',
      contextWindowTokens: 128_000,
      maxOutputTokens: 16_384,
      source: 'default',
      derivedFrom: null,
    });
  });
});

describe('the GPT-5.4 family in the real catalogue (#87)', () => {
  // A wrong number here is not a cosmetic bug: `resolveAllowedModel` feeds
  // §3.3's token budget directly, so a stale context window makes this
  // application either refuse a prompt the vendor would have accepted, or
  // submit one the vendor rejects after the user has already been charged.
  // Pinned literally, against the numbers this build's own doc comment
  // claims to have verified — a typo in either place would otherwise agree
  // with itself and pass.
  it.each([
    ['gpt-5.4', 1_050_000, 128_000],
    ['gpt-5.4-mini', 400_000, 128_000],
    ['gpt-5.4-nano', 400_000, 128_000],
  ] as const)(
    'resolves %s to exactly %d context / %d output tokens',
    (id, contextWindowTokens, maxOutputTokens) => {
      const legacy = aiAllowedModelEntrySchema.parse(id);

      expect(resolveAllowedModel(legacy, realKnowledge())).toEqual({
        id,
        label: expect.any(String) as unknown as string,
        contextWindowTokens,
        maxOutputTokens,
        source: 'catalogue',
        derivedFrom: null,
      });
    },
  );

  // The catalogue is additive, not a replacement (see the shipping commit's
  // own message: "the catalogue is not an allow-list, and dropping [a GPT-4
  // entry] would strand a deployment already permitting it"). A regression
  // that swapped the array instead of extending it would pass every GPT-5.4
  // case above and still be wrong.
  it.each(['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4.1-mini'])(
    'still resolves the pre-existing GPT-4 entry %s',
    (id) => {
      const legacy = aiAllowedModelEntrySchema.parse(id);

      // ⚠ `source: 'catalogue'`, NOT MERELY NON-NULL. Since #97 a dropped
      // catalogue entry no longer makes a model unresolvable — it quietly
      // demotes it to the conservative floor, so a bare `not.toBeNull()` would
      // pass for exactly the regression this case exists to catch.
      expect(resolveAllowedModel(legacy, realKnowledge())?.source).toBe(
        'catalogue',
      );
    },
  );
});
