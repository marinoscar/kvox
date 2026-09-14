import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { CredentialsService } from '../credentials/credentials.service';
import { SystemSettingsService } from '../settings/system-settings/system-settings.service';
import type { PatchSystemSettingsDto } from '../settings/dto/update-system-settings.dto';
import type { SystemTranscriptionValue } from './transcription-settings.schema';
import { TranscriptionProviderRegistry } from './transcription-provider.registry';
import {
  TRANSCRIPTION_CREDENTIAL_PURPOSE,
  transcriptionCredentialLabel,
  transcriptionCredentialName,
} from './transcription-credential.constants';
import {
  createProviderContext,
  type TranscriptionConnectionTest,
  type TranscriptionProviderDescription,
} from './providers/transcription-provider.interface';

// =============================================================================
// TranscriptionSettingsService (issue #23, epic #19)
// =============================================================================
//
// TWO DESTINATIONS, ONE SUBMISSION — the same split `EmailSettingsService`
// makes, for the same reason:
//
//   • the ordinary configuration goes to the `transcription` namespace of the
//     `global` `system_settings` row, through `SystemSettingsService
//     .patchSettings`, which owns the merge, the validation, the preservation
//     of unknown keys and the audit entry. `DbBackupAdminService.updateConfig`
//     is the worked precedent for a dedicated controller writing a namespace
//     that way, and this service copies it deliberately rather than reaching
//     into `system_settings` itself.
//
//   • the PROVIDER API KEY goes to the encrypted credential store and NOWHERE
//     ELSE. It is never returned, never logged, and never part of the settings
//     blob — `transcription-settings.schema.ts` carries a compile-time proof of
//     the last of those.
//
// -----------------------------------------------------------------------------
// BLANK PRESERVES — AND WHY `setSecret` IS SKIPPED ENTIRELY WHEN BLANK
// -----------------------------------------------------------------------------
//
// An empty `apiKey` field means "I did not retype the key", so the stored one is
// kept. `CredentialsService` already implements exactly that and this service
// must not reimplement, second-guess or pre-normalise it: no `.trim()`, no
// `'' -> undefined` coercion, no "erase when empty" branch. The value arrives
// byte-for-byte as submitted.
//
// What this service DOES decide is whether to call `setSecret` at all, and it
// calls it only for a non-blank value. Calling it blank on a deployment that has
// never stored a key for this provider would raise `CredentialsService`'s
// first-write 400 on an ordinary save — a save that may have nothing to do with
// the key (turning transcription off, changing the playback bitrate). Skipping
// the call produces the identical outcome for an existing credential (preserved)
// and the correct one for a non-existent one (still absent, no error).
//
// Erasing a stored key is `removeCredential`, reached from a distinct endpoint
// and a distinct control. It is deliberately not reachable through the PUT.
//
// -----------------------------------------------------------------------------
// `testConnection` TESTS THE KEY IN THE REQUEST, FALLING BACK TO THE STORED ONE
// -----------------------------------------------------------------------------
//
// That ordering is the whole point of the endpoint. An administrator pastes a
// key, presses Test, and learns whether it works BEFORE committing it — which is
// the one workflow that makes a wrong key a two-minute problem instead of a
// silent one discovered by a failed job an hour later. Falling back to the
// stored key covers the other real case: "is the key I saved last month still
// valid?".
// =============================================================================

/**
 * The masked view of a stored provider key that the admin page renders.
 *
 * EVERY FIELD IS NON-SECRET BY CONSTRUCTION, exactly as `SmtpPasswordStatus`
 * is: `hint` is the credential store's own mask, derived on write by code that
 * already holds the plaintext, and nothing in this module can widen it.
 *
 * A boolean alone is not enough, for the reason that type gives: an
 * administrator who has just rotated a key needs to see WHICH value is live, and
 * "when, and by whom" is the difference between "my change saved" and "I am
 * looking at a colleague's value from months ago".
 */
export interface ProviderKeyStatus {
  /** Which provider this describes. */
  providerId: string;
  /** Is a key stored at `(purpose 'transcription', name providerId)`? */
  configured: boolean;
  /** The store's mask, e.g. `••••x9fQ`. Null when nothing is stored. */
  hint: string | null;
  updatedAt: Date | null;
  /** Null when nothing is stored, or the user who set it was deleted. */
  updatedByUserId: string | null;
}

/**
 * What the admin settings page reads: the configuration, the masked key status
 * of every provider, and the provider catalogue the form renders itself from.
 */
export interface TranscriptionSettingsAdminView {
  settings: SystemTranscriptionValue;
  /** One entry per REGISTERED provider, configured or not. */
  keyStatuses: ProviderKeyStatus[];
  /** Capabilities and field descriptors — see `registry.describeAll()`. */
  providers: TranscriptionProviderDescription[];
  /** Bumped on every write of the `global` row. The `If-Match` token. */
  version: number;
  updatedAt: Date | null;
  updatedBy: { id: string; email: string } | null;
}

/** The write body, after validation. `apiKey` is REQUEST-ONLY — never persisted. */
export interface UpdateTranscriptionSettingsInput {
  settings: Partial<SystemTranscriptionValue>;
  /**
   * A new key for `settings.provider` (or for `provider` when one is named).
   * Blank/absent preserves the stored key. NEVER reaches `system_settings`.
   */
  apiKey?: string | null;
}

/** What `POST /test` takes: enough to test a key that has NOT been saved. */
export interface TestTranscriptionConnectionInput {
  provider: string;
  /** Override the stored region for this probe only. */
  region?: string | null;
  /** The unsaved key. Absent falls back to the stored one. */
  apiKey?: string | null;
}

/**
 * Is this submission "I did not retype the key"?
 *
 * Mirrors `CredentialsService`'s own definition exactly, including the ABSENCE
 * of `.trim()`: a credential is stored byte-for-byte, and silently altering one
 * produces an authentication failure with no visible cause. It exists here only
 * to decide WHETHER TO CALL `setSecret`; the preserve behaviour itself belongs
 * to the store and is not reimplemented.
 */
function isBlankSecret(value: string | null | undefined): boolean {
  return value === undefined || value === null || value === '';
}

@Injectable()
export class TranscriptionSettingsService {
  private readonly logger = new Logger(TranscriptionSettingsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly systemSettings: SystemSettingsService,
    private readonly registry: TranscriptionProviderRegistry,
    // The API key's only home. Used through `setSecret` (write), `describe`
    // (masked read) and `deleteSecret` (erase). `getSecret` — the plaintext one
    // — is called from exactly one method (`testConnection`) and its result is
    // handed straight to a provider context and dropped.
    private readonly credentials: CredentialsService,
  ) {}

  // ---------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------

  /** The stored policy, degraded to defaults if the row is damaged. */
  async get(): Promise<SystemTranscriptionValue> {
    return this.systemSettings.getTranscriptionPolicy();
  }

  /**
   * Everything `GET /api/transcription-settings` renders.
   *
   * NO SECRET IS READ ON THIS PATH. `describe` returns `CredentialInfo`, a type
   * carrying a compile-time proof that it cannot hold secret material, and whose
   * query does not select the ciphertext column at all — so for this request the
   * encrypted bytes never leave Postgres.
   */
  async describeForAdmin(): Promise<TranscriptionSettingsAdminView> {
    const [settings, row, keyStatuses] = await Promise.all([
      this.get(),
      this.prisma.systemSettings.findUnique({
        where: { key: 'global' },
        select: {
          version: true,
          updatedAt: true,
          updatedByUser: { select: { id: true, email: true } },
        },
      }),
      this.describeKeys(),
    ]);

    return {
      settings,
      keyStatuses,
      providers: this.registry.describeAll(),
      version: row?.version ?? 0,
      updatedAt: row?.updatedAt ?? null,
      updatedBy: row?.updatedByUser ?? null,
    };
  }

  /** One masked status per registered provider, configured or not. */
  private async describeKeys(): Promise<ProviderKeyStatus[]> {
    return Promise.all(
      this.registry.ids().map(async (providerId) => {
        const info = await this.credentials.describe(
          TRANSCRIPTION_CREDENTIAL_PURPOSE,
          transcriptionCredentialName(providerId),
        );

        return {
          providerId,
          configured: info !== null,
          // The store's own mask. Never computed here, because computing it
          // would mean holding the plaintext to compute it from.
          hint: info?.hint ?? null,
          updatedAt: info?.updatedAt ?? null,
          updatedByUserId: info?.updatedByUserId ?? null,
        };
      }),
    );
  }

  // ---------------------------------------------------------------------------
  // Writes
  // ---------------------------------------------------------------------------

  /**
   * Replace the transcription configuration (`PUT /api/transcription-settings`).
   *
   * ⚠ THE KEY IS WRITTEN FIRST, and the ordering is load-bearing for the same
   * reason it is in `EmailSettingsService.update`: `CredentialsService.setSecret`
   * rejects (400) a blank secret written to an address that holds nothing yet.
   * Doing the settings write first would mean that request persists
   * `provider: 'assemblyai'` with no key behind it and then 400s — the admin
   * sees a failure, the configuration changed anyway, and the next job fails for
   * a reason the error never mentioned.
   *
   * The opposite partial failure (key written, settings write fails) is harmless
   * by construction: a stored key no settings row points at yet is inert, and
   * the next successful save picks it up.
   */
  async update(
    input: UpdateTranscriptionSettingsInput,
    userId: string,
    expectedVersion?: number,
  ): Promise<TranscriptionSettingsAdminView> {
    // Destructured out FIRST, so the key is a named local that never travels
    // with the rest of the body. The settings patch below is built field by
    // field from `input.settings` and cannot pick it up.
    const { apiKey, settings } = input;

    // Which provider is this key for? The one being saved, falling back to the
    // one already active — so "paste a key and save" works on a deployment that
    // chose its provider on an earlier visit.
    const current = await this.get();
    const targetProvider = settings.provider ?? current.provider;

    const keySubmitted = !isBlankSecret(apiKey);

    if (keySubmitted) {
      if (!targetProvider) {
        // A key with no provider has no address: `name` IS the provider id.
        // Refusing is the only honest answer — storing it under a placeholder
        // would make it unreachable, and picking a provider on the
        // administrator's behalf would silently enable a vendor nobody chose.
        throw new BadRequestException(
          'Cannot save an API key without choosing a provider: the key is stored per provider, so there is nowhere to put it.',
        );
      }

      const provider = this.registry.get(targetProvider);
      if (!provider) {
        throw new BadRequestException(
          `Unknown transcription provider "${targetProvider}". Known providers: ${this.registry.ids().join(', ') || 'none'}.`,
        );
      }

      await this.credentials.setSecret(
        TRANSCRIPTION_CREDENTIAL_PURPOSE,
        transcriptionCredentialName(targetProvider),
        // Passed through UNTOUCHED. See the blank-preserves note in the header.
        apiKey,
        {
          label: transcriptionCredentialLabel(provider.label),
          updatedByUserId: userId,
        },
      );
    }

    // The settings half, through `SystemSettingsService` so the merge, the
    // validation, the unknown-key preservation, the version bump and the
    // `system_settings:patch` audit entry are all the ones that row already
    // has. `DbBackupAdminService.updateConfig` does exactly this.
    await this.systemSettings.patchSettings(
      { transcription: settings } as PatchSystemSettingsDto,
      userId,
      expectedVersion,
    );

    await this.audit(userId, 'transcription_settings:update', {
      // SAFE TO RECORD IN FULL: `settings` is a subset of
      // `SystemTranscriptionValue`, and that type carries a compile-time proof
      // that it has no secret-bearing field. The key is not in this object and
      // cannot become so without that proof failing to compile.
      settings: settings as unknown as Prisma.InputJsonValue,
      // WHETHER the key changed, never what it changed to. That is the fact an
      // audit trail needs — "who rotated the transcription credential, and
      // when" — and it is the whole of what can safely be recorded.
      apiKeyChanged: keySubmitted,
      provider: targetProvider,
    });

    // userId only. No settings values and above all no key: application logs
    // are shipped, indexed and retained far more widely than the audit table.
    this.logger.log(
      `Transcription settings updated by user ${userId}` +
        (keySubmitted ? ' (API key updated)' : ''),
    );

    // RE-READ rather than projecting the input: `patchSettings` merges and
    // validates, so the stored value is the only honest answer, and the caller
    // needs the new `version` for its next `If-Match`.
    return this.describeForAdmin();
  }

  /**
   * Erase one provider's stored key.
   *
   * The ONLY way to remove a key, and separate from `update` so that destroying
   * a credential is always something a caller asked for by name. Idempotent,
   * because `CredentialsService.deleteSecret` is: the caller's goal is "there is
   * no key here", and a double-clicked button should not produce an error.
   *
   * IT DOES NOT TOUCH THE SETTINGS. Removing the key of the ACTIVE provider
   * leaves `provider` and `enabled` exactly as they were, which looks careless
   * and is not: an administrator rotating a key deletes the old one and pastes
   * the new one, and silently switching the deployment off in between would
   * turn a rotation into an outage. The settings page renders the missing key
   * as the loud problem it is.
   */
  async removeCredential(providerId: string, userId: string): Promise<void> {
    if (!this.registry.get(providerId)) {
      throw new BadRequestException(
        `Unknown transcription provider "${providerId}". Known providers: ${this.registry.ids().join(', ') || 'none'}.`,
      );
    }

    await this.credentials.deleteSecret(
      TRANSCRIPTION_CREDENTIAL_PURPOSE,
      transcriptionCredentialName(providerId),
    );

    await this.audit(userId, 'transcription_settings:credential_delete', {
      provider: providerId,
    });

    this.logger.log(
      `Transcription API key for "${providerId}" removed by user ${userId}`,
    );
  }

  /**
   * Probe a provider's credential.
   *
   * NEVER THROWS FOR A FAILED PROBE — it resolves `{ ok: false, detail }`, for
   * exactly the reason `POST /api/email-settings/test` answers 200 on a refused
   * send: a refused probe is a SUCCESSFUL DIAGNOSIS, and it is the entire point
   * of the call. It throws only for a request that is malformed (an unknown
   * provider, no key anywhere), which is a different thing from a failed probe.
   */
  async testConnection(
    input: TestTranscriptionConnectionInput,
    userId: string,
  ): Promise<TranscriptionConnectionTest> {
    const provider = this.registry.get(input.provider);

    if (!provider) {
      throw new BadRequestException(
        `Unknown transcription provider "${input.provider}". Known providers: ${this.registry.ids().join(', ') || 'none'}.`,
      );
    }

    // THE REQUEST'S KEY WINS. See the header: proving an unsaved key is the
    // workflow this endpoint exists for. The stored key is the fallback, which
    // covers "is what I saved last month still valid?".
    const apiKey = isBlankSecret(input.apiKey)
      ? await this.credentials.getSecret(
          TRANSCRIPTION_CREDENTIAL_PURPOSE,
          transcriptionCredentialName(input.provider),
        )
      : (input.apiKey as string);

    if (isBlankSecret(apiKey)) {
      // Not a failed probe — there was nothing to probe with. A 400 rather than
      // `{ ok: false }` because the caller can fix this without the network
      // being involved at all.
      throw new BadRequestException(
        `No API key for "${input.provider}": none was supplied and none is stored. Paste a key and try again.`,
      );
    }

    const stored = await this.get();

    // The provider's own settings, with the request's region override applied.
    // Parsed through the provider's schema so an override of `"eu "` or
    // `"europe"` is a 400 here rather than a confusing 404 from the vendor.
    const settingsParse = provider.settingsSchema.safeParse({
      ...(stored.providers as Record<string, unknown>)[input.provider],
      ...(input.region ? { region: input.region } : {}),
    });

    if (!settingsParse.success) {
      throw new BadRequestException(
        `Invalid settings for provider "${input.provider}": ${settingsParse.error.issues
          .map((issue) => issue.path.join('.') || '(root)')
          .join(', ')}`,
      );
    }

    const result = await provider.testConnection(
      // ⚠ The only place a plaintext key enters a provider context on this
      // path. It is built here, passed down, and dropped — never stored on an
      // instance field and never logged.
      createProviderContext(apiKey as string, settingsParse.data),
    );

    // AUDITED, because it is a side-effecting administrative action against a
    // third party using a credential. The OUTCOME is recorded, never the key —
    // and `detail` is this application's own sentence, not an echo of anything
    // submitted.
    await this.audit(userId, 'transcription_settings:test', {
      provider: input.provider,
      ok: result.ok,
      latencyMs: result.latencyMs,
      detail: result.detail,
      // Whether the caller supplied a key inline, which is the difference
      // between "an admin proved a new key" and "an admin re-checked the
      // stored one". Never the key itself.
      usedSuppliedKey: !isBlankSecret(input.apiKey),
    });

    return result;
  }

  /**
   * One audit row.
   *
   * `targetType: 'system_settings'` because that is what this configuration is;
   * `targetId` is the namespace name rather than a row id, so a reader can tell
   * which settings surface an event came from without joining anything.
   */
  private async audit(
    actorUserId: string,
    action: string,
    meta: Record<string, unknown>,
  ): Promise<void> {
    await this.prisma.auditEvent.create({
      data: {
        actorUserId,
        action,
        targetType: 'system_settings',
        targetId: 'transcription',
        meta: meta as unknown as Prisma.InputJsonValue,
      },
    });
  }
}
