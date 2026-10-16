import { Inject, Injectable } from '@nestjs/common';
import { SYSTEM_SETTINGS_STORE, type SystemSettingsStore } from '@marinoscar/platform-api/core';
import { Trace } from '@marinoscar/platform-api/otel-core';
import {
  UserSettingsService,
  systemSettingsNamespaceRegistry,
  userSettingsNamespaceRegistry,
} from '@marinoscar/platform-api/settings';
import type {
  KvoxSettingsNamespaceDef,
  KvoxSettingsPort,
  KvoxVersionedSettings,
} from '@marinoscar/kvox-api/ports';

// =============================================================================
// PlatformKvoxSettingsAdapter: the `KVOX_SETTINGS` port over the platform settings
// registries (issue #490, epic #486)
// =============================================================================
//
// Reads and writes go through the platform services, so validation, the `If-Match`
// version check and the audit trail are the platform's. System namespaces use the
// platform's `SYSTEM_SETTINGS_STORE` (bound to `SystemSettingsService` in
// `platform/system-settings-store.adapter.ts`); user namespaces use
// `UserSettingsService`.
//
// ⚠ A NAMESPACE IS DECLARED BEFORE THE APPLICATION STARTS. The platform composes the
// settings request bodies and the OpenAPI document from its registries when the
// settings slice is created, then freezes them. `registerNamespace` therefore does not
// declare anything here: it VERIFIES that the namespace is already in the platform
// registry (this app registers `transcription` and `graph` in
// `app-registrations/settings.ts`) and throws a clear error when it is not, rather than
// letting a slice find out at its first read. It also remembers the declared defaults,
// which a user namespace needs (the platform's user declaration carries none).
// =============================================================================

@Injectable()
export class PlatformKvoxSettingsAdapter implements KvoxSettingsPort {
  private readonly declared = new Map<string, KvoxSettingsNamespaceDef>();

  constructor(
    @Inject(SYSTEM_SETTINGS_STORE) private readonly system: SystemSettingsStore,
    private readonly users: UserSettingsService,
  ) {}

  registerNamespace(def: KvoxSettingsNamespaceDef): void {
    const registry = def.scope === 'system' ? systemSettingsNamespaceRegistry : userSettingsNamespaceRegistry;
    if (!registry.has(def.name)) {
      throw new Error(
        `The ${def.scope} settings namespace "${def.name}" is not in the platform registry. ` +
          'The web edition declares namespaces in apps/api/src/app-registrations/settings.ts, before the application is created.',
      );
    }
    this.declared.set(`${def.scope}:${def.name}`, def);
  }

  @Trace()
  async readSystem<T>(name: string): Promise<KvoxVersionedSettings<T>> {
    const snapshot = await this.system.read(name);

    return { value: (snapshot.value ?? this.declared.get(`system:${name}`)?.defaults) as T, version: snapshot.version };
  }

  @Trace()
  async patchSystem<T>(
    name: string,
    patch: Partial<T>,
    ctx: { actorUserId: string; ifMatchVersion?: number },
  ): Promise<KvoxVersionedSettings<T>> {
    const snapshot = await this.system.patch(name, patch as Record<string, unknown>, ctx);

    return { value: snapshot.value as T, version: snapshot.version };
  }

  @Trace()
  async readUser<T>(userId: string, name: string): Promise<T> {
    const settings = (await this.users.getSettings(userId)) as unknown as Record<string, unknown>;

    return (settings[name] ?? this.declared.get(`user:${name}`)?.defaults) as T;
  }

  @Trace()
  async patchUser<T>(userId: string, name: string, patch: Partial<T>): Promise<T> {
    const updated = (await this.users.patchSettings(userId, { [name]: patch } as never)) as unknown as Record<string, unknown>;

    return updated[name] as T;
  }
}
