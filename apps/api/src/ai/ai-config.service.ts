import { Injectable } from '@nestjs/common';

import { resolveAllowedModel } from './ai-model-resolution';
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
//      has an entry whose context window is known, either from the entry itself
//      (#78) or from the provider's own catalogue, per docs/specs/notes.md
//      §3.3, which needs a number to check a prompt against;
//   4. the token ceilings are coherent (a `maxOutputTokens` at or above the
//      smallest permitted model's whole context window leaves no room for
//      input, so every generation would refuse).
//
// Reporting anything less than all four as "available" moves the failure from a
// disabled control to a failed generation minutes later — which, here, is a
// failure the user has already paid their own provider for.
//
// ⚠ IT DOES NOT DEPEND ON `keyConfigured`. See consequence 3 above.
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
    const keyConfigured = provider
      ? await this.credentials.hasKey(userId, provider.id)
      : false;

    if (!policy.enabled || !providerId || !provider) {
      return {
        available: false,
        provider: null,
        providerLabel: null,
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
    const models: AiConfigModel[] = policy.providers[providerId].allowedModels
      .map((entry) => resolveAllowedModel(entry, provider.capabilities.models))
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
      available: usable.length > 0,
      provider: provider.id,
      providerLabel: provider.label,
      models: usable,
      defaultModel,
      maxInputTokens: policy.maxInputTokens,
      maxOutputTokens: policy.maxOutputTokens,
      keyConfigured,
    };
  }
}
