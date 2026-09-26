import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
} from '@nestjs/common';

import { AiConfigService } from './ai-config.service';
import { AiProviderRegistry } from './ai-provider.registry';
import type {
  AiReasoningEffort,
  AiTaskKey,
  SystemAiValue,
} from './ai-settings.schema';
import { AiSettingsService } from './ai-settings.service';
import { chooseTaskModel, taskDefinition } from './ai-task-models';
import type { AiConfigModel, AiConfigResponse } from './dto/ai-config.dto';
import type { AiProvider } from './providers/ai-provider.interface';

// =============================================================================
// AiTaskModelResolver (issue #360)
// =============================================================================
//
// THE ONE PLACE A RUN decides which provider, model and reasoning effort it
// uses, and refuses with the right status when it cannot. Two entry points:
//
//   • `resolve(userId, task, requested?)` — a connected-knowledge task. Applies
//     `ai.graphEnabled`, the per-task model (`ai.taskModels`), the permitted
//     list and the task's required capabilities, via the pure
//     `chooseTaskModel` the admin view and `GET /api/ai/config` also call — so
//     what those two SAY a task would run on is what it DOES run on.
//   • `resolveForGeneration(userId, requested, messages)` — the notes path,
//     which has no task and no capability requirement. It performs exactly
//     the checks `NoteGenerationRequestService.resolveModel` always made, in
//     the same order, with the caller's own sentences, so extracting it here
//     changed no note-generation response.
//
// ⚠ BRING-YOUR-OWN-KEY IS PRESERVED BY CONSTRUCTION. A `requested` model is
// only ever chosen from `AiConfigService.getConfig(userId).models` — the
// permitted, budgetable list — so no caller-supplied string can reach a model
// the deployment does not permit, and every call runs on the caller's own key.
// =============================================================================

/**
 * The four 409 `details.reason` strings the task resolver can answer with.
 *
 * ⚠ THIS OBJECT OWNS THESE STRINGS. `GRAPH_CONFLICT_REASONS` (#354) repeats the
 * same four values so a graph controller maps one union and may rethrow a
 * resolver exception unchanged; the values must never drift. `ai_not_configured`
 * and `ai_key_missing` are also `NOTE_CONFLICT_REASONS`' values, and the notes
 * path relies on that.
 */
export const AI_CONFLICT_REASONS = {
  GRAPH_DISABLED: 'graph_disabled',
  AI_NOT_CONFIGURED: 'ai_not_configured',
  AI_KEY_MISSING: 'ai_key_missing',
  MODEL_LACKS_CAPABILITY: 'model_lacks_capability',
} as const;

export type AiConflictReason =
  (typeof AI_CONFLICT_REASONS)[keyof typeof AI_CONFLICT_REASONS];

/**
 * The 400 `details.reason` for a model outside the permitted list — shared by
 * the run-time resolver and save-time validation in `AiSettingsService`, so a
 * client maps one value.
 */
export const AI_MODEL_NOT_PERMITTED = 'model_not_permitted' as const;

/** Everything a run needs to call a model, resolved and checked. */
export interface AiModelResolution {
  providerId: string;
  provider: AiProvider<never>;
  model: string;
  reasoningEffort: AiReasoningEffort;
  /** `provider.countTokens(text, model)`, bound to this resolution's model. */
  countTokens: (text: string) => number;
  /** The chosen model as `GET /api/ai/config` publishes it, with its flags. */
  descriptor: AiConfigModel;
  policy: SystemAiValue;
  source: 'requested' | 'task' | 'default';
}

/** The two refusal sentences a `resolveForGeneration` caller supplies. */
export interface GenerationRefusalMessages {
  notConfigured: string;
  keyMissing: string;
}

@Injectable()
export class AiTaskModelResolver {
  private readonly logger = new Logger(AiTaskModelResolver.name);

  constructor(
    private readonly aiConfig: AiConfigService,
    private readonly settings: AiSettingsService,
    private readonly registry: AiProviderRegistry,
  ) {}

  /**
   * The model one connected-knowledge task runs on for `userId`, or a refusal.
   * Check order (issue #360): graph switch → AI configured → caller's key →
   * requested model permitted (400) → any model at all → provider registered →
   * required capabilities.
   */
  async resolve(
    userId: string,
    task: AiTaskKey,
    requested?: string | null,
  ): Promise<AiModelResolution> {
    const definition = taskDefinition(task);
    const policy = await this.settings.get();

    if (!policy.graphEnabled) {
      throw new ConflictException({
        message:
          'Connected knowledge is switched off for this deployment. An administrator can enable it in AI settings.',
        details: { reason: AI_CONFLICT_REASONS.GRAPH_DISABLED },
      });
    }

    const config = await this.aiConfig.getConfig(userId);
    const notConfigured = () =>
      new ConflictException({
        message: `AI features are not configured for this deployment, so ${definition.label.toLowerCase()} cannot run. An administrator can enable them in AI settings.`,
        details: { reason: AI_CONFLICT_REASONS.AI_NOT_CONFIGURED },
      });

    if (!config.available || !config.provider) throw notConfigured();

    if (!config.keyConfigured) {
      throw new ConflictException({
        message: `You have not saved an AI API key. ${definition.label} runs on your own provider account, so it needs your key. Add one in your settings and try again.`,
        details: { reason: AI_CONFLICT_REASONS.AI_KEY_MISSING },
      });
    }

    const choice = chooseTaskModel({
      policy,
      models: config.models,
      task,
      requested,
    });

    if (choice.staleTaskModel) {
      // Never user data: the task key and the admin-configured model id only.
      this.logger.warn({
        msg: 'Configured task model is no longer permitted; using the default model',
        task,
        configuredModel: policy.taskModels[task]?.model,
      });
    }

    if (choice.problem === 'not_permitted') {
      throw new BadRequestException({
        message: notPermittedMessage(choice.model, config),
        details: { reason: AI_MODEL_NOT_PERMITTED, task, model: choice.model },
      });
    }

    if (choice.problem === 'no_model' || choice.model === null) {
      throw notConfigured();
    }

    const provider = this.registry.get(config.provider);
    if (!provider) throw notConfigured();

    if (choice.problem === 'lacks_capability') {
      throw new ConflictException({
        message: `The model "${choice.model}" cannot be used for ${definition.label.toLowerCase()}: it lacks ${choice.missing.join(', ')}. Choose a model that supports it, or ask an administrator to change the task model.`,
        details: {
          reason: AI_CONFLICT_REASONS.MODEL_LACKS_CAPABILITY,
          task,
          model: choice.model,
          missing: choice.missing,
        },
      });
    }

    // `graph_disabled` was refused above, and every other problem has thrown,
    // so `choice.source` is one of the three concrete ranks here.
    return this.resolution(
      provider,
      choice.model,
      choice.reasoningEffort,
      config,
      policy,
      choice.source as AiModelResolution['source'],
    );
  }

  /**
   * The notes path: no task, no capability requirement, the caller's own 409
   * sentences. Exactly `NoteGenerationRequestService.resolveModel`'s checks,
   * in its order, with its 400 wording — see this file's header.
   */
  async resolveForGeneration(
    userId: string,
    requested: string | null,
    messages: GenerationRefusalMessages,
  ): Promise<AiModelResolution> {
    const config = await this.aiConfig.getConfig(userId);

    if (!config.available || !config.provider) {
      throw new ConflictException({
        message: messages.notConfigured,
        details: { reason: AI_CONFLICT_REASONS.AI_NOT_CONFIGURED },
      });
    }

    if (!config.keyConfigured) {
      throw new ConflictException({
        message: messages.keyMissing,
        details: { reason: AI_CONFLICT_REASONS.AI_KEY_MISSING },
      });
    }

    const model = requested ?? config.defaultModel;

    if (!model || !config.models.some((entry) => entry.id === model)) {
      throw new BadRequestException(notPermittedMessage(model, config));
    }

    const provider = this.registry.get(config.provider);

    if (!provider) {
      // `AiConfigService.available` already required the provider to be
      // registered, so this is unreachable in practice; it is a 409 rather than
      // a thrown 500 because "this build does not have that provider" is a
      // deployment state, not a bug in the request.
      throw new ConflictException({
        message: `This version of the application does not have the "${config.provider}" provider.`,
        details: { reason: AI_CONFLICT_REASONS.AI_NOT_CONFIGURED },
      });
    }

    const policy = await this.settings.get();

    return this.resolution(
      provider,
      model,
      policy.reasoningEffort,
      config,
      policy,
      requested !== null ? 'requested' : 'default',
    );
  }

  private resolution(
    provider: AiProvider<never>,
    model: string,
    reasoningEffort: AiReasoningEffort,
    config: AiConfigResponse,
    policy: SystemAiValue,
    source: AiModelResolution['source'],
  ): AiModelResolution {
    // Present by construction: both callers only reach here with a model id
    // taken from, or checked against, `config.models`.
    const descriptor = config.models.find((entry) => entry.id === model)!;

    return {
      providerId: provider.id,
      provider,
      model,
      reasoningEffort,
      countTokens: (text: string) => provider.countTokens(text, model),
      descriptor,
      policy,
      source,
    };
  }
}

/** The permitted-list refusal sentence, shared by both entry points. */
function notPermittedMessage(
  model: string | null,
  config: AiConfigResponse,
): string {
  return (
    `The model "${model ?? 'none'}" is not one this deployment permits. Choose one of: ` +
    `${config.models.map((entry) => entry.id).join(', ')}.`
  );
}
