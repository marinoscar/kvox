import { Injectable, Logger } from '@nestjs/common';

import { EMBEDDING_DIMENSIONS } from './providers/ai-provider.interface';
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
//   • A provider declaring `capabilities.modelDiscovery` with NO `listModels`
//     method (#78) — the same check `TranscriptionProviderRegistry` makes for
//     `capabilities.cancel`, and the same argument: an advertised capability
//     with no method is a `TypeError` in the path least likely to have been
//     exercised. Here that path is an administrator pressing "load models from
//     the provider" on a page opened once a quarter, and the exception would
//     surface as a 500 with a stack frame instead of as the misconfiguration it
//     is. One line at boot, where the fix is obvious.
//
//   • A provider declaring `embedding` with NO `embed` method, or `embed` with
//     no `embedding` (#183) — the third instance of the same check and the same
//     argument, because embeddings follow the same "presence is the
//     declaration" rule. The path an advertised-but-missing `embed` would blow
//     up in is worse than the discovery one: not a settings page an
//     administrator is looking at, but a `search.index` queue job running
//     unattended over somebody's whole corpus.
//
//   • A provider whose `embedding.dimensions` IS NOT `EMBEDDING_DIMENSIONS`
//     (#183). THE LOAD-BEARING ONE. The vector column is `vector(1536)`, and
//     that is a CONTRACT, NOT A DEFAULT: a model with a different output width
//     cannot be stored at all — not stored badly, not stored with reduced
//     quality, not stored. Without this line the failure is a Postgres type
//     error raised inside a queue job, at whatever hour the indexing job
//     happens to run, with a stack frame pointing at an `INSERT` and NOTHING
//     anywhere pointing at the provider that declared the wrong number. One
//     line at boot turns that into a startup failure naming the provider and
//     the width it declared, where the fix is obvious. The constant is exported
//     from `providers/ai-provider.interface.ts` so this check and the migration
//     that created the column are two halves of one decision rather than two
//     numbers that can drift.
//
//   • A provider declaring `embedding.maxBatchSize` or `embedding.maxInputTokens`
//     below 1 (#183). A zero batch size makes an indexer either loop forever
//     taking no inputs per pass or refuse every input, depending on which way
//     it rounds; a zero input ceiling refuses every chunk. Both are silent and
//     both look like "search just never finishes".
//
// There is no `capabilities.streaming` check, deliberately: the interface types
// that field as the literal `true`, so a non-streaming provider does not
// compile and there is nothing left for a runtime check to catch. Note the
// asymmetry with `modelDiscovery`, which IS `boolean` — discovery is genuinely
// declinable, streaming is not.
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

    if (
      provider.capabilities.modelDiscovery &&
      typeof provider.listModels !== 'function'
    ) {
      throw new Error(
        `AI provider "${provider.id}" declares capabilities.modelDiscovery but implements no listModels(). ` +
          'Either implement it or set the capability to false — an advertised capability with no method is a TypeError in the model-discovery path, which an administrator reaches from a settings page and nothing else exercises.',
      );
    }

    // #358: the same "an advertised capability with no method" check, for
    // structured output. Any model flagged — or the floor claiming it for ids
    // the provider cannot place — without `generateStructured` would be a
    // TypeError inside a paid graph-extraction job.
    const advertisesStructuredOutput =
      provider.capabilities.models.some((model) => model.structuredOutput === true) ||
      provider.capabilities.defaultModelFeatures?.structuredOutput === true;

    if (
      advertisesStructuredOutput &&
      typeof provider.generateStructured !== 'function'
    ) {
      throw new Error(
        `AI provider "${provider.id}" declares structuredOutput on a model (or in defaultModelFeatures) but implements no generateStructured(). ` +
          'Either implement it or set every structuredOutput flag to false — an advertised capability with no method is a TypeError inside a structured-output job, the path least likely to have been exercised.',
      );
    }

    const declaresEmbedding = provider.embedding !== undefined;
    const implementsEmbed = typeof provider.embed === 'function';

    if (declaresEmbedding !== implementsEmbed) {
      throw new Error(
        `AI provider "${provider.id}" declares ${declaresEmbedding ? 'an `embedding` capability but implements no embed()' : 'an embed() method but no `embedding` capability'}. ` +
          'Declare both or neither (#183) — a capability with no method is a TypeError inside a search.index job running unattended, and a method nothing advertises is one no caller can discover.',
      );
    }

    if (provider.embedding) {
      if (provider.embedding.dimensions !== EMBEDDING_DIMENSIONS) {
        throw new Error(
          `AI provider "${provider.id}" declares embedding.dimensions ${provider.embedding.dimensions}, but this application stores vectors in a vector(${EMBEDDING_DIMENSIONS}) column. ` +
            'That width is a contract, not a default: a vector of any other width cannot be stored at all, and without this check the failure would be a Postgres type error inside a queue job with nothing pointing back at this declaration.',
        );
      }

      if (
        !(provider.embedding.maxBatchSize >= 1) ||
        !(provider.embedding.maxInputTokens >= 1)
      ) {
        throw new Error(
          `AI provider "${provider.id}" declares embedding.maxBatchSize ${provider.embedding.maxBatchSize} and embedding.maxInputTokens ${provider.embedding.maxInputTokens}; both must be at least 1. ` +
            'A zero batch size makes an indexer loop forever or refuse every input, and a zero input ceiling refuses every chunk — both silently.',
        );
      }
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
   *
   * `capabilities` is spread WHOLESALE rather than field by field, so
   * `modelDiscovery` (#78) and anything a later issue adds reach the admin form
   * without a second edit here. The admin page reads it to decide whether to
   * offer "load models from the provider" at all, so a provider that cannot
   * discover renders a plain text field instead of a dead button.
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
