import {
  Inject,
  Injectable,
  Module,
  type DynamicModule,
  type OnModuleInit,
  type Provider,
} from '@nestjs/common';

import { KVOX_AUTH_PERMISSIONS, documentKvoxAuth } from '../core/index.js';
import { AssemblyAiProvider } from './providers/assemblyai.provider.js';
import type { TranscriptionProvider } from './providers/transcription-provider.interface.js';
import { TranscriptionConfigController } from './transcription-config.controller.js';
import { TranscriptionConfigService } from './transcription-config.service.js';
import { TranscriptionProviderRegistry } from './transcription-provider.registry.js';
import { TranscriptionSettingsController } from './transcription-settings.controller.js';
import { TranscriptionSettingsService } from './transcription-settings.service.js';
import {
  DEFAULT_TRANSCRIPTION_PERMISSIONS,
  TRANSCRIPTION_EXTRA_PROVIDERS,
  type TranscriptionModuleOptions,
} from './transcription.options.js';

// =============================================================================
// TranscriptionModule (issue #23, epic #19; packaged by issue #492, epic #491)
// =============================================================================
//
// The provider framework, the providers themselves, and the two admin/config
// surfaces over them. The pipeline's job handlers (the transcripts slice) import
// this module for the registry and the settings service and change nothing here.
//
// `forRoot` is the only way in, and the module is NOT global: a consumer lists
// the returned module in `imports`, so the set of modules that can reach the
// settings service (which can read a provider key through the secrets port) stays
// a list a person can read.
//
// EVERY ENABLED PROVIDER IS REGISTERED UNCONDITIONALLY, not chosen here from the
// configured `provider` setting. Provider selection is a per-job, RUNTIME
// decision: the setting lives in the database and an administrator can change it
// without a restart, so a module-construction-time choice would be stale the
// moment they did. Providers are cheap to instantiate (none opens a socket or
// reads a credential until its first call), so registering all of them and
// letting the settings pick costs nothing.
//
// WHAT IT NEEDS FROM THE HOST: the settings, secrets and identity ports (and
// audit, which is optional). Nothing else: no Prisma, no object store, no jobs.
// =============================================================================

/**
 * Registers the instances of `extraProviders` with the registry when the module
 * starts. The built-in provider registers itself; an extra provider is any class
 * with the provider shape and does not know the registry exists.
 */
@Injectable()
class ExtraProviderRegistrar implements OnModuleInit {
  constructor(
    private readonly registry: TranscriptionProviderRegistry,
    @Inject(TRANSCRIPTION_EXTRA_PROVIDERS) private readonly providers: TranscriptionProvider[],
  ) {}

  onModuleInit(): void {
    for (const provider of this.providers) this.registry.register(provider);
  }
}

/**
 * The transcription slice: provider registry, the AssemblyAI provider, the
 * settings service, the capability service and their two controllers
 * (`/api/transcription-settings`, `/api/transcription/config`).
 *
 * @stability experimental
 */
@Module({})
export class TranscriptionModule {
  /**
   * Builds the module over the host's ports.
   *
   * @param options - built-in providers, extra providers and the permission strings.
   * @returns the dynamic module; it exports {@link TranscriptionProviderRegistry},
   *   {@link TranscriptionSettingsService} and {@link TranscriptionConfigService}.
   */
  static forRoot(options: TranscriptionModuleOptions = {}): DynamicModule {
    const extra = options.extraProviders ?? [];
    const permissions = { ...DEFAULT_TRANSCRIPTION_PERMISSIONS, ...stripUndefined(options.permissions) };
    const controllers = [TranscriptionSettingsController, TranscriptionConfigController];
    const providers: Provider[] = [
      TranscriptionProviderRegistry,
      TranscriptionSettingsService,
      TranscriptionConfigService,
      { provide: KVOX_AUTH_PERMISSIONS, useValue: permissions },
      {
        provide: TRANSCRIPTION_EXTRA_PROVIDERS,
        useFactory: (...instances: TranscriptionProvider[]) => instances,
        inject: extra,
      },
      ExtraProviderRegistrar,
      ...extra,
    ];

    if (options.providers?.assemblyai !== false) providers.push(AssemblyAiProvider);

    // Now that the strings are known, describe the routes in the API document the way the
    // host chose (the web edition documents them exactly as its own `@Auth(...)` does).
    documentKvoxAuth(controllers, permissions);

    return {
      module: TranscriptionModule,
      global: false,
      controllers,
      providers,
      // The registry and the settings service are what the pipeline's handlers
      // need: one to resolve the configured provider, the other to read the
      // policy and the credential.
      //
      // `TranscriptionConfigService` is exported for the narrow reason exports
      // are added: somebody imports it. The onboarding checklist has to report
      // whether this deployment can transcribe at all, and that is the
      // four-fact conjunction its header describes (enabled, a provider chosen,
      // that provider registered in THIS build, a key stored for it).
      // Re-deriving it elsewhere would be a second implementation of
      // `available`. It resolves no credential and returns no configuration
      // detail, so exporting it widens nothing.
      exports: [
        TranscriptionProviderRegistry,
        TranscriptionSettingsService,
        TranscriptionConfigService,
      ],
    };
  }
}

/** Drops keys set to `undefined`, so a spread never overwrites a default with nothing. */
function stripUndefined<T extends object>(value: T | undefined): Partial<T> {
  return Object.fromEntries(
    Object.entries(value ?? {}).filter(([, v]) => v !== undefined),
  ) as Partial<T>;
}
