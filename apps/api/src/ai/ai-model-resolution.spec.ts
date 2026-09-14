import { missingModelNumbers, resolveAllowedModel } from './ai-model-resolution';
import type { AiAllowedModel } from './ai-settings.schema';
import type { AiModelDescriptor } from './providers/ai-provider.interface';

// =============================================================================
// resolveAllowedModel / missingModelNumbers (issue #78, epic #45)
// =============================================================================
//
// THE SINGLE implementation `AiSettingsService` (refusing a save) and
// `AiConfigService` (publishing a model to a picker) both call. If these tests
// pass and the two callers keep calling this function rather than restating the
// precedence, the two answers cannot drift — see the file's own header for the
// full argument.
// =============================================================================

const CATALOGUE: AiModelDescriptor[] = [
  {
    id: 'gpt-4o',
    label: 'GPT-4o',
    contextWindowTokens: 128_000,
    maxOutputTokens: 16_384,
  },
];

function entry(overrides: Partial<AiAllowedModel> = {}): AiAllowedModel {
  return { id: 'gpt-4o', ...overrides };
}

describe('resolveAllowedModel', () => {
  it('uses the build catalogue when the entry carries no numbers of its own', () => {
    expect(resolveAllowedModel(entry(), CATALOGUE)).toEqual({
      id: 'gpt-4o',
      label: 'GPT-4o',
      contextWindowTokens: 128_000,
      maxOutputTokens: 16_384,
    });
  });

  it("the entry's own numbers win over the catalogue, even for a model this build knows", () => {
    // An administrator correcting a stale number, or describing a vendor
    // change ahead of a release of this application.
    const result = resolveAllowedModel(
      entry({ contextWindowTokens: 999_000, maxOutputTokens: 32_000 }),
      CATALOGUE,
    );

    expect(result).toEqual({
      id: 'gpt-4o',
      label: 'GPT-4o',
      contextWindowTokens: 999_000,
      maxOutputTokens: 32_000,
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
      CATALOGUE,
    );

    expect(result).toEqual({
      id: 'gpt-6-turbo',
      label: 'gpt-6-turbo',
      contextWindowTokens: 500_000,
      maxOutputTokens: 64_000,
    });
  });

  it('returns null when neither the entry nor the catalogue can answer', () => {
    expect(resolveAllowedModel(entry({ id: 'gpt-9-imaginary' }), CATALOGUE)).toBeNull();
  });

  it('returns null for a PARTIAL entry unknown to the catalogue — a context window with no output ceiling', () => {
    // Both numbers are required for a resolution: the §3.3 budget subtracts
    // the output allowance from the window, and a half-known model would leave
    // that subtraction with nothing to subtract.
    const result = resolveAllowedModel(
      entry({ id: 'gpt-6-turbo', contextWindowTokens: 500_000 }),
      CATALOGUE,
    );

    expect(result).toBeNull();
  });

  it('returns null for a PARTIAL entry unknown to the catalogue — an output ceiling with no context window', () => {
    const result = resolveAllowedModel(
      entry({ id: 'gpt-6-turbo', maxOutputTokens: 64_000 }),
      CATALOGUE,
    );

    expect(result).toBeNull();
  });

  it('fills in the missing half of a partial entry FROM the catalogue, per field, when it can', () => {
    // The entry overrides `contextWindowTokens` alone (and disagrees with the
    // catalogue's own number); `maxOutputTokens` falls through to the
    // catalogue's value because the entry does not carry one at all. This is
    // the "entry disagrees with the catalogue" case, and the per-field
    // precedence rather than an all-or-nothing override.
    const result = resolveAllowedModel(
      entry({ contextWindowTokens: 300_000 }),
      CATALOGUE,
    );

    expect(result).toEqual({
      id: 'gpt-4o',
      label: 'GPT-4o',
      contextWindowTokens: 300_000, // the entry's own, overriding the catalogue's 128_000
      maxOutputTokens: 16_384, // the catalogue's, since the entry named none
    });
  });

  it('label precedence: entry label, then catalogue label, then the raw id — never a guess', () => {
    expect(resolveAllowedModel(entry({ label: 'My GPT-4o' }), CATALOGUE)?.label).toBe(
      'My GPT-4o',
    );
    expect(resolveAllowedModel(entry(), CATALOGUE)?.label).toBe('GPT-4o');
    expect(
      resolveAllowedModel(
        entry({ id: 'gpt-6-turbo', contextWindowTokens: 1, maxOutputTokens: 64 }),
        CATALOGUE,
      )?.label,
    ).toBe('gpt-6-turbo');
  });

  it('treats an empty catalogue as "nothing known" rather than a special case', () => {
    // The doc comment on `resolveAllowedModel` states this explicitly: an
    // empty array means only entries carrying their own numbers can resolve —
    // it is what a rollback across a provider's registration, or no provider
    // being registered at all, looks like to this function.
    expect(resolveAllowedModel(entry(), [])).toBeNull();
    expect(
      resolveAllowedModel(
        entry({ contextWindowTokens: 1_024, maxOutputTokens: 64 }),
        [],
      ),
    ).toEqual({
      id: 'gpt-4o',
      label: 'gpt-4o',
      contextWindowTokens: 1_024,
      maxOutputTokens: 64,
    });
  });
});

describe('missingModelNumbers', () => {
  it('is empty for a fully resolvable entry', () => {
    expect(missingModelNumbers(entry(), CATALOGUE)).toEqual([]);
  });

  it('names both fields when neither can be answered', () => {
    expect(missingModelNumbers(entry({ id: 'gpt-9-imaginary' }), CATALOGUE)).toEqual([
      'contextWindowTokens',
      'maxOutputTokens',
    ]);
  });

  it('names only the field the entry and the catalogue both leave unanswered', () => {
    expect(
      missingModelNumbers(
        entry({ id: 'gpt-6-turbo', contextWindowTokens: 500_000 }),
        CATALOGUE,
      ),
    ).toEqual(['maxOutputTokens']);

    expect(
      missingModelNumbers(
        entry({ id: 'gpt-6-turbo', maxOutputTokens: 64_000 }),
        CATALOGUE,
      ),
    ).toEqual(['contextWindowTokens']);
  });

  it('never names a field the resolution would actually fill in', () => {
    // Both functions share one private precedence — see the file header — so
    // a field `resolveAllowedModel` resolves can never appear here.
    const withEntry = entry();
    expect(resolveAllowedModel(withEntry, CATALOGUE)).not.toBeNull();
    expect(missingModelNumbers(withEntry, CATALOGUE)).toEqual([]);
  });
});
