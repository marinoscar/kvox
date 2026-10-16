// =============================================================================
// The telemetry slice's credential store (issue #471, epic #467)
// =============================================================================
//
// Telemetry keeps two secrets, the GreptimeDB `reader` and `admin` passwords,
// under purpose `telemetry_greptime` (`TELEMETRY_GREPTIME_CREDENTIAL_PURPOSE`,
// registered in `platform/credentials/credential-purposes.manifest.ts`). The
// `GREPTIME_*` environment values are only the deployment default for the first
// connection; the runtime source is this store.
//
// A thin pass-through over the platform `CredentialsService`: `getSecret` is the
// only call that yields plaintext, and it is used at the moment of use.
// =============================================================================

import { Injectable } from '@nestjs/common';
import { CredentialsService } from '@marinoscar/platform-api/credentials';
import type {
  TelemetryCredentialInfo,
  TelemetryCredentialStore,
} from '@marinoscar/platform-api/telemetry';

@Injectable()
export class TelemetryCredentialsAdapter implements TelemetryCredentialStore {
  constructor(private readonly credentials: CredentialsService) {}

  getSecret(purpose: string, name: string): Promise<string | null> {
    return this.credentials.getSecret(purpose, name);
  }

  async setSecret(
    purpose: string,
    name: string,
    secret: string | null | undefined,
    meta?: { readonly label?: string | null; readonly updatedByUserId?: string | null },
  ): Promise<void> {
    await this.credentials.setSecret(purpose, name, secret, meta);
  }

  async deleteSecret(purpose: string, name: string): Promise<void> {
    await this.credentials.deleteSecret(purpose, name);
  }

  async describe(purpose: string, name: string): Promise<TelemetryCredentialInfo | null> {
    const info = await this.credentials.describe(purpose, name);
    if (!info) return null;
    return {
      purpose: info.purpose,
      name: info.name,
      hint: info.hint ?? null,
      label: info.label ?? null,
      updatedByUserId: info.updatedByUserId ?? null,
      createdAt: info.createdAt,
      updatedAt: info.updatedAt,
    };
  }
}
