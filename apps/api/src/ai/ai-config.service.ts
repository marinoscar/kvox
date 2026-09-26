import { Injectable } from '@nestjs/common';

import { modelKnowledgeOf, resolveAllowedModel } from './ai-model-resolution';
import { AiProviderRegistry } from './ai-provider.registry';
import { AiSettingsService } from './ai-settings.service';
import { UserAiCredentialsService } from './user-ai-credentials.service';
import type { AiConfigResponse, AiConfigModel } from './dto/ai-config.dto';

// =============================================================================
// AiConfigService (issue #47, epic #45)
// =============================================================================
//
// Answers TWO questions for an ordinary user: "may this deployment offer AI at
// all, and with what?" and "have I set up a key?" — the capability, never the
// configuration behind it. `AiConfigController`'s header states why this is a
// separate surface from `GET /api/ai-settings`; this file states what goes in
// it.
//
// -----------------------------------------------------------------------------
// `keyConfigured` IS THE ONE BOOLEAN THE WEB UI GATES ON
// -----------------------------------------------------------------------------
//
// Issue #47 is explicit about this: EVERY AI surface in epic #45 reads
// `keyConfigured` and nothing else to decide whether to render the "set up your
// key" prompt instead of the feature. Three consequences follow, and all three
// are constraints on this file:
//
//   1. IT IS PER-CALLER, not per-deployment. It is the answer for the user
//      making this request, resolved from their own row in
//      `user_ai_credentials` — which is why this service takes a `userId` while
//      `TranscriptionConfigService.getConfig()` takes nothing.
//
//   2. IT IS READ WITHOUT DECRYPTING ANYTHING. `UserAiCredentialsService
//      .hasKey` selects `{ id: true }`. A path that decrypts a credential to
//      answer a capability question is a path one careless `return` away from
//      publishing it.
//
//   3. IT IS INDEPENDENT OF `available`. A user with a key on a deployment
//      where AI is switched off gets `available: false, keyConfigured: true`,
//      and a user with no key on a working deployment gets the reverse. Folding
//      them into one flag would make the UI unable to tell "your administrator
//      has not turned this on" from "you have not pasted a key", which are
//      different sentences with different fixes and different people to talk to.
//
// -----------------------------------------------------------------------------
// `provider` IS INDEPENDENT OF `available` TOO — AND NOT NOTICING THAT WAS A BUG
// -----------------------------------------------------------------------------
//
// The two fields answer different questions, and only one of them is about
// permission:
//
//   • `provider`/`providerLabel` answer WHICH VENDOR A KEY WOULD BELONG TO. It
//     is a naming question, and it has an answer the moment an administrator's
//     settings row names a provider this build has a registry entry for.
//   • `available` answers MAY AI BE USED RIGHT NOW. That is the four-fact
//     conjunction below, and the master switch is one of the four.
//
// Issue #83 is what conflating them costs, and the loop is closed at both ends.
// `DEFAULT_SYSTEM_SETTINGS.ai` ships `enabled: false` with `provider: 'openai'`,
// so EVERY fresh deployment starts in the state where a provider is named but
// the switch is off. This method used to blank `provider` in that state; the key
// form on `/settings/ai` derives its whole enablement from `config.provider`, so
// no user could save a key. An administrator could not break the tie either:
// populating `allowedModels` through "Load models from provider" calls the
// vendor with THEIR OWN key, which they were equally unable to save. Nobody
// could go first. A field that exists to name a vendor had been made to also
// mean "you are allowed to proceed", and the second meaning ate the first.
//
// So: `provider` is resolved ONCE, before any branch, and travels through BOTH
// returns. `provider: null` is now reserved for the two cases where there
// genuinely is no vendor to name, and those two remain indistinguishable to a
// client on purpose (there is nothing useful it could do differently):
//
//   a. `ai.provider` is null — nobody has chosen a vendor;
//   b. `ai.provider` names a provider THIS BUILD has never heard of — a
//      deployment rolled back across the addition of a provider. Naming it
//      anyway would hand a client a vendor id no code here can act on.
//
// "A real provider is chosen, but AI is switched off or nothing is permitted
// yet" is NOT one of those cases and must never return null again. Nothing else
// about the not-available branch changes: `available` stays `false`, and
// `models: []` / `defaultModel: null` stay empty, because a client must not be
// handed a model the server would refuse the moment it was used.
//
// -----------------------------------------------------------------------------
// `available` IS A CONJUNCTION OF FOUR FACTS, AND ALL FOUR ARE NECESSARY
// -----------------------------------------------------------------------------
//
//   1. the master switch is on;
//   2. a provider is CHOSEN (`ai.provider` is not null) and is REGISTERED IN
//      THIS BUILD — a fresh deployment has chosen nobody, and a deployment
//      rolled back across the addition of a provider has a settings row naming
//      one this process has never heard of. Both are ordinary, both are
//      `available: false`, and neither is an error;
//   3. at least one PERMITTED model can be BUDGETED — that is, `allowedModels`
//      has an entry `resolveAllowedModel` can put two numbers to: the entry's
//      own (#78), the build catalogue's, the family the id belongs to, or the
//      provider's conservative floor (#97), per docs/specs/notes.md §3.3, which
//      needs a number to check a prompt against. Since #97 the last two ranks
//      mean this fact fails only when the policy names a provider this build
//      does not implement — and each published model carries a `source` saying
//      which rank answered, so a client can show an inference as one;
//   4. the token ceilings are coherent (a `maxOutputTokens` at or above the
//      smallest permitted model's whole context window leaves no room for
//      input, so every generation would refuse).
//
// Reporting anything less than all four as "available" moves the failure from a
// disabled control to a failed generation minutes later — which, here, is a
// failure the user has already paid their own provider for.
//
// ⚠ IT DOES NOT DEPEND ON `keyConfigured`, AND IT IS NOT WHAT `provider`
// REPORTS. See the two sections above.
// =============================================================================

@Injectable()
export class AiConfigService {
  constructor(
    private readonly settings: AiSettingsService,
    private readonly registry: AiProviderRegistry,
    private readonly credentials: UserAiCredentialsService,
  ) {}

  /**
   * The capability answer, for one caller.
   *
   * NEVER THROWS FOR AN UNCONFIGURED DEPLOYMENT — "nothing is set up" is the
   * normal state of a fresh installation and is reported as `available: false`,
   * not as an error. A client asking "may I offer this?" and getting a 500 has
   * learned nothing it can act on.
   */
  async getConfig(userId: string): Promise<AiConfigResponse> {
    const policy = await this.settings.get();

    // ⚠ RESOLVED THROUGH THE POLICY'S OWN `provider` AXIS, never a hardcoded
    // `'openai'` (#78). The literal that used to be here was the reason adding
    // a second OpenAI-compatible vendor would have required editing this file:
    // a deployment could name the new provider in its settings and this probe
    // would have gone on describing the old one.
    //
    // `provider: null` — nobody has chosen one — takes the SAME path as a
    // provider this build has never heard of, which is `available: false` and
    // never a throw. Both are ordinary states (a fresh installation; a rollback
    // across the addition of a provider), and a client asking "may I offer
    // this?" that gets a 500 has learned nothing it can act on.
    const providerId = policy.provider;
    const provider = providerId ? this.registry.get(providerId) : undefined;

    // Resolved regardless of `available`, and deliberately: a user must be able
    // to save and verify their key BEFORE an administrator finishes turning the
    // feature on, and a client rendering a disabled control still wants to say
    // "your key is set up" rather than nothing.
    //
    // ⚠ THE SAME ARGUMENT APPLIES WORD FOR WORD TO THE TWO LINES BELOW, and
    // issue #83 is what it cost to have made it for only one of the three. A
    // key belongs to a VENDOR; a form that cannot name the vendor cannot offer
    // to save the key; so blanking `provider` while AI is switched off is
    // exactly as breaking as blanking `keyConfigured` would be. These three
    // values are resolved together, above every branch, so the next branch
    // added here inherits the independence instead of having to remember it.
    const keyConfigured = provider
      ? await this.credentials.hasKey(userId, provider.id)
      : false;
    const resolvedProvider = provider?.id ?? null;
    const resolvedProviderLabel = provider?.label ?? null;

    if (!policy.enabled || !providerId || !provider) {
      return {
        // Fact 1 or fact 2 has failed. Nothing may be generated right now, and
        // this is the ordinary state of a deployment nobody has finished
        // setting up — not an error.
        available: false,
        // ⚠ CARRIED THROUGH, NOT BLANKED (#83). Null here would mean "there is
        // no vendor to name", which is false: an administrator named one and
        // this build knows it. The key form reads this field to decide which
        // vendor it is collecting a key FOR, and a user has to be able to get a
        // key in place before the switch is flipped — otherwise the first
        // administrator of a fresh deployment cannot load the model list their
        // own key is needed to fetch, and setup deadlocks with no error
        // anywhere. It stays null only in the two genuinely nameless cases,
        // which is `provider === undefined` above.
        provider: resolvedProvider,
        providerLabel: resolvedProviderLabel,
        // Empty on purpose, and NOT for the same reason. A model list is an
        // offer, and every model on it here would be refused the moment it was
        // used — either the master switch is off or nothing has been permitted
        // yet. Naming the vendor costs a client nothing; handing it a model it
        // cannot use costs it a failed generation.
        models: [],
        defaultModel: null,
        maxInputTokens: policy.maxInputTokens,
        maxOutputTokens: policy.maxOutputTokens,
        keyConfigured,
      };
    }

    // Fact 3: every permitted model this deployment can BUDGET, in the policy's
    // own order so an administrator's preferred ordering survives to the model
    // picker.
    //
    // ⚠ NO LONGER A PLAIN INTERSECTION WITH THE BUILD CATALOGUE (#78). A policy
    // entry may carry its own `contextWindowTokens` and `maxOutputTokens`, and
    // such a model is published here even though no release of this application
    // has heard of it — otherwise model discovery would list sixty models an
    // administrator could permit and this endpoint would offer the four
    // hardcoded ones. `resolveAllowedModel` is the ONE implementation of that
    // precedence and `AiSettingsService` calls the same function to decide what
    // to report as `unknownModels`, so the two answers cannot drift.
    //
    // An entry that resolves to NOTHING is still omitted rather than published
    // with a guessed context window — see that function for why guessing is
    // wrong in both directions.
    //
    // ⚠ SINCE #97 "NOTHING" IS A MUCH NARROWER CASE, and the branch is kept
    // exactly as it was on purpose. The resolver now falls through to the
    // provider's family derivation and then to its conservative floor, so a
    // permitted model is dropped here only when this build has no provider
    // knowledge at all — a policy naming a vendor this process does not
    // implement. `source` below is what tells the picker how much of each
    // number is knowledge and how much is a floor, which is the honest way to
    // publish an inference rather than suppressing it.
    const models: AiConfigModel[] = policy.providers[providerId].allowedModels
      .map((entry) => resolveAllowedModel(entry, modelKnowledgeOf(provider)))
      .filter((model): model is NonNullable<typeof model> => model !== null)
      .map((model) => ({
        id: model.id,
        label: model.label,
        // The EFFECTIVE ceilings, already narrowed by deployment policy, so a
        // client never has to compute the minimum itself and never shows a
        // number the server would then refuse.
        contextWindowTokens: Math.min(
          model.contextWindowTokens,
          policy.maxInputTokens + policy.maxOutputTokens,
        ),
        maxOutputTokens: Math.min(model.maxOutputTokens, policy.maxOutputTokens),
        // #358: which rank of the catalogue/derivation/floor answered, never
        // an administrator override — see `resolveFeatures`.
        structuredOutput: model.structuredOutput,
        // #359: same ranks, same "never an administrator override".
        toolCalling: model.toolCalling,
        // ⚠ THE SOURCE DESCRIBES THE MODEL'S OWN NUMBERS, NOT THE NARROWED ONES
        // ABOVE (#97). Deployment policy always narrows, and it narrows a
        // verified window and an inferred one identically — so re-labelling a
        // capped `catalogue` model as something weaker would tell a user this
        // build is unsure about a number it verified. What this field answers is
        // "how did we learn this model's size", which the `Math.min` does not
        // change.
        source: model.source,
        derivedFrom: model.derivedFrom,
      }));

    // Fact 4: a model whose effective output ceiling leaves no room for input
    // is one every generation would refuse at the budget check, so it is not
    // offered at all.
    const usable = models.filter(
      (model) => model.contextWindowTokens > model.maxOutputTokens,
    );

    // The configured default when it survived the intersection, otherwise the
    // first usable model — never a model that is not on the list, which is the
    // one value a client would offer and the server would then refuse.
    const configuredDefault = policy.providers[providerId].defaultModel;
    const defaultModel =
      usable.find((model) => model.id === configuredDefault)?.id ??
      usable[0]?.id ??
      null;

    return {
      // Facts 1 and 2 held to get here; `usable` is facts 3 and 4. Note that
      // this can still be `false` while `provider` below is non-null — that is
      // the whole point of the two fields being separate.
      available: usable.length > 0,
      provider: resolvedProvider,
      providerLabel: resolvedProviderLabel,
      models: usable,
      defaultModel,
      maxInputTokens: policy.maxInputTokens,
      maxOutputTokens: policy.maxOutputTokens,
      keyConfigured,
    };
  }
}
