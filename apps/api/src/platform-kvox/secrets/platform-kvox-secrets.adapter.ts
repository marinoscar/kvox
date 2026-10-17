import { APP_SLUG } from '@app/shared';
import { Injectable } from '@nestjs/common';
import { CredentialsService, credentialPurposeRegistry, registerCredentialPurpose } from '@marinoscar/platform-api/credentials';
import { Trace } from '@marinoscar/platform-api/otel-core';
import type { KvoxSecretStatus, KvoxSecretsPort } from '@marinoscar/kvox-api/ports';

// =============================================================================
// PlatformKvoxSecretsAdapter: the `KVOX_SECRETS` port over the platform encrypted
// credential store (issue #490, epic #486)
// =============================================================================
//
// A secret is a platform `credentials` row (AES-GCM, sub-key per PURPOSE). `status`
// reads the row's metadata only: the hint is the platform's own `deriveHint` (a short
// non-reversible tail), never the value. Only `get` returns material, for the code that
// spends it (the transcription provider key).
//
// A purpose is also its encryption domain: never rename one. `registerPurpose` is
// idempotent for a purpose the app already registered (`kvox.manifest.ts` registers
// `transcription`); a NEW one must be declared before the registry freezes.
// =============================================================================

/** The owner recorded for a purpose registered through the port. */
const OWNER = APP_SLUG;

@Injectable()
export class PlatformKvoxSecretsAdapter implements KvoxSecretsPort {
  constructor(private readonly credentials: CredentialsService) {}

  registerPurpose(purpose: string, label: string): void {
    if (credentialPurposeRegistry.has(purpose)) return;

    registerCredentialPurpose({ purpose, owner: OWNER, label, tiers: ['system'] });
  }

  @Trace()
  get(purpose: string, name: string): Promise<string | null> {
    return this.credentials.getSecret(purpose, name);
  }

  @Trace()
  async set(
    purpose: string,
    name: string,
    value: string,
    actorUserId: string,
    meta: { label?: string } = {},
  ): Promise<void> {
    await this.credentials.setSecret(purpose, name, value, {
      updatedByUserId: actorUserId,
      ...(meta.label !== undefined ? { label: meta.label } : {}),
    });
  }

  @Trace()
  async delete(purpose: string, name: string, _actorUserId: string): Promise<void> {
    await this.credentials.deleteSecret(purpose, name);
  }

  @Trace()
  async status(purpose: string, name: string): Promise<KvoxSecretStatus> {
    const info = await this.credentials.describe(purpose, name);
    if (!info) return { configured: false, hint: null, updatedAt: null };

    return {
      configured: true,
      hint: info.hint,
      updatedAt: info.updatedAt.toISOString(),
      updatedByUserId: info.updatedByUserId,
    };
  }
}
