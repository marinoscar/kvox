import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { SystemSettingsService } from '../../settings/system-settings/system-settings.service';
import type { PatchSystemSettingsDto } from '../../settings/dto/update-system-settings.dto';
import type { SystemMaintenanceValue } from '../schemas/settings.schema';
import { DEFAULT_SYSTEM_SETTINGS } from '../types/settings.types';

// =============================================================================
// MaintenanceModeService — the three-layer maintenance switch (#257, epic #254)
// =============================================================================
//
// One question, asked on every request: is this deployment open for business?
// The answer is resolved from THREE layers, in this order:
//
//     env override  ??  in-memory override  ??  persisted setting
//
// WHY THREE, WHEN ONE WOULD DO FOR THE ORDINARY CASE.
//
//   1. PERSISTED (`maintenance.*` in `system_settings`, declared by #256) is
//      the normal path and the only one an operator touches through the API.
//      It is the layer that SURVIVES A RESTART — which matters, because the
//      commonest reason to open a window is to restart the process, and a flag
//      that lived only in memory would switch itself off exactly when it was
//      supposed to be holding traffic back.
//
//   2. IN-MEMORY exists for exactly one caller: the database restore's swap
//      window (#285), which renames the live database out from under this
//      process. For those seconds there is no database under the expected
//      name, so the persisted flag — which lives INSIDE that database — is
//      unreadable at precisely the moment it is needed most. That is the whole
//      reason this service has two layers rather than one; it is not a cache
//      and not a convenience.
//
//   3. ENV (`MAINTENANCE_MODE`) is the break-glass, and it is honoured in BOTH
//      directions on purpose:
//        * `true`  forces the window open even with an unreadable database, so
//          an operator can stop traffic before touching anything.
//        * `false` forces it shut, which is the DOCUMENTED RECOVERY from a bad
//          `allowAdmins: false` window — the one configuration that can lock
//          every human, admins included, out of the API that would otherwise
//          be used to undo it. See docs/runbooks/maintenance-mode.md.
//      Only the literal strings `'true'` and `'false'` count. Anything else,
//      including unset and including `'1'`, means "no override" — a sloppy
//      truthiness check here would turn `MAINTENANCE_MODE=off` into an outage.
//
// READ STRAIGHT FROM `process.env`, NOT THROUGH `ConfigService`, and
// deliberately so — the same call `common/crypto/secret-cipher.ts` makes for
// `SECRETS_ENCRYPTION_KEY`. This is a break-glass control whose entire value is
// that it works when other things do not; routing it through the config object
// would make it depend on a successful `configuration.ts` load and would put a
// second, cached copy of the answer somewhere it could disagree with the
// environment the operator actually edited.
// =============================================================================

/**
 * How long a persisted read is reused before the row is consulted again.
 *
 * A global guard runs on EVERY request, and an uncached implementation would
 * add one `system_settings` query to every call this API serves — a real cost
 * paid forever to answer a question whose answer is "no" essentially always.
 *
 * Five seconds is short enough that a window opened on one instance takes
 * effect across a fleet within a poll or two, and the instance that HANDLED the
 * write does not wait at all: {@link MaintenanceModeService.setMaintenance}
 * invalidates its own cache synchronously. It is also what makes the guard
 * survive a database outage — see {@link MaintenanceModeService.readPersisted}.
 */
export const MAINTENANCE_PERSISTED_CACHE_MS = 5_000;

/**
 * An override held in THIS PROCESS ONLY, never written anywhere.
 *
 * `message` and `allowAdmins` are optional because the caller that sets one
 * (the restore swap) usually has nothing to say about them; when they are
 * absent the persisted values are used, which is the last thing that WAS
 * readable before the database went away.
 */
export interface MaintenanceOverride {
  enabled: boolean;
  message?: string;
  allowAdmins?: boolean;
}

/** Which layer decided `enabled`. Reported to operators, never inferred. */
export type MaintenanceSource = 'env' | 'memory' | 'persisted';

/**
 * The effective state, plus every contributing layer, separately.
 *
 * The layers are not decoration. "Why is it still on?" is the question an
 * operator asks at the worst possible moment, and without them the honest
 * answer — "because `MAINTENANCE_MODE=true` is still in the environment and it
 * outranks everything you just changed" — is invisible from the API.
 */
export interface MaintenanceStatus {
  /** The resolved answer the guard acts on. */
  enabled: boolean;
  /** The copy a blocked caller is shown. */
  message: string;
  /** Whether an admin bearer keeps access while the window is open. */
  allowAdmins: boolean;
  /** When the persisted window was opened, or `null`. */
  startedAt: string | null;
  /** Who opened the persisted window, or `null`. */
  startedById: string | null;
  /** Which layer decided `enabled`. */
  source: MaintenanceSource;
  layers: {
    /** `enabled: null` means the variable is unset or not one of the two literals. */
    env: { present: boolean; enabled: boolean | null };
    memory: { present: boolean; override: MaintenanceOverride | null };
    /**
     * `readable: false` means the row could not be read at all (the swap
     * window, or a database outage) and `value` is the last known state, or
     * the seeded defaults if nothing was ever read.
     */
    persisted: { readable: boolean; value: SystemMaintenanceValue };
  };
}

/** What `PUT /api/admin/maintenance` is allowed to change. */
export interface SetMaintenanceInput {
  enabled: boolean;
  message?: string;
  allowAdmins?: boolean;
}

/** Audit action recorded when a window is opened. */
export const MAINTENANCE_AUDIT_ENABLE = 'maintenance:enable';
/** Audit action recorded when a window is closed. */
export const MAINTENANCE_AUDIT_DISABLE = 'maintenance:disable';
/** `target_type` on both audit rows. `target_id` is the settings key. */
export const MAINTENANCE_AUDIT_TARGET_TYPE = 'maintenance';
/** `target_id` on both audit rows — the single global window. */
export const MAINTENANCE_AUDIT_TARGET_ID = 'global';

@Injectable()
export class MaintenanceModeService {
  private readonly logger = new Logger(MaintenanceModeService.name);

  /** Layer 2. Never persisted, never survives a restart — that is the point. */
  private memoryOverride: MaintenanceOverride | null = null;

  /** Last successful persisted read, with the time it was taken. */
  private cache: { value: SystemMaintenanceValue; readAt: number } | null = null;

  /**
   * Whether the last persisted read failed. Used only to log the transition
   * into and out of a degraded read, so a database outage does not emit one
   * warning per request for as long as it lasts.
   */
  private persistedUnreadable = false;

  constructor(
    private readonly systemSettings: SystemSettingsService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * The env break-glass. `true` / `false` / `null` (no override).
   *
   * Read fresh every time, never memoised: an operator who edits the variable
   * and restarts expects the new value, and one who edits it in a running
   * container's environment (rare, but possible) should not be told the old
   * one for the life of the process.
   */
  readEnvOverride(): boolean | null {
    const raw = process.env.MAINTENANCE_MODE;
    if (raw === 'true') {
      return true;
    }
    if (raw === 'false') {
      return false;
    }
    return null;
  }

  /**
   * Install (or clear, with `null`) the in-process override.
   *
   * The ONLY intended caller is the restore swap (#285): take the window before
   * renaming the database, release it after. It is deliberately not reachable
   * over HTTP — an override nothing persists and nothing else can see would be
   * an operator's worst debugging afternoon.
   */
  setInMemoryOverride(override: MaintenanceOverride | null): void {
    this.memoryOverride = override
      ? {
          enabled: override.enabled,
          ...(override.message !== undefined ? { message: override.message } : {}),
          ...(override.allowAdmins !== undefined
            ? { allowAdmins: override.allowAdmins }
            : {}),
        }
      : null;

    this.logger.warn(
      override
        ? `In-memory maintenance override set: enabled=${override.enabled}`
        : 'In-memory maintenance override cleared',
    );
  }

  /** The current in-process override, or `null`. */
  getInMemoryOverride(): MaintenanceOverride | null {
    return this.memoryOverride;
  }

  /** Drop the cached persisted read, so the next resolve consults the row. */
  invalidateCache(): void {
    this.cache = null;
  }

  /**
   * Resolve all three layers into the effective state.
   *
   * `fresh: true` bypasses the cache and is what the admin GET uses — an
   * operator inspecting the switch must never be shown a value up to five
   * seconds stale, however cheap that would be.
   */
  async resolve(options: { fresh?: boolean } = {}): Promise<MaintenanceStatus> {
    const env = this.readEnvOverride();
    const memory = this.memoryOverride;
    const persisted = await this.readPersisted(options);

    // `??`, never `||`: `false` is a meaningful value at both of the first two
    // layers, and `||` would silently promote "forced off" to "ask the next
    // layer", which is the exact bug the break-glass exists to avoid.
    const enabled = env ?? memory?.enabled ?? persisted.value.enabled;

    // `message` and `allowAdmins` are resolved INDEPENDENTLY of `enabled`, from
    // the highest layer that actually supplies them. The env layer carries a
    // boolean and nothing else, so a window forced open from the environment
    // still shows the operator's stored copy and honours the stored
    // `allowAdmins` — which is what makes `MAINTENANCE_MODE=true` usable
    // without also having to invent a message in a shell variable.
    const message = memory?.message ?? persisted.value.message;
    const allowAdmins = memory?.allowAdmins ?? persisted.value.allowAdmins;

    const source: MaintenanceSource =
      env !== null ? 'env' : memory !== null ? 'memory' : 'persisted';

    return {
      enabled,
      message,
      allowAdmins,
      // Provenance is a property of the PERSISTED window and of nothing else:
      // neither the environment nor the restore swap has a user to attribute
      // the window to, and inventing one would put a lie in the audit trail.
      startedAt: persisted.value.startedAt,
      startedById: persisted.value.startedById,
      source,
      layers: {
        env: { present: env !== null, enabled: env },
        memory: { present: memory !== null, override: memory },
        persisted,
      },
    };
  }

  /**
   * Whether traffic is being held back at all, ignoring who the caller is.
   *
   * Used by the readiness probe, which has no bearer token and therefore no
   * `allowAdmins` question to ask.
   */
  async isEnabled(): Promise<boolean> {
    return (await this.resolve()).enabled;
  }

  /**
   * Open or close the persisted window (`PUT /api/admin/maintenance`).
   *
   * WRITES THROUGH `SystemSettingsService.patchSettings`, not through Prisma
   * directly. That path already owns the merge, the unknown-key preservation
   * (#130) and the row's version counter, and a second writer to the same JSONB
   * column would be a second chance to destroy a key this build does not model.
   * The side effect is that the shared `system_settings:patch` audit row is
   * written too; the `maintenance:*` row below is the one that names the window
   * and carries its provenance, and is what an operator greps for.
   */
  async setMaintenance(
    input: SetMaintenanceInput,
    actorUserId: string,
  ): Promise<MaintenanceStatus> {
    const before = await this.readPersisted({ fresh: true });
    const wasEnabled = before.value.enabled;

    const patch: NonNullable<PatchSystemSettingsDto['maintenance']> = {
      enabled: input.enabled,
    };
    if (input.message !== undefined) {
      patch.message = input.message;
    }
    if (input.allowAdmins !== undefined) {
      patch.allowAdmins = input.allowAdmins;
    }

    if (input.enabled && !wasEnabled) {
      // Opening a window records WHEN and BY WHOM, once. A window that is
      // already open keeps its original start: re-sending `enabled: true` to
      // change the message is an edit, not a new window, and moving the
      // timestamp would erase how long traffic has actually been held.
      patch.startedAt = new Date().toISOString();
      patch.startedById = actorUserId;
    } else if (!input.enabled) {
      // Closing clears the provenance so the next window cannot inherit the
      // previous one's start. `null` is an explicit clear here, which is why
      // these fields are `.nullable().optional()` in the patch schema.
      patch.startedAt = null;
      patch.startedById = null;
    }

    await this.systemSettings.patchSettings(
      { maintenance: patch } as PatchSystemSettingsDto,
      actorUserId,
    );

    // Before the audit row and before anything else reads: the very next
    // request must see the new value, not a cached copy of the old one.
    this.invalidateCache();

    await this.writeAuditEvent(input.enabled, wasEnabled, actorUserId, patch);

    this.logger.warn(
      input.enabled
        ? `Maintenance mode ENABLED by user ${actorUserId} (allowAdmins=${
            patch.allowAdmins ?? before.value.allowAdmins
          })`
        : `Maintenance mode DISABLED by user ${actorUserId}`,
    );

    return this.resolve({ fresh: true });
  }

  /**
   * Read the persisted namespace, tolerating a database that is not there.
   *
   * THE FAILURE PATH IS THE POINT. During the restore swap the row genuinely
   * cannot be read, and a guard that threw would turn every request into a 500
   * — the opposite of the orderly 503 this feature exists to produce. So a
   * failed read degrades to the last value this process saw, and to the seeded
   * defaults (`enabled: false`) if it has never seen one. Neither is a guess
   * about the operator's intent: the swap's own in-memory override is what
   * holds traffic back in that window, and it outranks this layer anyway.
   *
   * Goes through `SystemSettingsService`, which projects the row through
   * `readKnownSettings` — so a damaged or partially-written row yields the
   * seeded maintenance defaults rather than a crash, exactly as every other
   * reader of that column does.
   */
  private async readPersisted(
    options: { fresh?: boolean } = {},
  ): Promise<{ readable: boolean; value: SystemMaintenanceValue }> {
    const now = Date.now();
    if (
      !options.fresh &&
      this.cache &&
      now - this.cache.readAt < MAINTENANCE_PERSISTED_CACHE_MS
    ) {
      return { readable: true, value: this.cache.value };
    }

    try {
      const value = await this.systemSettings.getMaintenancePolicy();
      this.cache = { value, readAt: now };

      if (this.persistedUnreadable) {
        this.persistedUnreadable = false;
        this.logger.log('Maintenance settings are readable again');
      }

      return { readable: true, value };
    } catch (error) {
      // One warning per outage, not one per request: a global guard runs on
      // every call, and a database that is down for a minute would otherwise
      // write thousands of identical lines over the logs an operator is
      // reading to find out what happened.
      if (!this.persistedUnreadable) {
        this.persistedUnreadable = true;
        this.logger.warn(
          `Could not read maintenance settings; falling back to the last known state: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }

      return {
        readable: false,
        value: this.cache?.value ?? {
          ...DEFAULT_SYSTEM_SETTINGS.maintenance,
        },
      };
    }
  }

  /**
   * One audit row per write, following the repository's existing pattern
   * (`UsersService.createAuditEvent`, `AllowlistService.createAuditEvent`):
   * `actorUserId`, a `<area>:<verb>` action, a target pair, and a `meta` blob.
   *
   * Written for EVERY write, including one that does not change `enabled` — a
   * re-send that only edits the message is still somebody reaching for this
   * switch during an incident, and "who touched it and when" is the entire
   * value of the row.
   */
  private async writeAuditEvent(
    enabled: boolean,
    wasEnabled: boolean,
    actorUserId: string,
    patch: NonNullable<PatchSystemSettingsDto['maintenance']>,
  ): Promise<void> {
    await this.prisma.auditEvent.create({
      data: {
        actorUserId,
        action: enabled ? MAINTENANCE_AUDIT_ENABLE : MAINTENANCE_AUDIT_DISABLE,
        targetType: MAINTENANCE_AUDIT_TARGET_TYPE,
        targetId: MAINTENANCE_AUDIT_TARGET_ID,
        meta: {
          previouslyEnabled: wasEnabled,
          enabled,
          // Only what the write actually set. A meta blob that restated the
          // whole namespace would make an unchanged field look like a change.
          ...(patch.message !== undefined ? { message: patch.message } : {}),
          ...(patch.allowAdmins !== undefined
            ? { allowAdmins: patch.allowAdmins }
            : {}),
          ...(patch.startedAt !== undefined ? { startedAt: patch.startedAt } : {}),
        } as never,
      },
    });
  }
}
