import type { Type } from '@nestjs/common';

import type { TranscriptionProvider } from './providers/transcription-provider.interface.js';

// =============================================================================
// TranscriptionModule options (issue #492, epic #491)
// =============================================================================
//
// Plain data plus `Type<...>` bindings, as every slice's `forRoot` takes. No
// environment variable is read inside the package: a host reads its own
// configuration and passes values.
//
// THE PERMISSION STRINGS ARE THE HOST'S. The two admin controllers are guarded
// by `system_settings:read|write` and the capability probe by `transcripts:read`
// in the web edition, and the settings page's card names exactly those strings
// (the Settings UI Pattern: a card's permission is the string the controller
// enforces). KVox Desktop has no such permissions and grants all. So the
// controllers name an OPTION (`KvoxAuthFromOptions('settingsRead')`) and the
// module provides the option map under `KVOX_AUTH_PERMISSIONS`; the defaults
// below are the web edition's strings, so passing nothing changes nothing.
// =============================================================================

/**
 * The permission strings the transcription controllers enforce.
 *
 * @stability experimental
 */
export interface TranscriptionPermissionOptions {
  /** `GET /api/transcription-settings`. Default `system_settings:read`. */
  settingsRead?: string;
  /** `PUT`, `POST /test` and `DELETE /credentials/:provider`. Default `system_settings:write`. */
  settingsWrite?: string;
  /** `GET /api/transcription/config`. Default `transcripts:read`. */
  configRead?: string;
}

/**
 * Which built-in providers the module registers.
 *
 * @stability experimental
 */
export interface TranscriptionBuiltInProviders {
  /** The AssemblyAI provider. On unless set to `false`. */
  assemblyai?: boolean;
}

/**
 * Options of `TranscriptionModule.forRoot`.
 *
 * @example
 * ```ts
 * TranscriptionModule.forRoot({
 *   providers: { assemblyai: true },
 *   extraProviders: [WhisperProvider],
 *   permissions: { settingsRead: 'system_settings:read' },
 * });
 * ```
 *
 * @stability experimental
 */
export interface TranscriptionModuleOptions {
  /** The built-in providers to register. Each is on unless set to `false`. */
  providers?: TranscriptionBuiltInProviders;

  /**
   * Further providers, as classes the container can build. Each is registered
   * with the provider registry when the module starts, and becomes selectable
   * as the `provider` setting.
   *
   * @extensionPoint
   */
  extraProviders?: Type<TranscriptionProvider>[];

  /** The permission strings the controllers enforce; the defaults are the web edition's. */
  permissions?: TranscriptionPermissionOptions;
}

/**
 * The permission strings used when {@link TranscriptionModuleOptions.permissions}
 * names none.
 *
 * @stability experimental
 */
export const DEFAULT_TRANSCRIPTION_PERMISSIONS: Readonly<Required<TranscriptionPermissionOptions>> = {
  settingsRead: 'system_settings:read',
  settingsWrite: 'system_settings:write',
  configRead: 'transcripts:read',
};

/**
 * Injection token of the extra providers' instances, built by the container
 * from {@link TranscriptionModuleOptions.extraProviders}.
 *
 * @stability experimental
 */
export const TRANSCRIPTION_EXTRA_PROVIDERS = Symbol.for('@marinoscar/kvox/TRANSCRIPTION_EXTRA_PROVIDERS');
