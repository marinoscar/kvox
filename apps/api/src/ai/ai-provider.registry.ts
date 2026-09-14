import { Injectable, Logger } from '@nestjs/common';

import type {
  AiProvider,
  AiProviderDescription,
} from './providers/ai-provider.interface';

// =============================================================================
// AiProviderRegistry (issue #47, epic #45)
// =============================================================================
//
// The one place that knows which AI vendors this build can talk to. Everything
// above it — the admin settings endpoint that lists providers, the capability
// probe that publishes permitted models, the per-user credential service that
// refuses a key for a provider nobody implements, and the `note.generate`
// handler issue #49 adds — asks this and never imports a provider class.
//
// EXPLICIT SELF-REGISTRATION, same shape as `TranscriptionProviderRegistry` and
// `JobHandlerRegistry`, and for the reasons those files argue at length: a
// `register(this)` line in one file is a grep-able answer to "why is this
// provider available", and a provider that failed to register looks different
// from one that was never written. Decorator discovery would replace that line
// with a boot-time metadata scan and make the two look identical.
//
// ⚠ THE LIFECYCLE CONSEQUENCE. Registration happens in each provider's
// `onModuleInit`. Anything that RESOLVES a provider must therefore run no
// earlier than `onApplicationBootstrap` — in practice nothing here does, since
// every consumer resolves a provider inside a request or a job. The hazard is
// documented because the day something wants to validate settings at startup,
// this is the note that stops it from being flaky.
//
// -----------------------------------------------------------------------------
// WHY `register` REFUSES AN INCOHERENT PROVIDER RATHER THAN WARNING
// -----------------------------------------------------------------------------
//
// Two checks, both one line, both at boot where the fix is obvious:
//
//   • A provider with no `id` is unaddressable — `id` is the key in the `ai`
//     settings namespace, in `user_ai_credentials.provider`, and in
//     `notes.provider`.
//
//   • A provider declaring NO MODELS is one nothing can ever be generated with:
//     `ai.providers.<id>.allowedModels` is intersected with
//     `capabilities.models` at read time, so an empty catalogue makes every
//     model in the policy vanish and `GET /api/ai/config` report a feature that
//     is permanently unavailable for a reason no error mentions. Refusing at
//     registration turns that into a boot failure naming the provider.
//
// There is no `capabilities.streaming` check, deliberately: the interface types
// that field as the literal `true`, so a non-streaming provider does not
// compile and there is nothing left for a runtime check to catch.
// =============================================================================

@Injectable()
export class AiProviderRegistry {
  private readonly logger = new Logger(AiProviderRegistry.name);

  private readonly providers = new Map<string, AiProvider<never>>();

  /**
   * Add a provider. Called by the provider itself from `onModuleInit`.
   *
   * A DUPLICATE ID OVERWRITES AND WARNS, matching `JobHandlerRegistry` and
   * `TranscriptionProviderRegistry`: a fork deliberately shadowing a framework
   * provider with its own implementation is a supported thing to do, and
   * refusing it would mean the only way to replace a provider is to patch this
   * repository.
   */
  register<TSettings>(provider: AiProvider<TSettings>): void {
    if (!provider.id) {
      throw new Error(
        'An AI provider must declare a non-empty `id`; it is the key used in the `ai` settings namespace, in user_ai_credentials.provider and in notes.provider.',
      );
    }

    if (
      !Array.isArray(provider.capabilities?.models) ||
      provider.capabilities.models.length === 0
    ) {
      throw new Error(
        `AI provider "${provider.id}" declares no models. A provider with an empty model catalogue can never be generated with — the deployment's allowedModels policy is intersected with this list — so it would advertise a feature that is permanently unavailable.`,
      );
    }

    if (this.providers.has(provider.id)) {
      this.logger.warn(
        `AI provider "${provider.id}" is already registered; the later registration wins.`,
      );
    }

    this.providers.set(provider.id, provider as unknown as AiProvider<never>);
    this.logger.log(`Registered AI provider "${provider.id}"`);
  }

  /**
   * One provider by id, or `undefined`.
   *
   * `undefined` RATHER THAN A THROW: the caller always has a better error than
   * this class can produce. The credential endpoint says "that provider does
   * not exist" as a 400 naming the valid ids; the config probe reports
   * `available: false`; a job handler fails the job. A throw here would flatten
   * all three into a 500.
   */
  get(id: string): AiProvider<never> | undefined {
    return this.providers.get(id);
  }

  /** Every registered provider, in registration order. */
  all(): AiProvider<never>[] {
    return [...this.providers.values()];
  }

  /** Every registered provider id. */
  ids(): string[] {
    return [...this.providers.keys()];
  }

  /**
   * The publishable description of every provider: what the admin form renders
   * and what the config endpoint reports.
   *
   * A PROJECTION, never the provider objects themselves. Handing out the live
   * objects would put `settingsSchema` (a zod schema, unserialisable) and every
   * method on a path that ends in `JSON.stringify`, and would let a caller
   * mutate `fieldDescriptors` or `models` in place for everyone. Every array is
   * copied for the same reason.
   */
  describeAll(): AiProviderDescription[] {
    return this.all().map((provider) => ({
      id: provider.id,
      label: provider.label,
      capabilities: {
        ...provider.capabilities,
        models: provider.capabilities.models.map((model) => ({ ...model })),
      },
      fieldDescriptors: provider.fieldDescriptors.map((descriptor) => ({
        ...descriptor,
        options: descriptor.options
          ? descriptor.options.map((option) => ({ ...option }))
          : undefined,
        defaultValue: Array.isArray(descriptor.defaultValue)
          ? [...descriptor.defaultValue]
          : descriptor.defaultValue,
      })),
    }));
  }
}
