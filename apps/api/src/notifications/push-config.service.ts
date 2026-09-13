import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Prisma } from '@prisma/client';
import * as webpush from 'web-push';
import type { z } from 'zod';

import { PrismaService } from '../prisma/prisma.service';
import { CredentialsService } from '../credentials/credentials.service';
import {
  DEFAULT_PUSH_CONFIG,
  DEFAULT_VAPID_SUBJECT,
  PushConfig,
  pushConfigSchema,
} from './push-config.schema';
import {
  PUSH_VAPID_CREDENTIAL_LABEL,
  PUSH_VAPID_CREDENTIAL_NAME,
  PUSH_VAPID_CREDENTIAL_PURPOSE,
} from './push-vapid-credential.constants';
import type { GeneratePushConfigInput } from './dto/generate-push-config.dto';
import type {
  RemovePushConfigInput,
  RotatePushConfigInput,
} from './dto/push-config-confirmation.dto';
import type { UpdatePushConfigInput } from './dto/update-push-config.dto';

// =============================================================================
// PushConfigService — runtime-configurable Web Push VAPID keys (issue #355)
// =============================================================================
//
// Overturns the deploy-time-only design documented (until this issue) in
// `docs/runbooks/vapid-keys.md`: generate, store, enable/disable and rotate a
// VAPID key pair from the admin UI, live, with no restart. Mirrors
// `../email/email-settings.service.ts` throughout — same storage split (a
// non-secret `system_settings` row plus one `CredentialsService` secret), same
// admin-view shape, same If-Match concurrency story. Read that file's header
// first if this one is unclear; the differences are called out inline.
//
// -----------------------------------------------------------------------------
// STORAGE SPLIT: WHY THE PUBLIC KEY IS A SETTINGS ROW AND THE PRIVATE KEY IS A
// CREDENTIAL
// -----------------------------------------------------------------------------
//
// `system_settings` row, key 'webPush': `{ enabled, publicKey, subject }` —
// all three render in full on the admin page and none is secret, so putting
// any of them behind the masked-hint credential store would make the page
// unable to show its own public key. The VAPID PRIVATE key is the opposite:
// it must NEVER be returned by any endpoint, so it lives at
// `(purpose 'push_vapid', name 'default')` in the encrypted credential store,
// exactly like the SMTP password.
//
// -----------------------------------------------------------------------------
// THE ENV-VAR FALLBACK, AND WHY IT LIVES IN EXACTLY ONE METHOD
// -----------------------------------------------------------------------------
//
// `resolveActiveVapidConfig()` is the ONE place both `PushSubscriptionService`
// and `PushNotificationChannel` ask "what VAPID key pair, if any, is active
// right now" — see those files for why neither re-derives this logic. Four
// cases, in order:
//
//   1. No `webPush` row at all -> fall back to `VAPID_PUBLIC_KEY` /
//      `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` env vars. Existing deployments
//      that never touch this admin surface keep working, zero action
//      required.
//   2. Row exists, `enabled: true`, both a `publicKey` and the private-key
//      credential are present -> the DB wins, even over set env vars. Once an
//      admin has touched the UI, it is the source of truth.
//   3. Row exists, `enabled: false` -> push is off, full stop, NO env
//      fallback. This is the one intentional asymmetry: an explicit disable
//      must be able to override a stale env var, or "disable" would not
//      actually disable anything on a deployment that also has env vars set.
//   4. Row `enabled: true` but the credential is missing (corruption, a hand
//      edit, a botched migration) -> treat as disabled, log loudly. Never
//      silently revert to env — that would mask the corruption as ordinary
//      "not configured".
// =============================================================================

/** The `system_settings.key` this configuration is stored under. */
export const PUSH_CONFIG_KEY = 'webPush';

/**
 * The masked view of the stored VAPID private key that the admin page
 * renders. Mirrors `SmtpPasswordStatus` exactly, including why a boolean
 * alone is not enough: an admin who has just rotated the keys needs to see
 * WHICH pair is live.
 */
export interface PrivateKeyStatus {
  /** Is a private key stored at `(purpose 'push_vapid', name 'default')`? */
  configured: boolean;

  /** The store's own mask, e.g. `••••x9fQ`. Null when nothing is stored. */
  hint: string | null;

  /** When the stored private key was last written. */
  updatedAt: Date | null;

  /** Who last wrote it. Null when nothing is stored, or the user was deleted. */
  updatedByUserId: string | null;
}

/**
 * What `GET /api/admin/push-config` (and every write) renders. Extends
 * {@link PushConfig} rather than nesting it, matching
 * `EmailSettingsAdminView`, so a field added to the schema appears here with
 * no edit.
 */
export interface PushConfigAdminView extends PushConfig {
  /**
   * Both halves of the key pair are present: `publicKey` is non-null AND a
   * private-key credential is stored. The empty-state/configured-state split
   * the admin page renders off of.
   */
  configured: boolean;

  privateKeyStatus: PrivateKeyStatus;

  /**
   * Why the stored row could not be read, when it could not be. Null
   * normally. FIELD PATHS ONLY — see the note where it is built.
   */
  settingsError: string | null;

  /** Bumped on every write. The optimistic-concurrency token for `If-Match`. */
  version: number;

  updatedAt: Date | null;

  updatedBy: { id: string; email: string } | null;
}

/** What a channel needs to actually sign and send a push. Never rendered to a client. */
export interface ActiveVapidConfig {
  publicKey: string;
  privateKey: string;
  subject: string;
}

/**
 * A zod failure rendered as the list of field paths that failed. Duplicated
 * from `email-settings.service.ts` rather than shared — see that file's own
 * copy for why (paths only, never values; the two must not drift by sharing
 * mutable state, and a five-line pure function is not worth a cross-module
 * import for).
 */
function describeInvalidPaths(error: z.ZodError): string {
  return error.issues
    .map((issue) => issue.path.join('.') || '(root)')
    .join(', ');
}

@Injectable()
export class PushConfigService {
  private readonly logger = new Logger(PushConfigService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    // The VAPID private key's only home. See push-vapid-credential.constants.ts.
    // Only ever used through `setSecret` (write), `describe` (masked read) and
    // `deleteSecret` (remove). `getSecret` — the plaintext one — is called
    // from exactly one place below, `resolveActiveVapidConfig`, at the moment
    // a channel is about to sign a push; it is never held longer than that.
    private readonly credentials: CredentialsService,
  ) {}

  // ---------------------------------------------------------------------------
  // Admin surface
  // ---------------------------------------------------------------------------

  /**
   * Everything `GET /api/admin/push-config` renders. Mirrors
   * `EmailSettingsService.describeForAdmin` exactly: it does NOT throw on an
   * invalid stored row (this is the repair path, and a 500 here would take
   * down the one screen capable of fixing the row), and it touches the
   * credential store (which `resolveActiveVapidConfig` also does, but a send
   * path has no business paying for a lookup this admin read needs anyway).
   */
  async describeForAdmin(): Promise<PushConfigAdminView> {
    const row = await this.prisma.systemSettings.findUnique({
      where: { key: PUSH_CONFIG_KEY },
      include: { updatedByUser: { select: { id: true, email: true } } },
    });

    let settings: PushConfig = DEFAULT_PUSH_CONFIG;
    let settingsError: string | null = null;

    if (row) {
      const parsed = pushConfigSchema.safeParse(row.value);

      if (parsed.success) {
        settings = parsed.data;
      } else {
        const paths = describeInvalidPaths(parsed.error);

        this.logger.error(
          `Stored Web Push settings are invalid at: ${paths}. Serving defaults to the settings page so they can be re-saved.`,
        );

        settingsError = `The stored Web Push configuration is invalid at: ${paths}. Correct those fields and save to repair it.`;
      }
    }

    return this.toAdminView(settings, settingsError, row);
  }

  /**
   * The ONE place both `PushSubscriptionService` and `PushNotificationChannel`
   * ask "what VAPID key pair, if any, is active right now". See this file's
   * header for the full four-case precedence this implements.
   *
   * @returns `null` when push is not active for any reason — no config
   *          anywhere, an explicit disable, or a corrupted/missing
   *          credential. Callers treat `null` uniformly as "push is off";
   *          they do not need to know WHY.
   */
  async resolveActiveVapidConfig(): Promise<ActiveVapidConfig | null> {
    const row = await this.prisma.systemSettings.findUnique({
      where: { key: PUSH_CONFIG_KEY },
      select: { value: true },
    });

    // CASE 1 — no row at all: fall back to the env vars this deployment may
    // have set at deploy time, exactly as it did before this feature existed.
    if (!row) {
      return this.resolveFromEnv();
    }

    const parsed = pushConfigSchema.safeParse(row.value);

    if (!parsed.success) {
      // A corrupted/invalid row is treated as "push is off", loudly logged —
      // never silently falling through to the env vars, which would mask a
      // real data problem as ordinary "not configured".
      const paths = describeInvalidPaths(parsed.error);
      this.logger.error(
        `Stored Web Push settings are invalid at: ${paths}. Push is disabled until the configuration is re-saved.`,
      );
      return null;
    }

    const settings = parsed.data;

    // CASE 3 — explicit disable. NO ENV FALLBACK: see the header for why this
    // is the one intentional asymmetry in the precedence.
    if (!settings.enabled) {
      return null;
    }

    if (!settings.publicKey) {
      // `enabled: true` with no public key is not a state `update`/`generate`
      // should ever produce (see their guards below), but a hand-edited row
      // can still reach it — treat it the same as case 4: disabled, logged.
      this.logger.warn(
        'Web Push is enabled but no public key is stored; treating it as disabled until the configuration is repaired.',
      );
      return null;
    }

    // CASE 4 — enabled, public key present, but the private-key credential is
    // missing (corruption, a hand-deleted row, a botched migration). Treated
    // as disabled and logged loudly, never silently reverted to env.
    const privateKey = await this.credentials.getSecret(
      PUSH_VAPID_CREDENTIAL_PURPOSE,
      PUSH_VAPID_CREDENTIAL_NAME,
    );

    if (!privateKey) {
      this.logger.warn(
        'Web Push is enabled and a public key is stored, but no private-key credential exists; treating it as disabled until the configuration is repaired.',
      );
      return null;
    }

    // CASE 2 — the DB wins, even over set env vars.
    return {
      publicKey: settings.publicKey,
      privateKey,
      subject: this.resolveSubject(settings.subject),
    };
  }

  /**
   * Case 1 of {@link resolveActiveVapidConfig}: no `webPush` row exists at
   * all, so fall back to the deploy-time env vars — the ONLY behaviour this
   * feature must not change for a deployment that never opens the admin page.
   */
  private resolveFromEnv(): ActiveVapidConfig | null {
    const publicKey = this.config.get<string>('push.vapidPublicKey');
    const privateKey = this.config.get<string>('push.vapidPrivateKey');

    if (!publicKey || !privateKey) {
      return null;
    }

    const subject = this.config.get<string>('push.vapidSubject');

    return {
      publicKey,
      privateKey,
      subject: this.resolveSubject(subject ?? null),
    };
  }

  /**
   * Apply the generic fallback subject, warning once per resolution when it
   * is used. Centralised here (rather than duplicated in the channel, which
   * used to do this inline) precisely because this method is now the single
   * source both the env path and the DB path route through.
   */
  private resolveSubject(subject: string | null | undefined): string {
    if (subject) {
      return subject;
    }

    this.logger.warn(
      'No VAPID subject configured; falling back to a generic mailto: subject for this delivery.',
    );

    return DEFAULT_VAPID_SUBJECT;
  }

  /**
   * Assemble the admin view from an already-validated settings object and the
   * row it came from. Shared by {@link describeForAdmin} and every write
   * below, matching `EmailSettingsService.toAdminView`.
   */
  private async toAdminView(
    settings: PushConfig,
    settingsError: string | null,
    row: {
      version: number;
      updatedAt: Date;
      updatedByUser: { id: string; email: string } | null;
    } | null,
  ): Promise<PushConfigAdminView> {
    // The masked read. NOT `getSecret` — `describe` returns `CredentialInfo`,
    // which has no field capable of carrying secret material.
    const info = await this.credentials.describe(
      PUSH_VAPID_CREDENTIAL_PURPOSE,
      PUSH_VAPID_CREDENTIAL_NAME,
    );

    return {
      ...settings,
      configured: Boolean(settings.publicKey) && info !== null,
      privateKeyStatus: {
        configured: info !== null,
        hint: info?.hint ?? null,
        updatedAt: info?.updatedAt ?? null,
        updatedByUserId: info?.updatedByUserId ?? null,
      },
      settingsError,
      version: row?.version ?? 0,
      updatedAt: row?.updatedAt ?? null,
      updatedBy: row?.updatedByUser ?? null,
    };
  }

  // ---------------------------------------------------------------------------
  // Writes
  // ---------------------------------------------------------------------------

  /**
   * `POST /api/admin/push-config/generate` — first-time key generation.
   *
   * FIRST-TIME ONLY. Throws 409 if a key pair already exists (a `publicKey`
   * stored OR a private-key credential present — either alone means "this
   * deployment has been configured before"), pointing the caller at
   * {@link rotate} instead. This is deliberately not idempotent: a second
   * `generate` call silently replacing a live key pair would invalidate every
   * existing subscriber with no confirmation step at all — that destructive
   * act is what `rotate`'s typed confirmation exists for.
   *
   * WRITES THE CREDENTIAL FIRST, THEN THE SETTINGS ROW — same
   * partial-failure-safe ordering as `EmailSettingsService.update`. An
   * orphaned credential with no row pointing at it is inert; the reverse
   * (a row claiming a public key with no private-key credential behind it)
   * is not, and would immediately misreport itself as `configured`.
   *
   * Sets `enabled: true`: an admin generating keys is, by that action, asking
   * for Web Push to be on.
   */
  async generate(
    input: GeneratePushConfigInput,
    userId: string,
  ): Promise<PushConfigAdminView> {
    const existingRow = await this.prisma.systemSettings.findUnique({
      where: { key: PUSH_CONFIG_KEY },
      select: { value: true },
    });
    const existingCredential = await this.credentials.describe(
      PUSH_VAPID_CREDENTIAL_PURPOSE,
      PUSH_VAPID_CREDENTIAL_NAME,
    );

    if (existingCredential !== null || this.storedPublicKey(existingRow)) {
      throw new ConflictException(
        'Web Push is already configured. Use the rotate action to replace the existing keys.',
      );
    }

    const keys = webpush.generateVAPIDKeys();

    // See the header: credential first, settings row second.
    await this.credentials.setSecret(
      PUSH_VAPID_CREDENTIAL_PURPOSE,
      PUSH_VAPID_CREDENTIAL_NAME,
      keys.privateKey,
      { label: PUSH_VAPID_CREDENTIAL_LABEL, updatedByUserId: userId },
    );

    const settings: PushConfig = {
      enabled: true,
      publicKey: keys.publicKey,
      subject: input.subject ?? null,
    };

    const row = await this.writeSettingsRow(settings, userId);

    await this.auditEvent(userId, 'push_config:generate', row.id, {
      settings,
    });

    this.logger.log(`Web Push VAPID keys generated by user ${userId}`);

    return this.toAdminView(settings, null, row);
  }

  /**
   * `POST /api/admin/push-config/rotate` — replace an existing key pair.
   *
   * 400 if nothing is configured yet (there is nothing to rotate — use
   * {@link generate}). Overwrites BOTH the credential and the row's
   * `publicKey`; keeps `enabled` exactly as it was — rotating keys is not a
   * decision about whether push should be on, only about which keys back it.
   * `subject`, if provided, replaces the stored one; omitted keeps it, since
   * rotation replaces the KEYS, not necessarily the contact metadata.
   */
  async rotate(
    input: RotatePushConfigInput,
    userId: string,
  ): Promise<PushConfigAdminView> {
    const existingRow = await this.prisma.systemSettings.findUnique({
      where: { key: PUSH_CONFIG_KEY },
      select: { value: true },
    });
    const existingCredential = await this.credentials.describe(
      PUSH_VAPID_CREDENTIAL_PURPOSE,
      PUSH_VAPID_CREDENTIAL_NAME,
    );
    const currentSettings = this.parseStoredSettings(existingRow);

    if (existingCredential === null || !currentSettings?.publicKey) {
      throw new BadRequestException(
        'Web Push has not been configured yet. Use the generate action to create the first key pair.',
      );
    }

    const keys = webpush.generateVAPIDKeys();

    await this.credentials.setSecret(
      PUSH_VAPID_CREDENTIAL_PURPOSE,
      PUSH_VAPID_CREDENTIAL_NAME,
      keys.privateKey,
      { label: PUSH_VAPID_CREDENTIAL_LABEL, updatedByUserId: userId },
    );

    const settings: PushConfig = {
      enabled: currentSettings.enabled,
      publicKey: keys.publicKey,
      subject: input.subject !== undefined ? input.subject : currentSettings.subject,
    };

    const row = await this.writeSettingsRow(settings, userId);

    await this.auditEvent(userId, 'push_config:rotate', row.id, { settings });

    this.logger.log(`Web Push VAPID keys rotated by user ${userId}`);

    return this.toAdminView(settings, null, row);
  }

  /**
   * `PUT /api/admin/push-config` — full-replace of `{ enabled, subject }`.
   *
   * THIS ENDPOINT FLIPS THE SWITCH; IT DOES NOT MANUFACTURE KEYS. 409 if
   * `enabled: true` is requested but no key pair exists (no stored
   * `publicKey`, or no private-key credential) — an admin must `generate`
   * first. Disabling is always allowed: it is the non-destructive action
   * (keys are retained, see the plan), so there is no guard on `enabled:
   * false`.
   *
   * Copies the `If-Match`/version-conflict handling verbatim from
   * `EmailSettingsService.update`.
   */
  async update(
    input: UpdatePushConfigInput,
    userId: string,
    expectedVersion?: number,
  ): Promise<PushConfigAdminView> {
    const existing = await this.prisma.systemSettings.findUnique({
      where: { key: PUSH_CONFIG_KEY },
      select: { version: true, value: true },
    });
    const currentVersion = existing?.version ?? 0;

    if (expectedVersion !== undefined && currentVersion !== expectedVersion) {
      throw new ConflictException(
        `Web Push settings version mismatch. Expected ${expectedVersion}, found ${currentVersion}`,
      );
    }

    const currentSettings = this.parseStoredSettings(existing);
    const publicKey = currentSettings?.publicKey ?? null;

    if (input.enabled) {
      const credential = await this.credentials.describe(
        PUSH_VAPID_CREDENTIAL_PURPOSE,
        PUSH_VAPID_CREDENTIAL_NAME,
      );

      if (!publicKey || credential === null) {
        throw new ConflictException(
          'Cannot enable Web Push before a key pair has been generated. Use the generate action first.',
        );
      }
    }

    const settings: PushConfig = {
      enabled: input.enabled,
      publicKey,
      subject: input.subject,
    };

    const row = await this.writeSettingsRow(settings, userId);

    await this.auditEvent(userId, 'push_config:replace', row.id, {
      settings,
    });

    this.logger.log(
      `Web Push settings replaced by user ${userId} (enabled: ${settings.enabled})`,
    );

    return this.toAdminView(settings, null, row);
  }

  /**
   * `DELETE /api/admin/push-config` — remove the configuration outright.
   *
   * DELETES THE CREDENTIAL FIRST, THEN THE ROW — the opposite order from
   * {@link generate}, and deliberately so: the safer partial-failure state
   * here is "row still present but the credential is gone", which
   * {@link resolveActiveVapidConfig}'s case 4 already treats as disabled and
   * logs loudly. The other order (row gone, credential still present) would
   * mean a partial failure silently falls back to any env vars this
   * deployment also has set — reactivating push on stale deploy-time keys
   * the admin just asked to remove.
   */
  async remove(
    _input: RemovePushConfigInput,
    userId: string,
  ): Promise<PushConfigAdminView> {
    await this.credentials.deleteSecret(
      PUSH_VAPID_CREDENTIAL_PURPOSE,
      PUSH_VAPID_CREDENTIAL_NAME,
    );

    const { count } = await this.prisma.systemSettings.deleteMany({
      where: { key: PUSH_CONFIG_KEY },
    });

    if (count > 0) {
      await this.auditEvent(userId, 'push_config:remove', PUSH_CONFIG_KEY, {});
    }

    this.logger.log(`Web Push configuration removed by user ${userId}`);

    // Returns the resulting (now-empty) view rather than `void` — the admin
    // page's action handlers all render the response of every write directly
    // (`setConfig(await <action>())`), matching generate/rotate/update. A
    // bare 204 here would be the one action that leaves the page holding
    // `undefined` instead of the post-action truth.
    return this.describeForAdmin();
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private storedPublicKey(row: { value: Prisma.JsonValue } | null): boolean {
    return Boolean(this.parseStoredSettings(row)?.publicKey);
  }

  /** Best-effort parse; `null` on a missing or invalid row. Never throws. */
  private parseStoredSettings(
    row: { value: Prisma.JsonValue } | null,
  ): PushConfig | null {
    if (!row) return null;
    const parsed = pushConfigSchema.safeParse(row.value);
    return parsed.success ? parsed.data : null;
  }

  private async writeSettingsRow(settings: PushConfig, userId: string) {
    return this.prisma.systemSettings.upsert({
      where: { key: PUSH_CONFIG_KEY },
      update: {
        value: settings as unknown as Prisma.InputJsonValue,
        updatedByUserId: userId,
        version: { increment: 1 },
      },
      create: {
        key: PUSH_CONFIG_KEY,
        value: settings as unknown as Prisma.InputJsonValue,
        updatedByUserId: userId,
      },
      include: { updatedByUser: { select: { id: true, email: true } } },
    });
  }

  private async auditEvent(
    userId: string,
    action: string,
    targetId: string,
    meta: Record<string, unknown>,
  ): Promise<void> {
    await this.prisma.auditEvent.create({
      data: {
        actorUserId: userId,
        action,
        targetType: 'system_settings',
        targetId,
        // SAFE TO RECORD IN FULL: `meta.settings`, when present, is the output
        // of `pushConfigSchema`'s validated shape, which carries a
        // compile-time proof it has no secret-bearing field. The private key
        // is never in this object.
        meta: meta as unknown as Prisma.InputJsonValue,
      },
    });
  }
}
