import type { AiAllowedModel } from './ai-settings.schema';
import type { AiModelDescriptor } from './providers/ai-provider.interface';

// =============================================================================
// Resolving a policy entry into a budgetable model (issue #78, epic #45)
// =============================================================================
//
// ONE FUNCTION, AND DELIBERATELY ONLY ONE. Two places have to answer the same
// question — "what does this deployment actually know about the model named by
// this `allowedModels` entry?" — and they answer it for opposite purposes:
//
//   • `AiSettingsService` asks in order to REFUSE a save it cannot honour
//     (`unknownModels`, and the 400 on `PUT /api/ai-settings`);
//   • `AiConfigService` asks in order to PUBLISH the model to a picker
//     (`GET /api/ai/config`).
//
// If those two ever disagreed, the disagreement would be silent and would point
// the wrong way in both directions: a model the admin page saved happily but
// the config probe dropped is a picker that is mysteriously empty, and a model
// the probe published but the save would have rejected is a generation that
// fails after the user has already been charged by their own provider. A single
// implementation makes the two answers the same answer by construction, which
// is the same argument `materialize()` makes about replaying transcript
// versions through the live reducers.
//
// -----------------------------------------------------------------------------
// THE PRECEDENCE, AND WHY IT IS THIS WAY ROUND
// -----------------------------------------------------------------------------
//
//   1. THE ENTRY'S OWN NUMBERS WIN. An administrator who typed a context window
//      for `gpt-6-turbo` is describing a model this build has never heard of
//      and knows more about it than this build does. They also win when the
//      build DOES have a descriptor, which is the case that matters after a
//      vendor grows a window: a deployment can correct a stale number in this
//      application's catalogue without waiting for a release, which is exactly
//      the coupling #78 exists to remove.
//   2. THE BUILD CATALOGUE OTHERWISE. `MODELS` in the provider — verified
//      numbers for the models this application ships knowing about, so
//      permitting `gpt-4o` stays a one-click operation with nothing to type.
//   3. `null` WHEN NEITHER CAN ANSWER, which is the whole point of the return
//      type. docs/specs/notes.md §3.3 has no safe interpretation of "unknown
//      context window": guessing high submits a prompt the vendor rejects after
//      billing the user, and guessing low refuses work that would have fit. So
//      this returns nothing at all, and each caller decides what to do about it
//      — a 400 that says which numbers are missing, or an omission from the
//      published list.
//
// ⚠ PURE, AND IT MUST STAY THAT WAY. No Prisma, no registry, no `@Injectable`.
// It takes the catalogue as an argument rather than resolving the provider
// itself precisely so the job handler — which already holds a provider and must
// not grow a second way of finding one — can call the identical function.
// =============================================================================

/**
 * The effective descriptor for one `allowedModels` entry, or `null` when this
 * deployment cannot budget against it.
 *
 * `catalogue` is the active provider's `capabilities.models`. Pass an EMPTY
 * array when no provider is registered — that is not a special case, it simply
 * means only entries carrying their own numbers can resolve.
 *
 * ⚠ BOTH NUMBERS ARE REQUIRED FOR A RESOLUTION, not just the context window.
 * The §3.3 budget subtracts the output allowance from the window to get the
 * input allowance, so a descriptor missing `maxOutputTokens` would leave the
 * subtraction with nothing to subtract — and the two plausible repairs are both
 * wrong: falling back to the deployment ceiling silently promises an output
 * length the model may refuse, and treating it as zero publishes a model that
 * can produce nothing. A half-known model is reported as unknown, and the 400
 * on the settings page names the field that is missing.
 */
export function resolveAllowedModel(
  entry: AiAllowedModel,
  catalogue: readonly AiModelDescriptor[],
): AiModelDescriptor | null {
  const known = catalogue.find((model) => model.id === entry.id);
  const { contextWindowTokens, maxOutputTokens } = effectiveNumbers(entry, known);

  if (contextWindowTokens === null || maxOutputTokens === null) return null;

  return {
    id: entry.id,
    // The administrator's label, then the catalogue's, then the raw id. NEVER a
    // prettified guess: a label this application invented for a model it knows
    // nothing else about would read as though it knew something.
    label: entry.label ?? known?.label ?? entry.id,
    contextWindowTokens,
    maxOutputTokens,
  };
}

/**
 * Which of an entry's two numbers this deployment still cannot supply.
 *
 * EXISTS SO THE 400 CAN NAME THEM. A refusal that said only "unknown model"
 * would send an administrator looking for a permission or a typo, when the
 * actual fix is two numbers they can read off the vendor's own documentation in
 * under a minute — see `AiSettingsService.update`, whose message is written
 * around this list.
 */
export function missingModelNumbers(
  entry: AiAllowedModel,
  catalogue: readonly AiModelDescriptor[],
): string[] {
  const known = catalogue.find((model) => model.id === entry.id);
  const effective = effectiveNumbers(entry, known);

  return (['contextWindowTokens', 'maxOutputTokens'] as const).filter(
    (field) => effective[field] === null,
  );
}

/**
 * The precedence itself, written ONCE.
 *
 * Private, and both exported functions above are thin wrappers over it — so
 * "the entry wins, then the catalogue, then nothing" exists in exactly one
 * place and the refusal can never name a field the resolution would have
 * filled in.
 */
function effectiveNumbers(
  entry: AiAllowedModel,
  known: AiModelDescriptor | undefined,
): { contextWindowTokens: number | null; maxOutputTokens: number | null } {
  return {
    contextWindowTokens:
      entry.contextWindowTokens ?? known?.contextWindowTokens ?? null,
    maxOutputTokens: entry.maxOutputTokens ?? known?.maxOutputTokens ?? null,
  };
}
