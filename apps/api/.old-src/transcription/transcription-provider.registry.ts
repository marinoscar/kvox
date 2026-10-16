import { Injectable, Logger } from '@nestjs/common';

import type {
  TranscriptionProvider,
  TranscriptionProviderDescription,
} from './providers/transcription-provider.interface';

// =============================================================================
// TranscriptionProviderRegistry (issue #23, epic #19)
// =============================================================================
//
// The one place that knows which transcription vendors this build can talk to.
// Everything above it — the settings endpoint that lists providers, the config
// endpoint that publishes limits, the job handler issue #25 adds — asks this
// and never imports a provider class.
//
// EXPLICIT SELF-REGISTRATION, same shape as `JobHandlerRegistry` (#259) and for
// the reasons that file argues at length: a `register(this)` line in one file is
// a grep-able answer to "why is this provider available", and a provider that
// failed to register looks different from one that was never written. Decorator
// discovery would replace that line with a boot-time metadata scan and make the
// two look identical.
//
// ⚠ THE LIFECYCLE CONSEQUENCE. Registration happens in each provider's
// `onModuleInit`. Anything that RESOLVES a provider must therefore run no
// earlier than `onApplicationBootstrap` — but in practice nothing here does:
// every consumer resolves a provider inside a request or a job, long after
// boot. The hazard is documented because the day something wants to validate
// settings at startup, this is the note that stops it from being flaky.
//
// -----------------------------------------------------------------------------
// WHY `register` REFUSES AN INCOHERENT PROVIDER RATHER THAN WARNING
// -----------------------------------------------------------------------------
//
// `capabilities.cancel` claims a method exists. If it does not, the failure is a
// `TypeError` inside a cancellation path — which is to say, at the moment
// somebody is trying to stop a job that is costing money, in code that by
// definition runs rarely and is therefore least likely to have been exercised.
// The check is one line at registration, where the fix is obvious and the
// failure is at boot.
// =============================================================================

@Injectable()
export class TranscriptionProviderRegistry {
  private readonly logger = new Logger(TranscriptionProviderRegistry.name);

  private readonly providers = new Map<string, TranscriptionProvider<never>>();

  /**
   * Add a provider. Called by the provider itself from `onModuleInit`.
   *
   * A DUPLICATE ID OVERWRITES AND WARNS, matching `JobHandlerRegistry`: a fork
   * deliberately shadowing a framework provider with its own implementation is
   * a supported thing to do, and refusing it would mean the only way to replace
   * a provider is to patch this repository.
   */
  register<TSettings>(provider: TranscriptionProvider<TSettings>): void {
    if (!provider.id) {
      throw new Error(
        'A transcription provider must declare a non-empty `id`; it is the key used in settings, credentials and stored transcripts.',
      );
    }

    if (provider.capabilities.cancel && typeof provider.cancel !== 'function') {
      throw new Error(
        `Transcription provider "${provider.id}" declares capabilities.cancel but implements no cancel(). ` +
          'Either implement it or set the capability to false — an advertised capability with no method is a TypeError in the cancellation path.',
      );
    }

    if (this.providers.has(provider.id)) {
      this.logger.warn(
        `Transcription provider "${provider.id}" is already registered; the later registration wins.`,
      );
    }

    this.providers.set(
      provider.id,
      provider as unknown as TranscriptionProvider<never>,
    );
    this.logger.log(`Registered transcription provider "${provider.id}"`);
  }

  /**
   * One provider by id, or `undefined`.
   *
   * `undefined` RATHER THAN A THROW: the caller always has a better error than
   * this class can produce. The settings endpoint says "that provider does not
   * exist" as a 400 naming the valid ids; a job handler says "the configured
   * provider is no longer available" and fails the job. A throw here would flatten
   * both into a 500.
   */
  get(id: string): TranscriptionProvider<never> | undefined {
    return this.providers.get(id);
  }

  /** Every registered provider, in registration order. */
  all(): TranscriptionProvider<never>[] {
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
   * mutate `fieldDescriptors` in place for everyone. The arrays are copied for
   * the same reason.
   */
  describeAll(): TranscriptionProviderDescription[] {
    return this.all().map((provider) => ({
      id: provider.id,
      label: provider.label,
      capabilities: {
        ...provider.capabilities,
        acceptedMimeTypes: [...provider.capabilities.acceptedMimeTypes],
      },
      fieldDescriptors: provider.fieldDescriptors.map((descriptor) => ({
        ...descriptor,
        options: descriptor.options
          ? descriptor.options.map((option) => ({ ...option }))
          : undefined,
      })),
    }));
  }
}
