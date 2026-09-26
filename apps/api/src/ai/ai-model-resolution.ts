import type { AiAllowedModel } from './ai-settings.schema';
import type {
  AiModelDescriptor,
  AiModelFeatureFlags,
  AiProvider,
} from './providers/ai-provider.interface';

// =============================================================================
// Resolving a policy entry into a budgetable model (issue #78, epic #45;
// widened by issue #97)
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
// Since #97 there is a THIRD caller with a third purpose:
// `OpenAiProvider.listModels` resolves every id the vendor reported through
// this same function (with a bare `{ id }` entry), so the numbers shown in the
// discovery dialog are the numbers the save path will compute. A second copy of
// the precedence written inside the provider is the exact drift this file
// exists to prevent, one layer out.
//
// -----------------------------------------------------------------------------
// THE PRECEDENCE, AND WHY IT IS THIS WAY ROUND
// -----------------------------------------------------------------------------
//
// Applied PER NUMBER, not per model: an entry supplying only `maxOutputTokens`
// takes its context window from whichever source below can answer next.
//
//   1. THE ENTRY'S OWN NUMBERS WIN (`explicit`). An administrator who typed a
//      context window for `gpt-6-turbo` is describing a model this build has
//      never heard of and knows more about it than this build does. They also
//      win when the build DOES have a descriptor, which is the case that
//      matters after a vendor grows a window: a deployment can correct a stale
//      number in this application's catalogue without waiting for a release,
//      which is exactly the coupling #78 exists to remove. #97 does not touch
//      this rank — everything it adds is BELOW the administrator, so a derived
//      number can never overrule a typed one.
//   2. THE BUILD CATALOGUE, ON AN EXACT ID (`catalogue`). `MODELS` in the
//      provider — verified numbers for the models this application ships
//      knowing about, so permitting `gpt-4o` stays a one-click operation with
//      nothing to type.
//   3. THE PROVIDER'S OWN DERIVATION (`derived`, #97). `knowledge.derive` places
//      an unrecognised id in a KNOWN FAMILY — `gpt-5.4-mini-2026-03-17` is a
//      dated snapshot of `gpt-5.4-mini` and has that model's window, not a
//      reduced one. This rank exists because real vendor lists are mostly dated
//      snapshots of models this build already knows: before #97, permitting one
//      meant hand-typing two numbers, so the "load models from the provider"
//      dialog listed sixty models an administrator could not use.
//   4. THE PROVIDER'S CONSERVATIVE FLOOR (`default`, #97). `knowledge.fallback`
//      is the smallest window a chat model from this vendor is known to have.
//      It is a FLOOR, not a guess at this model's real size: a number below the
//      truth refuses a prompt that would have fit (recoverable, and visible —
//      the administrator can type the real number), whereas a number above it
//      submits a prompt the vendor rejects AFTER billing the user (not
//      recoverable, and the user pays). Those are not symmetric mistakes, which
//      is why the floor is allowed to exist at all and why it must stay
//      conservative.
//   5. `null` WHEN NONE OF THE ABOVE CAN ANSWER, which is why the return type
//      is still nullable. Since #97 this means something much narrower than it
//      used to: the entry carries no numbers AND there is no provider knowledge
//      at all — no catalogue, no derivation, no floor. In practice that is "no
//      provider is registered in this build for the id the policy names" (a
//      rollback across the addition of a provider), or a provider that has
//      deliberately declined to declare a floor. It is NOT "this build has
//      never heard of the model" any more; that case now resolves at rank 3 or
//      4.
//
// REJECTED: keeping rank 4 out and letting an unknown id stay unresolvable.
// That is what #78 shipped, and docs/specs/notes.md §3.3's argument against
// guessing ("guessing high submits a prompt the vendor rejects after billing
// the user, and guessing low refuses work that would have fit") was read as
// forbidding both directions equally. It does not: only the high side is
// unrecoverable. The refusal path is kept — see `missingModelNumbers` — but it
// now fires only for the genuinely unanswerable case above, rather than for
// every model shipped since this build was cut.
//
// REJECTED: deriving inside `AiConfigService`/`AiSettingsService` and leaving
// this file alone. The derivation is VENDOR KNOWLEDGE (which id shapes are
// snapshots, which families exist), and vendor knowledge lives in the provider.
// A service that knew how OpenAI spells a dated snapshot would have to learn it
// again for the next vendor.
//
// ⚠ PURE, AND IT MUST STAY THAT WAY. No Prisma, no registry, no `@Injectable`.
// It takes the provider's knowledge as an argument rather than resolving the
// provider itself precisely so the job handler — which already holds a provider
// and must not grow a second way of finding one — can call the identical
// function. `knowledge.derive` is therefore required to be pure and synchronous
// too; see `AiProvider.deriveModelDescriptor`.
// =============================================================================

/**
 * Everything a provider knows about models, as one argument (#97).
 *
 * WHY A BUNDLE RATHER THAN THREE PARAMETERS. The catalogue, the derivation and
 * the floor are three ranks of ONE precedence, and every call site has the same
 * single thing to hand: a provider. Passing them separately would let a caller
 * supply two of the three — a catalogue without the floor is a resolution that
 * silently refuses models the next caller resolves — and there is no compiler
 * check that would notice. `modelKnowledgeOf` builds this from a provider so no
 * caller assembles it by hand.
 */
export interface AiModelKnowledge {
  /** The provider's build catalogue (`capabilities.models`). May be empty. */
  catalogue: readonly AiModelDescriptor[];
  /**
   * Place an unrecognised id in a known family. PURE and SYNCHRONOUS.
   *
   * The returned descriptor describes the FAMILY, not the requested model: its
   * `id` is the catalogue id the numbers were taken from and is what becomes
   * {@link AiResolvedModel.derivedFrom}. Absent means this provider does not
   * derive, which is a legal thing for a provider to decline.
   */
  derive?: (id: string) => AiModelDescriptor | null;
  /**
   * The conservative floor for a chat model this provider has never heard of.
   *
   * Absent means this provider declines to have one, and unknown ids stay
   * unresolvable for it — see rank 5 in the header.
   */
  fallback?: { contextWindowTokens: number; maxOutputTokens: number };
  /**
   * The conservative capability floor for an id this provider cannot place
   * (#358) — `capabilities.defaultModelFeatures`. Absent means every flag
   * resolves to `false` for such an id.
   */
  fallbackFeatures?: AiModelFeatureFlags;
}

/**
 * Which rank of the header's precedence a number actually came from.
 *
 * PUBLISHED TO THE UI, which is the whole reason it exists: an administrator
 * looking at a permitted model must be able to tell "this build has verified
 * numbers for this model" from "we assumed the family's numbers" from "we fell
 * back to the smallest window this vendor ships". All three are usable; only
 * the first two are knowledge.
 */
export type AiModelLimitSource = 'explicit' | 'catalogue' | 'derived' | 'default';

/** Rank order for {@link weakestSource}. Higher is weaker evidence. */
const SOURCE_RANK: Record<AiModelLimitSource, number> = {
  explicit: 0,
  catalogue: 1,
  derived: 2,
  default: 3,
};

/**
 * A resolved model, plus where its numbers came from (#97).
 *
 * ⚠ `source` IS THE WEAKEST SOURCE EITHER NUMBER CAME FROM, never the strongest
 * and never the first one looked at. A model whose context window was derived
 * from its family but whose output ceiling fell through to the provider's floor
 * reports `default`, not `derived`. The UI writes a sentence from this field,
 * and a sentence claiming "detected from the gpt-5.4-mini family" about a pair
 * of numbers that is half floor overstates what this deployment knows — which
 * is the one thing the source field exists to stop. Under-claiming costs an
 * administrator nothing; over-claiming costs them the chance to type the real
 * number.
 */
export interface AiResolvedModel extends AiModelDescriptor {
  source: AiModelLimitSource;
  /**
   * The catalogue id the numbers were derived FROM, or null.
   *
   * Non-null exactly when `source === 'derived'`. It carries the family
   * relationship so nothing downstream has to re-derive it — and so the UI can
   * say WHICH model was assumed rather than only that one was.
   */
  derivedFrom: string | null;
}

/**
 * Build the knowledge bundle for one provider (#97).
 *
 * THE ONE ADAPTER BETWEEN A PROVIDER AND THIS FILE. Every call site already
 * holds a provider (or `undefined`, when the policy names one this build does
 * not implement), so this is the whole of what they have to write.
 *
 * ⚠ AN ABSENT PROVIDER IS NOT A SPECIAL CASE. It yields an empty catalogue, no
 * derivation and no floor — which resolves exactly the entries that carry their
 * own numbers and nothing else. Callers used to hand-write `provider
 * ?.capabilities.models ?? []` for this, and the day a second member was added
 * to the bundle (as #97 added two) every one of those sites would have silently
 * kept passing only the first.
 */
export function modelKnowledgeOf<TSettings>(
  provider: AiProvider<TSettings> | undefined | null,
): AiModelKnowledge {
  if (!provider) return { catalogue: [] };

  return {
    catalogue: provider.capabilities.models,
    // Wrapped in an arrow rather than passed as a bare method reference: the
    // method may legitimately read instance state (a provider's own catalogue),
    // and an unbound `this` there fails at the call, deep inside a token-budget
    // check, rather than here.
    derive: provider.deriveModelDescriptor
      ? (id: string) => provider.deriveModelDescriptor?.(id) ?? null
      : undefined,
    fallback: provider.capabilities.defaultModelLimits,
    fallbackFeatures: provider.capabilities.defaultModelFeatures,
  };
}

/**
 * The effective descriptor for one `allowedModels` entry, or `null` when this
 * deployment cannot budget against it at all.
 *
 * `knowledge` is the active provider's, via {@link modelKnowledgeOf}. Pass
 * `modelKnowledgeOf(undefined)` when no provider is registered — that is not a
 * special case, it simply means only entries carrying their own numbers can
 * resolve.
 *
 * ⚠ BOTH NUMBERS ARE REQUIRED FOR A RESOLUTION, not just the context window.
 * The §3.3 budget subtracts the output allowance from the window to get the
 * input allowance, so a descriptor missing `maxOutputTokens` would leave the
 * subtraction with nothing to subtract — and the two plausible repairs are both
 * wrong: falling back to the deployment ceiling silently promises an output
 * length the model may refuse, and treating it as zero publishes a model that
 * can produce nothing. A half-known model is reported as unknown, and the 400
 * on the settings page names the field that is missing. What changed in #97 is
 * only HOW MANY SOURCES may supply each number, never that both are needed.
 */
export function resolveAllowedModel(
  entry: AiAllowedModel,
  knowledge: AiModelKnowledge,
): AiResolvedModel | null {
  const known = exactCatalogueHit(entry.id, knowledge);
  const context = resolveNumber('contextWindowTokens', entry, knowledge, known);
  const output = resolveNumber('maxOutputTokens', entry, knowledge, known);

  if (context.value === null || output.value === null) return null;
  if (context.source === null || output.source === null) return null;

  const source = weakestSource(context.source, output.source);
  const features = resolveFeatures(entry.id, knowledge, known);

  return {
    id: entry.id,
    // The administrator's label, then the catalogue's, then the raw id. NEVER a
    // prettified guess: a label this application invented for a model it knows
    // nothing else about would read as though it knew something.
    //
    // ⚠ A DERIVED DESCRIPTOR'S LABEL IS DELIBERATELY NOT CONSULTED (#97). It
    // describes the FAMILY, and borrowing it would print "GPT-5.4 mini" next to
    // the id `gpt-5.4-mini-2026-03-17` — a different model, named as though
    // this build had a descriptor for it. `derivedFrom` carries the family
    // relationship instead, where a client can render it as the inference it is.
    label: entry.label ?? known?.label ?? entry.id,
    contextWindowTokens: context.value,
    maxOutputTokens: output.value,
    structuredOutput: features.structuredOutput,
    toolCalling: features.toolCalling,
    source,
    // Non-null exactly when the WEAKEST source is `derived`: if either number
    // fell through to the floor the pair is not "the family's numbers", and
    // naming a family here would be the over-claim `source` documents.
    derivedFrom:
      source === 'derived'
        ? (context.derivedFrom ?? output.derivedFrom ?? null)
        : null,
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
 *
 * ⚠ SINCE #97 THIS IS EMPTY WHENEVER ANY RANK CAN ANSWER, which for a
 * registered provider with a declared floor is always. The refusal path is
 * deliberately KEPT rather than deleted: it is still the honest answer for a
 * policy naming a provider this build does not implement, or one that declines
 * to declare a floor, and deleting it would replace a 400 that names two fields
 * with a model saved, listed back, and silently never offered to anybody. What
 * changed is how often it fires, not what it means.
 */
export function missingModelNumbers(
  entry: AiAllowedModel,
  knowledge: AiModelKnowledge,
): string[] {
  const known = exactCatalogueHit(entry.id, knowledge);

  return (['contextWindowTokens', 'maxOutputTokens'] as const).filter(
    (field) => resolveNumber(field, entry, knowledge, known).value === null,
  );
}

/** The build catalogue's descriptor for this exact id, if it has one. */
function exactCatalogueHit(
  id: string,
  knowledge: AiModelKnowledge,
): AiModelDescriptor | undefined {
  return knowledge.catalogue.find((model) => model.id === id);
}

/** One number, with the rank it came from. See {@link resolveNumber}. */
interface ResolvedNumber {
  value: number | null;
  source: AiModelLimitSource | null;
  derivedFrom: string | null;
}

/**
 * The precedence itself, written ONCE, for one number.
 *
 * Private, and every exported function above is a thin wrapper over it — so
 * "the entry, then the catalogue, then the derivation, then the floor, then
 * nothing" exists in exactly one place and the refusal can never name a field
 * the resolution would have filled in.
 *
 * ⚠ THE DERIVATION IS ONLY CONSULTED WHEN THERE IS NO EXACT CATALOGUE HIT, and
 * that is an invariant rather than an optimisation: `AiModelDescriptor` requires
 * BOTH numbers, so an exact hit always answers both ranks 2 and below. Calling a
 * provider's `derive` anyway would spend work on an answer that can never be
 * read — and, worse, would invite an implementation that derived DIFFERENTLY
 * from the catalogue for an id the catalogue already covers.
 */
function resolveNumber(
  field: 'contextWindowTokens' | 'maxOutputTokens',
  entry: AiAllowedModel,
  knowledge: AiModelKnowledge,
  known: AiModelDescriptor | undefined,
): ResolvedNumber {
  const explicit = entry[field];
  if (explicit !== undefined) {
    return { value: explicit, source: 'explicit', derivedFrom: null };
  }

  if (known) {
    return { value: known[field], source: 'catalogue', derivedFrom: null };
  }

  const derived = knowledge.derive?.(entry.id) ?? null;
  if (derived) {
    return { value: derived[field], source: 'derived', derivedFrom: derived.id };
  }

  const fallback = knowledge.fallback;
  if (fallback) {
    return { value: fallback[field], source: 'default', derivedFrom: null };
  }

  return { value: null, source: null, derivedFrom: null };
}

/**
 * The model's capability flags, by rank (#358): an exact catalogue hit, then
 * the family the provider derives, then the provider's feature floor, then
 * `false`.
 *
 * ⚠ THE ENTRY'S OWN NUMBERS DO NOT TAKE PART. An administrator may override a
 * context window (rank 1 of the numbers' precedence) but there is no admin
 * override of a FLAG in v1: typing a number is describing a model; claiming a
 * capability the build cannot verify is the false positive that fails a paid
 * extraction. `source` likewise describes the numbers only.
 */
function resolveFeatures(
  id: string,
  knowledge: AiModelKnowledge,
  known: AiModelDescriptor | undefined,
): AiModelFeatureFlags {
  if (known) {
    return {
      structuredOutput: known.structuredOutput,
      toolCalling: known.toolCalling,
    };
  }

  const derived = knowledge.derive?.(id) ?? null;
  if (derived) {
    return {
      structuredOutput: derived.structuredOutput,
      toolCalling: derived.toolCalling,
    };
  }

  return {
    structuredOutput: knowledge.fallbackFeatures?.structuredOutput ?? false,
    toolCalling: knowledge.fallbackFeatures?.toolCalling ?? false,
  };
}

/** The weaker (higher-ranked) of two sources. See {@link AiResolvedModel}. */
function weakestSource(
  a: AiModelLimitSource,
  b: AiModelLimitSource,
): AiModelLimitSource {
  return SOURCE_RANK[a] >= SOURCE_RANK[b] ? a : b;
}
