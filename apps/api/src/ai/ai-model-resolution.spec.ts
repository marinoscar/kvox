import {
  missingModelNumbers,
  modelKnowledgeOf,
  resolveAllowedModel,
  type AiModelKnowledge,
} from './ai-model-resolution';
import type { AiAllowedModel } from './ai-settings.schema';
import type {
  AiModelDescriptor,
  AiProvider,
} from './providers/ai-provider.interface';

// =============================================================================
// resolveAllowedModel / missingModelNumbers (issue #78, widened by #97)
// =============================================================================
//
// THE SINGLE implementation `AiSettingsService` (refusing a save),
// `AiConfigService` (publishing a model to a picker), the note generation path
// and `OpenAiProvider.listModels` (filling the discovery dialog) all call. If
// these tests pass and those callers keep calling this function rather than
// restating the precedence, their answers cannot drift — see the file's own
// header for the full argument.
//
// THE FOUR RANKS, each exercised below: the entry's own numbers, an exact
// catalogue hit, the provider's family derivation, the provider's conservative
// floor. The cases that used to assert `null` for "this build has never heard
// of the model" are kept, but as the CATALOGUE-ONLY knowledge — which is what a
// provider declaring neither of the two new members looks like, and what an
// unimplemented provider looks like — because `null` no longer means that for
// a provider that declares them.
// =============================================================================

const CATALOGUE: AiModelDescriptor[] = [
  {
    id: 'gpt-4o',
    label: 'GPT-4o',
    contextWindowTokens: 128_000,
    maxOutputTokens: 16_384,
    structuredOutput: true,
    toolCalling: true,
  },
  {
    id: 'gpt-5.4',
    label: 'GPT-5.4',
    contextWindowTokens: 1_050_000,
    maxOutputTokens: 128_000,
    structuredOutput: true,
    toolCalling: true,
  },
  {
    id: 'gpt-5.4-mini',
    label: 'GPT-5.4 mini',
    contextWindowTokens: 400_000,
    maxOutputTokens: 128_000,
    structuredOutput: true,
    toolCalling: true,
  },
];

/** Rank 2 only — a provider that derives nothing and declares no floor. */
const CATALOGUE_ONLY: AiModelKnowledge = { catalogue: CATALOGUE };

/** No provider at all: what `modelKnowledgeOf(undefined)` produces. */
const NOTHING_KNOWN: AiModelKnowledge = { catalogue: [] };

/**
 * A stand-in family derivation: `<family>-<anything>` belongs to `<family>`,
 * longest match wins. Deliberately NOT OpenAI's real rule — that one is pinned
 * in `openai.provider.spec.ts`, where the vendor's id vocabulary lives. What
 * this file asserts is what the RESOLVER does with whatever a provider returns.
 */
function derive(id: string): AiModelDescriptor | null {
  let best: AiModelDescriptor | null = null;

  for (const model of CATALOGUE) {
    if (id !== model.id && !id.startsWith(`${model.id}-`)) continue;
    if (best === null || model.id.length > best.id.length) best = model;
  }

  return best ? { ...best, id: best.id, label: id } : null;
}

/** All four ranks available. */
const FULL: AiModelKnowledge = {
  catalogue: CATALOGUE,
  derive,
  fallback: { contextWindowTokens: 128_000, maxOutputTokens: 16_384 },
};

/** Ranks 1, 2 and 4 — a provider with a floor but no derivation. */
const FLOOR_ONLY: AiModelKnowledge = {
  catalogue: CATALOGUE,
  fallback: { contextWindowTokens: 128_000, maxOutputTokens: 16_384 },
};

function entry(overrides: Partial<AiAllowedModel> = {}): AiAllowedModel {
  return { id: 'gpt-4o', ...overrides };
}

describe('resolveAllowedModel', () => {
  it('uses the build catalogue when the entry carries no numbers of its own', () => {
    expect(resolveAllowedModel(entry(), FULL)).toEqual({
      id: 'gpt-4o',
      label: 'GPT-4o',
      contextWindowTokens: 128_000,
      maxOutputTokens: 16_384,
      structuredOutput: true,
      toolCalling: true,
      source: 'catalogue',
      derivedFrom: null,
    });
  });

  it("the entry's own numbers win over the catalogue, even for a model this build knows", () => {
    // An administrator correcting a stale number, or describing a vendor
    // change ahead of a release of this application. #97 added two ranks BELOW
    // the catalogue, so this one is untouched — a derived or floored number can
    // never overrule a typed one.
    const result = resolveAllowedModel(
      entry({ contextWindowTokens: 999_000, maxOutputTokens: 32_000 }),
      FULL,
    );

    expect(result).toEqual({
      id: 'gpt-4o',
      label: 'GPT-4o',
      contextWindowTokens: 999_000,
      maxOutputTokens: 32_000,
      structuredOutput: true,
      toolCalling: true,
      source: 'explicit',
      derivedFrom: null,
    });
  });

  it('resolves a model absent from the build catalogue entirely, from its own numbers alone', () => {
    // The whole point of #78: a deployment can permit a model no release of
    // this application has ever heard of.
    const result = resolveAllowedModel(
      entry({
        id: 'gpt-6-turbo',
        contextWindowTokens: 500_000,
        maxOutputTokens: 64_000,
      }),
      FULL,
    );

    expect(result).toEqual({
      id: 'gpt-6-turbo',
      label: 'gpt-6-turbo',
      contextWindowTokens: 500_000,
      maxOutputTokens: 64_000,
      structuredOutput: false,
      toolCalling: false,
      source: 'explicit',
      derivedFrom: null,
    });
  });

  it('derives a dated snapshot from its family, at the FAMILY\'s full numbers (#97)', () => {
    // The performance point of the whole issue: `gpt-5.4-mini-2026-03-17` gets
    // `gpt-5.4-mini`'s 400k window, not a reduced "safe" one — and NOT
    // `gpt-5.4`'s 1,050k, which the shorter prefix also matches.
    expect(resolveAllowedModel(entry({ id: 'gpt-5.4-mini-2026-03-17' }), FULL)).toEqual(
      {
        id: 'gpt-5.4-mini-2026-03-17',
        // The RAW id, never the family's human name: this build has no
        // descriptor for this model and a borrowed label would claim one.
        label: 'gpt-5.4-mini-2026-03-17',
        contextWindowTokens: 400_000,
        maxOutputTokens: 128_000,
        structuredOutput: true,
        toolCalling: true,
        source: 'derived',
        derivedFrom: 'gpt-5.4-mini',
      },
    );
  });

  it('falls through to the provider floor when nothing places the id (#97)', () => {
    expect(resolveAllowedModel(entry({ id: 'llama-4-titan' }), FULL)).toEqual({
      id: 'llama-4-titan',
      label: 'llama-4-titan',
      contextWindowTokens: 128_000,
      maxOutputTokens: 16_384,
      structuredOutput: false,
      toolCalling: false,
      source: 'default',
      derivedFrom: null,
    });
  });

  it('reports the WEAKEST source either number came from, never the strongest', () => {
    // The rule `AiResolvedModel.source` documents. Here the window is derived
    // from the family and the output ceiling is the administrator's own, so the
    // pair is only as well-founded as the derivation.
    expect(
      resolveAllowedModel(
        entry({ id: 'gpt-5.4-mini-2026-03-17', maxOutputTokens: 64_000 }),
        FULL,
      ),
    ).toEqual({
      id: 'gpt-5.4-mini-2026-03-17',
      label: 'gpt-5.4-mini-2026-03-17',
      contextWindowTokens: 400_000,
      maxOutputTokens: 64_000,
      structuredOutput: true,
      toolCalling: true,
      source: 'derived',
      derivedFrom: 'gpt-5.4-mini',
    });

    // And when one number falls all the way to the floor, the pair reports
    // `default` and names NO family — claiming one would overstate what this
    // deployment knows about a half-floored model.
    expect(
      resolveAllowedModel(
        { id: 'gpt-5.4-mini-2026-03-17', contextWindowTokens: 400_000 },
        { catalogue: CATALOGUE, derive: () => null, fallback: FULL.fallback },
      ),
    ).toEqual({
      id: 'gpt-5.4-mini-2026-03-17',
      label: 'gpt-5.4-mini-2026-03-17',
      contextWindowTokens: 400_000,
      maxOutputTokens: 16_384,
      structuredOutput: false,
      toolCalling: false,
      source: 'default',
      derivedFrom: null,
    });
  });

  it('never consults the derivation for an id the catalogue answers exactly', () => {
    // An invariant, not an optimisation: a catalogue hit answers both numbers,
    // so a `derive` that disagreed with the catalogue about a catalogued id
    // must be unable to affect the result.
    const derived = jest.fn(() => null);

    expect(
      resolveAllowedModel(entry(), { catalogue: CATALOGUE, derive: derived })
        ?.source,
    ).toBe('catalogue');
    expect(derived).not.toHaveBeenCalled();
  });

  it('returns null only when NO rank can answer', () => {
    // Pre-#97 this was "the build has never heard of the model". It now means
    // there is no provider knowledge at all — a policy naming a vendor this
    // build does not implement, or one declaring neither a derivation nor a
    // floor.
    expect(resolveAllowedModel(entry({ id: 'gpt-9-imaginary' }), CATALOGUE_ONLY)).toBeNull();
    expect(resolveAllowedModel(entry(), NOTHING_KNOWN)).toBeNull();
    expect(resolveAllowedModel(entry({ id: 'gpt-9-imaginary' }), FULL)).not.toBeNull();
  });

  it('returns null for a PARTIAL entry nothing else can complete — a window with no output ceiling', () => {
    // Both numbers are required for a resolution: the §3.3 budget subtracts
    // the output allowance from the window, and a half-known model would leave
    // that subtraction with nothing to subtract.
    const result = resolveAllowedModel(
      entry({ id: 'gpt-6-turbo', contextWindowTokens: 500_000 }),
      CATALOGUE_ONLY,
    );

    expect(result).toBeNull();
  });

  it('returns null for a PARTIAL entry nothing else can complete — a ceiling with no window', () => {
    const result = resolveAllowedModel(
      entry({ id: 'gpt-6-turbo', maxOutputTokens: 64_000 }),
      CATALOGUE_ONLY,
    );

    expect(result).toBeNull();
  });

  it('fills in the missing half of a partial entry, PER FIELD, from whichever rank can', () => {
    // The entry overrides `contextWindowTokens` alone (and disagrees with the
    // catalogue's own number); `maxOutputTokens` falls through to the
    // catalogue's value because the entry does not carry one at all. This is
    // the "entry disagrees with the catalogue" case, and the per-field
    // precedence rather than an all-or-nothing override.
    expect(resolveAllowedModel(entry({ contextWindowTokens: 300_000 }), FULL)).toEqual(
      {
        id: 'gpt-4o',
        label: 'GPT-4o',
        contextWindowTokens: 300_000, // the entry's own, overriding the catalogue's 128_000
        maxOutputTokens: 16_384, // the catalogue's, since the entry named none
        structuredOutput: true,
        toolCalling: true,
        source: 'catalogue', // the weaker of `explicit` and `catalogue`
        derivedFrom: null,
      },
    );

    // The same per-field rule across the two NEW ranks: an unplaceable id with
    // one number typed takes the other from the floor.
    expect(
      resolveAllowedModel(
        entry({ id: 'llama-4-titan', maxOutputTokens: 64_000 }),
        FLOOR_ONLY,
      ),
    ).toEqual({
      id: 'llama-4-titan',
      label: 'llama-4-titan',
      contextWindowTokens: 128_000,
      maxOutputTokens: 64_000,
      structuredOutput: false,
      toolCalling: false,
      source: 'default',
      derivedFrom: null,
    });
  });

  it('label precedence: entry label, then catalogue label, then the raw id — never a guess', () => {
    expect(resolveAllowedModel(entry({ label: 'My GPT-4o' }), FULL)?.label).toBe(
      'My GPT-4o',
    );
    expect(resolveAllowedModel(entry(), FULL)?.label).toBe('GPT-4o');
    expect(
      resolveAllowedModel(
        entry({ id: 'gpt-6-turbo', contextWindowTokens: 1, maxOutputTokens: 64 }),
        FULL,
      )?.label,
    ).toBe('gpt-6-turbo');

    // ⚠ A DERIVED FAMILY'S LABEL IS NOT BORROWED (#97), even when the provider
    // returns one: printing "GPT-5.4 mini" beside a different model's id would
    // claim a descriptor this build does not have.
    expect(
      resolveAllowedModel(entry({ id: 'gpt-5.4-mini-2026-03-17' }), {
        catalogue: CATALOGUE,
        derive: () => ({
          id: 'gpt-5.4-mini',
          label: 'GPT-5.4 mini',
          contextWindowTokens: 400_000,
          maxOutputTokens: 128_000,
          structuredOutput: true,
          toolCalling: true,
        }),
      })?.label,
    ).toBe('gpt-5.4-mini-2026-03-17');
  });

  it('treats empty knowledge as "nothing known" rather than a special case', () => {
    // The doc comment on `resolveAllowedModel` states this explicitly: empty
    // knowledge means only entries carrying their own numbers can resolve — it
    // is what a rollback across a provider's registration, or no provider being
    // registered at all, looks like to this function.
    expect(resolveAllowedModel(entry(), NOTHING_KNOWN)).toBeNull();
    expect(
      resolveAllowedModel(
        entry({ contextWindowTokens: 1_024, maxOutputTokens: 64 }),
        NOTHING_KNOWN,
      ),
    ).toEqual({
      id: 'gpt-4o',
      label: 'gpt-4o',
      contextWindowTokens: 1_024,
      maxOutputTokens: 64,
      structuredOutput: false,
      toolCalling: false,
      source: 'explicit',
      derivedFrom: null,
    });
  });
});

describe('modelKnowledgeOf', () => {
  it('carries all three members off a provider that declares them', () => {
    const provider = {
      capabilities: {
        models: CATALOGUE,
        streaming: true as const,
        modelDiscovery: false,
        defaultModelLimits: { contextWindowTokens: 128_000, maxOutputTokens: 16_384 },
      },
      deriveModelDescriptor: derive,
    } as unknown as AiProvider<unknown>;

    const knowledge = modelKnowledgeOf(provider);

    expect(knowledge.catalogue).toBe(CATALOGUE);
    expect(knowledge.fallback).toEqual({
      contextWindowTokens: 128_000,
      maxOutputTokens: 16_384,
    });
    expect(knowledge.derive?.('gpt-5.4-mini-x')?.id).toBe('gpt-5.4-mini');
  });

  it('carries neither new member off a provider that declares neither', () => {
    // "Presence is the declaration": a provider may decline both, and its
    // unknown ids then stay unresolvable exactly as they did before #97.
    const provider = {
      capabilities: { models: CATALOGUE, streaming: true as const, modelDiscovery: false },
    } as unknown as AiProvider<unknown>;

    const knowledge = modelKnowledgeOf(provider);

    expect(knowledge.derive).toBeUndefined();
    expect(knowledge.fallback).toBeUndefined();
    expect(resolveAllowedModel(entry({ id: 'gpt-9-imaginary' }), knowledge)).toBeNull();
  });

  it('is empty — not a special case — for an absent provider', () => {
    expect(modelKnowledgeOf(undefined)).toEqual({ catalogue: [] });
    expect(modelKnowledgeOf(null)).toEqual({ catalogue: [] });
  });
});

describe('missingModelNumbers', () => {
  it('is empty for a fully resolvable entry', () => {
    expect(missingModelNumbers(entry(), FULL)).toEqual([]);
  });

  it('is empty for ANY entry once a provider declares a floor (#97)', () => {
    // The refusal path is kept but is no longer reachable for a registered
    // provider with a floor — which is the behaviour change #97 exists for,
    // stated where the refusal lives rather than only where it is raised.
    expect(missingModelNumbers(entry({ id: 'gpt-9-imaginary' }), FULL)).toEqual([]);
  });

  it('names both fields when NO rank can answer either', () => {
    expect(
      missingModelNumbers(entry({ id: 'gpt-9-imaginary' }), CATALOGUE_ONLY),
    ).toEqual(['contextWindowTokens', 'maxOutputTokens']);
  });

  it('names only the field no rank leaves answered', () => {
    expect(
      missingModelNumbers(
        entry({ id: 'gpt-6-turbo', contextWindowTokens: 500_000 }),
        CATALOGUE_ONLY,
      ),
    ).toEqual(['maxOutputTokens']);

    expect(
      missingModelNumbers(
        entry({ id: 'gpt-6-turbo', maxOutputTokens: 64_000 }),
        CATALOGUE_ONLY,
      ),
    ).toEqual(['contextWindowTokens']);
  });

  it('never names a field the resolution would actually fill in', () => {
    // Both functions share one private precedence — see the file header — so
    // a field `resolveAllowedModel` resolves can never appear here.
    const withEntry = entry();
    expect(resolveAllowedModel(withEntry, FULL)).not.toBeNull();
    expect(missingModelNumbers(withEntry, FULL)).toEqual([]);

    const derivable = entry({ id: 'gpt-5.4-mini-2026-03-17' });
    expect(resolveAllowedModel(derivable, FULL)).not.toBeNull();
    expect(missingModelNumbers(derivable, FULL)).toEqual([]);
  });
});

describe('resolveAllowedModel — the structuredOutput flag, per rank (#358)', () => {
  // The flag follows the same ranks as the numbers, MINUS rank 1: there is no
  // administrator override of a capability in v1, so a typed number never
  // promotes or demotes it. A false positive fails a paid structured call; a
  // false negative is fixed by picking a catalogued model.

  /** A catalogue with one model the vendor does NOT support strict mode for. */
  const MIXED: AiModelDescriptor[] = [
    ...CATALOGUE,
    {
      id: 'legacy-chat',
      label: 'Legacy chat',
      contextWindowTokens: 16_000,
      maxOutputTokens: 4_000,
      structuredOutput: false,
      toolCalling: false,
    },
  ];

  const WITH_FEATURE_FLOOR = (structuredOutput: boolean): AiModelKnowledge => ({
    catalogue: MIXED,
    derive,
    fallback: FULL.fallback,
    fallbackFeatures: { structuredOutput, toolCalling: false },
  });

  it('takes an exact catalogue hit\'s own flag, true or false', () => {
    expect(resolveAllowedModel(entry(), WITH_FEATURE_FLOOR(false))?.structuredOutput).toBe(true);
    expect(
      resolveAllowedModel(entry({ id: 'legacy-chat' }), WITH_FEATURE_FLOOR(true))
        ?.structuredOutput,
    ).toBe(false);
  });

  it('takes the derived FAMILY\'s flag for a dated snapshot', () => {
    const resolved = resolveAllowedModel(
      entry({ id: 'gpt-5.4-mini-2026-03-17' }),
      WITH_FEATURE_FLOOR(false),
    );

    expect(resolved?.source).toBe('derived');
    expect(resolved?.structuredOutput).toBe(true);
  });

  it('takes the provider\'s feature floor for an id nothing places', () => {
    expect(
      resolveAllowedModel(entry({ id: 'llama-4-titan' }), WITH_FEATURE_FLOOR(false))
        ?.structuredOutput,
    ).toBe(false);
    expect(
      resolveAllowedModel(entry({ id: 'llama-4-titan' }), WITH_FEATURE_FLOOR(true))
        ?.structuredOutput,
    ).toBe(true);
  });

  it('is false when the provider declares no feature floor at all', () => {
    // `FULL` has a NUMBERS floor but no `fallbackFeatures`: the id resolves
    // (numbers from the floor) and still claims no capability.
    const resolved = resolveAllowedModel(entry({ id: 'llama-4-titan' }), FULL);

    expect(resolved?.source).toBe('default');
    expect(resolved?.structuredOutput).toBe(false);
  });

  it('is NOT affected by an entry\'s explicit numbers — no admin override of a flag', () => {
    // Explicit numbers on a catalogued model keep the catalogue's flag...
    expect(
      resolveAllowedModel(
        entry({ contextWindowTokens: 999_000, maxOutputTokens: 32_000 }),
        WITH_FEATURE_FLOOR(false),
      )?.structuredOutput,
    ).toBe(true);
    // ...and on an unplaceable one keep the floor's.
    const typed = resolveAllowedModel(
      entry({ id: 'llama-4-titan', contextWindowTokens: 64_000, maxOutputTokens: 4_000 }),
      WITH_FEATURE_FLOOR(false),
    );
    expect(typed?.source).toBe('explicit');
    expect(typed?.structuredOutput).toBe(false);
  });

  it('modelKnowledgeOf carries capabilities.defaultModelFeatures as fallbackFeatures', () => {
    const provider = {
      capabilities: {
        models: CATALOGUE,
        streaming: true as const,
        modelDiscovery: false,
        defaultModelFeatures: { structuredOutput: false, toolCalling: false },
      },
    } as unknown as AiProvider<unknown>;

    expect(modelKnowledgeOf(provider).fallbackFeatures).toEqual({
      structuredOutput: false,
      toolCalling: false,
    });
    expect(
      modelKnowledgeOf({
        capabilities: { models: CATALOGUE, streaming: true, modelDiscovery: false },
      } as unknown as AiProvider<unknown>).fallbackFeatures,
    ).toBeUndefined();
  });
});

describe('resolveAllowedModel — the toolCalling flag, per rank (#359)', () => {
  // Same ranks as structuredOutput, and — like it — no administrator override.
  // The two flags are INDEPENDENT: each rank carries both, and one never
  // implies the other.

  /** A catalogue with one model that does structured output but not tools. */
  const MIXED: AiModelDescriptor[] = [
    ...CATALOGUE,
    {
      id: 'schema-only',
      label: 'Schema only',
      contextWindowTokens: 16_000,
      maxOutputTokens: 4_000,
      structuredOutput: true,
      toolCalling: false,
    },
  ];

  const WITH_FEATURE_FLOOR = (toolCalling: boolean): AiModelKnowledge => ({
    catalogue: MIXED,
    derive,
    fallback: FULL.fallback,
    fallbackFeatures: { structuredOutput: false, toolCalling },
  });

  it('takes an exact catalogue hit\'s own flag, true or false', () => {
    expect(resolveAllowedModel(entry(), WITH_FEATURE_FLOOR(false))?.toolCalling).toBe(true);

    const schemaOnly = resolveAllowedModel(
      entry({ id: 'schema-only' }),
      WITH_FEATURE_FLOOR(true),
    );
    expect(schemaOnly?.toolCalling).toBe(false);
    expect(schemaOnly?.structuredOutput).toBe(true);
  });

  it('takes the derived FAMILY\'s flag for a dated snapshot', () => {
    const resolved = resolveAllowedModel(
      entry({ id: 'gpt-5.4-mini-2026-03-17' }),
      WITH_FEATURE_FLOOR(false),
    );

    expect(resolved?.source).toBe('derived');
    expect(resolved?.toolCalling).toBe(true);
  });

  it('takes the provider\'s feature floor for an id nothing places', () => {
    expect(
      resolveAllowedModel(entry({ id: 'llama-4-titan' }), WITH_FEATURE_FLOOR(false))
        ?.toolCalling,
    ).toBe(false);

    const floored = resolveAllowedModel(entry({ id: 'llama-4-titan' }), WITH_FEATURE_FLOOR(true));
    expect(floored?.toolCalling).toBe(true);
    // Independent: the floor's structuredOutput stayed false.
    expect(floored?.structuredOutput).toBe(false);
  });

  it('is false when the provider declares no feature floor at all', () => {
    const resolved = resolveAllowedModel(entry({ id: 'llama-4-titan' }), FULL);

    expect(resolved?.source).toBe('default');
    expect(resolved?.toolCalling).toBe(false);
  });

  it('is NOT affected by an entry\'s explicit numbers — no admin override of a flag', () => {
    expect(
      resolveAllowedModel(
        entry({ contextWindowTokens: 999_000, maxOutputTokens: 32_000 }),
        WITH_FEATURE_FLOOR(false),
      )?.toolCalling,
    ).toBe(true);

    const typed = resolveAllowedModel(
      entry({ id: 'llama-4-titan', contextWindowTokens: 64_000, maxOutputTokens: 4_000 }),
      WITH_FEATURE_FLOOR(false),
    );
    expect(typed?.source).toBe('explicit');
    expect(typed?.toolCalling).toBe(false);
  });
});
