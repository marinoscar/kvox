import { z } from 'zod';
import { Injectable, Logger, ConflictException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { UpdateSystemSettingsDto } from '../dto/update-system-settings.dto';
import {
  PatchSystemSettingsDto,
  updateSystemSettingsSchema,
} from '../dto/update-system-settings.dto';
import {
  DEFAULT_SYSTEM_SETTINGS,
  SystemSettingsValue,
} from '../../common/types/settings.types';
import {
  SystemSettingsDto,
  systemSettingsSchema,
  systemNotificationsSchema,
  systemJobsSchema,
  systemNodesSchema,
  systemDatabaseBackupSchema,
  systemMaintenanceSchema,
  MAX_DISABLED_NOTIFICATION_EVENTS,
  type SystemNotificationsValue,
  type SystemMaintenanceValue,
  type SystemJobsValue,
  type SystemNodesValue,
  type SystemDatabaseBackupValue,
} from '../../common/schemas/settings.schema';

const SETTINGS_KEY = 'global';

// =============================================================================
// SystemSettingsService — the 'global' system_settings row (#130)
// =============================================================================
//
// THE RULE THIS SERVICE NOW ENFORCES, IN ONE LINE:
//   request bodies stay CLOSED; the stored value is never NARROWED.
//
// Two different things used to be conflated, and conflating them is what made
// this row a trap:
//
//   • What a caller is allowed to SEND. Still strictly validated, still
//     unknown-key-stripping, at both the DTO layer (`createZodDto` +
//     nestjs-zod's pipe) and again here via `systemSettingsSchema.parse`. No
//     new write surface is opened by this file: an admin cannot smuggle an
//     arbitrary blob into `system_settings` through PUT or PATCH.
//
//   • What is already STORED. Carried forward verbatim. A key we do not
//     recognise got into that row through some path we trust — a seed, a
//     migration, a newer build of this same service — and "this version of the
//     code does not know what that is" has never been a good reason to delete
//     someone's data.
//
// WHAT WAS BROKEN (both write paths, independently):
//
//   • replaceSettings (PUT)  → `systemSettingsSchema.parse(dto)` and store the
//     result. Zod strips unknown keys, so every key outside the schema
//     vanished from the row.
//   • patchSettings (PATCH)  → hand-built `merged` from a fixed set of named
//     keys copied out of the current value, discarding the rest — on a
//     PARTIAL update, where the caller had asked to change one setting and
//     nothing else.
//
// Neither produced an error, a log line, or an audit entry. The admin's action
// ("I changed a setting") had no visible connection to the outcome ("the thing
// that key configured is now unconfigured").
//
// WHY PRESERVE RATHER THAN REJECT. The alternative on the table was to fail
// the save when the stored value carries an unknown key. It is cheaper, and it
// does convert a silent trap into an error — but it puts the error on the
// wrong person at the worst time. The admin who typed nothing wrong gets a
// 4xx, the system settings page becomes unusable for everyone, and there is no
// route back through the API: someone has to hand-edit JSONB in production to
// restore the ability to change a setting. Worse for a repo that exists
// to be EXTENDED: the moment a downstream app adds a key to this row, its
// admins discover the constraint as an outage. And a deploy that rolls back
// across the addition of a key — build N knows `branding`, build N-1 does not
// — turns a routine rollback into "settings cannot be saved". Under this file,
// that same rollback window is uneventful: N-1 carries `branding` forward
// untouched and N finds it intact.
//
// WHY PUT PRESERVES TOO, WHICH LOOKS LIKE A SEMANTIC VIOLATION AND IS NOT.
// PUT replaces the resource as REPRESENTED. `getSettings` projects exactly the
// modelled namespaces plus `security`, `updatedAt`, `updatedBy` and `version`;
// unknown keys have never been part of that representation, so no client can
// read them, and therefore no client can echo them back in a PUT. Asking PUT to
// replace what GET never showed would mean "every full save destroys storage
// the caller was not even allowed to see" — which is the bug, restated. The
// modelled namespaces are replaced as before; only the invisible remainder
// survives.
//
// A MALFORMED STORED VALUE MUST NOT MAKE SETTINGS UNSAVABLE, EITHER. Same
// argument as above, one step further: if the row holds `null`, a string, or
// `{ notifications: 42 }`, refusing the write strands the admin with a row only a manual
// JSONB edit can repair — the identical trap "fail loudly" would have set. So
// every read of the column goes through `readKnownSettings`, which degrades
// field by field to `DEFAULT_SYSTEM_SETTINGS`, and this file contains no
// `as unknown as SystemSettingsValue` casts: a cast asserts a shape nobody
// checked, and one of them is precisely how PATCH kept throwing a TypeError
// after the rest of #130 was fixed.
//
// WHY NOT `.passthrough()` ON THE SCHEMA (the other half of the obvious fix).
// Passthrough would let unknown keys in from the REQUEST as well, turning an
// admin-authenticated endpoint into an arbitrary JSONB writer with no cap and
// no shape — the unvalidated growth #126 had to bound in `notifications` with
// key patterns and per-channel caps. Preserving from storage gets the safety
// without opening the door: the set of unknown keys can only ever shrink (a
// key becomes known when someone adds it to the schema) or come from a path
// that is not this endpoint.
//
// PRESERVED IS NOT THE SAME AS SUPPORTED. A preserved key round-trips through
// storage; it does NOT appear in `GET /api/system-settings` and is not
// validated. Adding a real setting still
// means adding it to `systemSettingsSchema`, `SystemSettingsValue` and the
// response projection. What this buys is that forgetting a step costs you a
// missing feature instead of destroyed data. And for anything with its own
// lifecycle, provenance or secrets, the right answer remains a row of its own,
// as #122's email settings did (`system_settings.key = 'email'`): a separate
// row cannot be clobbered by this one at all, keeps SMTP host and username out
// of this response, and gets an independent version counter for `If-Match`.
//
// The sibling precedent is `user-settings.service.ts`, which reaches the same
// place from the other direction: every namespace there is declared explicitly
// and merged explicitly, with "only set the key when the merge produced
// something" so an emptied namespace collapses to absent rather than `{}`.
// Same principle — a write path must never quietly redefine state it did not
// mean to touch.
// =============================================================================

/**
 * The top-level keys `systemSettingsSchema` actually understands.
 *
 * DERIVED FROM THE SCHEMA, never written out as literals. A hand-maintained
 * list is precisely the thing that goes stale: someone adds `branding` to the
 * schema, forgets the list, and the new key is treated as "unknown" — carried
 * forward but never validated, which is a quieter version of the same bug.
 * Deriving it means the two cannot drift.
 */
const KNOWN_TOP_LEVEL_KEYS: readonly string[] = Object.keys(
  systemSettingsSchema.shape,
);

/**
 * The known keys of every CLOSED nested object in the value, keyed by
 * namespace: `{ notifications: ['browserEnabled', 'disabledEvents'], ... }`.
 *
 * `notifications` (#225) needed a list of its own because an unknown key
 * inside it (say a `notifications.digest` left behind by a rolled-back deploy)
 * is destroyed by exactly the same mechanism as an unknown TOP-LEVEL key, and
 * must therefore get exactly the same treatment. #256 would have needed four
 * more.
 *
 * So it is a DERIVED MAP rather than one hand-written constant per namespace.
 * The list-per-namespace shape does not scale past the point where someone
 * adds a namespace and forgets its constant — at which point that namespace
 * silently loses unknown keys while its neighbours keep them, which is a
 * harder bug to see than the one it replaced. This asks the schema instead:
 * every `ZodObject` in the shape is closed and gets an entry; a field that is
 * not an object (an open `z.record`, say) cannot strip anything, so it would
 * be skipped by construction rather than by being left off a list.
 *
 * ONE LEVEL DEEP, exactly as before. `jobs.history` is a closed object one
 * level further down and is NOT walked: preservation is a safety net for keys
 * a rolled-back deploy left behind, and the depth it reaches has always been
 * the depth the merge below writes.
 */
const KNOWN_NESTED_KEYS: Readonly<Record<string, readonly string[]>> =
  Object.fromEntries(
    Object.entries(systemSettingsSchema.shape)
      .filter(([, field]) => field instanceof z.ZodObject)
      .map(([key, field]) => [
        key,
        Object.keys((field as z.ZodObject<z.ZodRawShape>).shape),
      ]),
  );

/**
 * The top-level namespaces a PUT body is allowed to omit (#256).
 *
 * DERIVED FROM THE WIRE SCHEMA — the keys of `updateSystemSettingsSchema` that
 * accept `undefined` — and not from a list written out here. The two would
 * otherwise be one more pair that can drift, and the drift is invisible in
 * exactly the direction that hurts: promote a namespace to required on the
 * wire, forget this list, and `replaceSettings` goes on "carrying forward" a
 * key the caller is now obliged to send, which quietly makes the requirement
 * unenforceable.
 *
 * See `updateSystemSettingsSchema` for why anything is optional there at all.
 */
const OMITTABLE_ON_PUT: readonly string[] = (
  Object.entries(updateSystemSettingsSchema.shape) as Array<[string, z.ZodType]>
)
  .filter(([, field]) => field.safeParse(undefined).success)
  .map(([key]) => key);

@Injectable()
export class SystemSettingsService {
  private readonly logger = new Logger(SystemSettingsService.name);

  constructor(
    private readonly prisma: PrismaService,
    // ConfigService needs no module import: ConfigModule is registered with
    // `isGlobal: true` in app.module.ts, so SettingsModule already has it.
    private readonly configService: ConfigService,
  ) {}

  /**
   * Load the 'global' row, creating it with defaults if it is missing.
   *
   * Extracted so the read path and the PATCH path share one definition of
   * "the current row" — PATCH needs the RAW stored value (to see the keys the
   * projection hides), not the projection, and before #130 it had no way to
   * ask for it: it called `getSettings()` and could only ever see the modelled
   * namespaces. That is not incidental to the bug, it IS the bug.
   */
  private async loadOrCreateRow() {
    const existing = await this.prisma.systemSettings.findUnique({
      where: { key: SETTINGS_KEY },
      include: {
        updatedByUser: {
          select: { id: true, email: true },
        },
      },
    });

    if (existing) {
      return existing;
    }

    // Should have been seeded, but create if missing
    const created = await this.prisma.systemSettings.create({
      data: {
        key: SETTINGS_KEY,
        value: DEFAULT_SYSTEM_SETTINGS as any,
      },
      include: {
        updatedByUser: {
          select: { id: true, email: true },
        },
      },
    });
    this.logger.warn('Created default system settings - seed may not have run');

    return created;
  }

  /**
   * The ONE place this file is allowed to turn a JSONB value into an object.
   *
   * `system_settings.value` is a JSONB column: at runtime it can be a string,
   * a number, a boolean, an array, SQL NULL or JSON `null`, no matter what
   * Prisma's generated type or a hand-written cast claims. Every read below
   * funnels through here so that "is this actually a plain object?" is asked
   * once, in one way, instead of being assumed in some paths and checked in
   * others — which is exactly the split that let #130's follow-up bug through
   * (PUT checked, PATCH cast and dereferenced).
   *
   * Arrays are rejected along with primitives: an array IS an object to
   * `typeof`, but treating one as a settings map would spread its indices in
   * as keys, and `['a']` becoming `{ '0': 'a' }` in the row is data corruption
   * dressed up as tolerance.
   */
  private asPlainObject(value: unknown): Record<string, unknown> | undefined {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return undefined;
    }

    return value as Record<string, unknown>;
  }

  /**
   * Project a raw stored value down to the shape this code models, falling
   * back to the seeded defaults for anything missing or of the wrong type.
   *
   * WHY THIS EXISTS (#130 follow-up). The rule the issue settled on is that a
   * malformed stored value must not make settings unsavable: an admin whose
   * row is `null`, or a string, or `{ notifications: 42 }`, must still be able
   * to repair it through the API. `mergePreservingUnknown` and
   * `collectUnknownKeys` were written to honour that and do; `patchSettings`
   * never reached them, because it first did `row.value as unknown as
   * SystemSettingsValue` and then read nested fields straight off it. A cast is
   * not a check — it asserts a shape nobody verified — so a `null` row threw
   * `TypeError: Cannot read properties of null` before a single defensive line
   * ran. PUT was unaffected only because it happens never to
   * touch the stored value except through the guarded helper.
   *
   * So there are no `as unknown as SystemSettingsValue` casts left in this
   * file. Every read of the column goes through here, which means the type
   * annotation is now earned rather than asserted.
   *
   * FIELD BY FIELD, NOT ALL-OR-NOTHING. A row where only `jobs` is corrupt
   * keeps its good `notifications` value; a row that is wholly unusable yields
   * `DEFAULT_SYSTEM_SETTINGS`. Degrading per field means a partially damaged
   * row loses only the damaged part, and a PATCH over it writes the caller's
   * changes on top of sane defaults — the same outcome PUT already produces.
   *
   * INVALID VALUES OF KNOWN KEYS ARE DROPPED, and that is not in tension with
   * preserving unknown keys. A value of a KNOWN key that fails its schema
   * cannot survive `systemSettingsSchema.parse` under any code path, so
   * carrying it into `merged` would only convert the old TypeError into a
   * ZodError and leave the row just as unrepairable. Genuinely unknown keys —
   * top level or inside a closed namespace — are untouched here and still
   * carried forward verbatim by `mergePreservingUnknown`, which reads the RAW
   * value, not this projection.
   */
  private readKnownSettings(stored: unknown): SystemSettingsValue {
    const root = this.asPlainObject(stored);
    const storedNotifications = this.asPlainObject(root?.notifications);

    return {
      notifications: {
        browserEnabled:
          typeof storedNotifications?.browserEnabled === 'boolean'
            ? storedNotifications.browserEnabled
            : DEFAULT_SYSTEM_SETTINGS.notifications.browserEnabled,
        disabledEvents: this.readDisabledEvents(
          storedNotifications?.disabledEvents,
        ),
      },
      // Operations namespaces (#256). Same contract as everything above —
      // whatever is on disk, what comes back validates — but read through one
      // helper instead of four more hand-written ladders. See
      // `readNamespace`.
      jobs: this.readNamespace(
        root?.jobs,
        systemJobsSchema,
        DEFAULT_SYSTEM_SETTINGS.jobs,
      ),
      nodes: this.readNamespace(
        root?.nodes,
        systemNodesSchema,
        DEFAULT_SYSTEM_SETTINGS.nodes,
      ),
      databaseBackup: this.readNamespace(
        root?.databaseBackup,
        systemDatabaseBackupSchema,
        DEFAULT_SYSTEM_SETTINGS.databaseBackup,
      ),
      maintenance: this.readNamespace(
        root?.maintenance,
        systemMaintenanceSchema,
        DEFAULT_SYSTEM_SETTINGS.maintenance,
      ),
    };
  }

  /**
   * Project one stored namespace down to something its schema will accept,
   * field by field, falling back to that namespace's defaults (#256).
   *
   * WHY A HELPER AND NOT FOUR MORE LADDERS. `notifications` is read by hand
   * above because it is two fields; the four operations
   * namespaces are twenty-three between them, and twenty-three hand-written
   * `typeof x === 'number' ? x : DEFAULT...` lines is twenty-three chances to
   * name the wrong default. This asks each field's own schema instead, so the
   * check and the declaration cannot disagree — a bound tightened in
   * `settings.schema.ts` tightens what survives a damaged row too, with nothing
   * to update here.
   *
   * FIELD BY FIELD FOR THE REASON `readKnownSettings` IS: a row where one
   * number is corrupt keeps every other value an operator set, rather than
   * having the whole namespace snap back to the defaults. The granularity is
   * one level — `jobs.history` is validated as a unit, so a bad
   * `retentionDays` costs the `purgeEnabled` next to it. That is the same depth
   * the merge and the preservation work at, and matching them is worth more
   * than one extra level of salvage.
   *
   * THE FALLBACK IS CLONED, never handed out by reference:
   * `DEFAULT_SYSTEM_SETTINGS` is a module-level constant, and returning its
   * nested `history` object to a caller that merges into it and persists it is
   * a mutation bug waiting on the first caller that does. Same rule
   * `readDisabledEvents` follows for its array.
   */
  private readNamespace<T extends Record<string, unknown>>(
    stored: unknown,
    schema: z.ZodObject<z.ZodRawShape>,
    defaults: T,
  ): T {
    const source = this.asPlainObject(stored) ?? {};
    const value: Record<string, unknown> = {};

    const fields = Object.entries(schema.shape) as Array<[string, z.ZodType]>;
    for (const [key, field] of fields) {
      const parsed = field.safeParse(source[key]);
      value[key] = parsed.success
        ? parsed.data
        : structuredClone(defaults[key]);
    }

    return value as T;
  }

  /**
   * Project a stored `notifications.disabledEvents` down to something
   * `systemSettingsSchema` will accept (#225).
   *
   * Same argument as "INVALID VALUES OF KNOWN KEYS ARE DROPPED" above, one level
   * deeper. `notifications` is a KNOWN key, so whatever this returns is handed
   * straight to `systemSettingsSchema.parse` — an entry that fails the event-key
   * pattern, or an array longer than the cap, would convert a repairable row
   * into a ZodError and leave the admin unable to save anything at all. Dropping
   * the unusable entries keeps the row repairable through the API, which is the
   * whole point of `readKnownSettings`.
   *
   * A fresh array every call, never `DEFAULT_SYSTEM_SETTINGS.notifications
   * .disabledEvents` itself: that constant is module-level and shared, and
   * handing out the same array reference to be merged into and persisted is a
   * mutation bug waiting on the first caller that pushes to it.
   */
  private readDisabledEvents(stored: unknown): string[] {
    if (!Array.isArray(stored)) {
      return [];
    }

    return stored
      .filter(
        (entry): entry is string =>
          typeof entry === 'string' &&
          systemNotificationsSchema.shape.disabledEvents.element.safeParse(entry)
            .success,
      )
      .slice(0, MAX_DISABLED_NOTIFICATION_EVENTS);
  }

  /**
   * Collect the entries of `stored` whose keys are not in `knownKeys`.
   *
   * Defensive about the input type on purpose, via `asPlainObject`: anything
   * that is not a plain object contributes no keys rather than throwing — a
   * malformed row must not make settings unsavable, which is the failure mode
   * this whole change exists to avoid.
   */
  private collectUnknownKeys(
    stored: unknown,
    knownKeys: readonly string[],
  ): Record<string, unknown> {
    const source = this.asPlainObject(stored);
    if (!source) {
      return {};
    }

    const unknown: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(source)) {
      if (!knownKeys.includes(key)) {
        unknown[key] = value;
      }
    }

    return unknown;
  }

  /**
   * Produce the object to persist: the validated known settings, with every
   * unrecognised key of the currently stored value laid back underneath.
   *
   * Spread order is load-bearing. The unknown keys go FIRST so that `validated`
   * always wins: if a key is known, the caller's (validated) value is
   * authoritative and the stored one is replaced, which is what preserves the
   * existing behaviour of every modelled namespace byte for byte. The unknown keys
   * can only ever fill slots `validated` does not occupy.
   *
   * Returns the preserved paths alongside the value so the caller can put them
   * in the log and the audit meta. That reporting is not decoration: #130's
   * complaint is as much "nothing in the audit trail" as it is the data loss,
   * and a key silently surviving is only marginally better than a key silently
   * disappearing — either way nobody learns that this row holds something the
   * code does not model.
   */
  private mergePreservingUnknown(
    storedValue: unknown,
    validated: SystemSettingsDto,
  ): { value: Record<string, unknown>; preservedPaths: string[] } {
    const unknownTopLevel = this.collectUnknownKeys(
      storedValue,
      KNOWN_TOP_LEVEL_KEYS,
    );

    const storedRoot = this.asPlainObject(storedValue);

    const value: Record<string, unknown> = {
      ...unknownTopLevel,
      ...validated,
    };

    const preservedPaths = [...Object.keys(unknownTopLevel)];

    // The same treatment, once per closed nested namespace, driven by the
    // schema rather than by a line per namespace (#256). Spread order is
    // load-bearing here exactly as it is above: the unknown keys go first so
    // the validated value always wins.
    for (const [namespace, knownKeys] of Object.entries(KNOWN_NESTED_KEYS)) {
      const unknown = this.collectUnknownKeys(
        storedRoot?.[namespace],
        knownKeys,
      );

      const validatedNamespace = (
        validated as unknown as Record<string, Record<string, unknown>>
      )[namespace];

      value[namespace] = { ...unknown, ...validatedNamespace };

      preservedPaths.push(
        ...Object.keys(unknown).map((key) => `${namespace}.${key}`),
      );
    }

    return { value, preservedPaths };
  }

  /**
   * Report preserved keys once per write, on the log line and in the audit
   * meta. Omitted entirely when there is nothing to report so the audit rows
   * of a normal deployment (where the modelled namespaces are all there is) stay
   * exactly as they were.
   */
  private reportPreserved(operation: string, preservedPaths: string[]) {
    if (preservedPaths.length === 0) {
      return;
    }

    this.logger.warn(
      `System settings ${operation}: preserved ${preservedPaths.length} key(s) not modelled by systemSettingsSchema (${preservedPaths.join(', ')}). ` +
        'They survive the write but are not validated and are not returned by GET /api/system-settings — add them to the schema, or give them their own system_settings row (see #130).',
    );
  }

  /**
   * The `security` block of the response: DERIVED CONFIGURATION, never stored.
   *
   * `systemSettingsResponseSchema` has always declared `security`, and both
   * `docs/API.md` and `docs/ARCHITECTURE.md` document it — but nothing ever
   * populated it, so the OpenAPI document at /api/docs advertised a key every
   * response omitted and a generated client got a field that is permanently
   * `undefined` (#148). Deleting the declaration was the smaller diff; it would
   * also have shrunk a surface three places consistently promise, to match an
   * omission. And the session policy is worth showing an admin: it is not a
   * secret — any authenticated user can already read the `exp` claim of their
   * own access token.
   *
   * IT IS NOT PART OF THE STORED VALUE, in any sense. `security` is absent from
   * `systemSettingsSchema`, therefore from `SystemSettingsValue` and from
   * `KNOWN_TOP_LEVEL_KEYS`, and it plays no part in the machinery above: it
   * never enters `system_settings.value`, never reaches `mergePreservingUnknown`
   * and can be neither preserved nor clobbered. `version` and `If-Match` go on
   * describing the stored row alone.
   *
   * IT IS READ-ONLY BY CONSTRUCTION AND NEEDS NO NEW GUARD. Both values are
   * deploy-time configuration (`JWT_ACCESS_TTL_MINUTES`,
   * `JWT_REFRESH_TTL_DAYS`), so ConfigService is the only honest source —
   * reading them from the row would let a saved number disagree with the TTL
   * the token signer actually uses, which is worse than not showing them.
   * Nothing makes them look writable: neither `updateSystemSettingsSchema` (PUT)
   * nor `patchSystemSettingsSchema` (PATCH) declares `security`, both are plain
   * `z.object`s, and the global `ZodValidationPipe` strips unknown request keys
   * — so a client that PUTs a `security` block has it discarded before this
   * service is called.
   *
   * The defaults are `configuration.ts`'s own (15 and 14) deliberately: the
   * response field is typed `z.number()`, and a config lookup that missed would
   * otherwise put `undefined` where the contract promises a number — trading
   * one broken promise for a subtler one.
   */
  private readSecurityPolicy() {
    return {
      jwtAccessTtlMinutes: this.configService.get<number>(
        'jwt.accessTtlMinutes',
        15,
      ),
      refreshTtlDays: this.configService.get<number>('jwt.refreshTtlDays', 14),
    };
  }

  /**
   * The ONE projection from a settings row to `SystemSettingsResponseDto`.
   *
   * GET, PUT and PATCH all return this DTO and had each built the object by
   * hand, which is how `security` could be declared in the response schema and
   * missing from all three at once. Projecting through one helper means a field
   * added here cannot be added to one path and forgotten in the other two.
   */
  private toResponse(row: {
    value: unknown;
    updatedAt: Date;
    updatedByUser: { id: string; email: string } | null;
    version: number;
  }) {
    // Guarded, not cast: a row that is `null` or otherwise malformed reads as
    // the defaults instead of throwing, so the settings page still renders and
    // the admin can save a repair through PUT/PATCH (#130).
    const value = this.readKnownSettings(row.value);

    return {
      notifications: value.notifications,
      // #256. Part of the represented resource from the day the namespaces
      // exist, not from the day a UI reads them: a block a client cannot GET is
      // a block it cannot echo back in a PUT, and `replaceSettings` would then
      // be carrying it forward blind forever. Publishing it is what makes the
      // PUT round-trip honest, and what lets the integration test prove a PATCH
      // was actually stored rather than merely accepted.
      jobs: value.jobs,
      nodes: value.nodes,
      databaseBackup: value.databaseBackup,
      maintenance: value.maintenance,
      security: this.readSecurityPolicy(),
      updatedAt: row.updatedAt,
      updatedBy: row.updatedByUser,
      version: row.version,
    };
  }

  /**
   * Get system settings
   * Creates default if not found (should exist from seed)
   *
   * DELIBERATELY STILL A NARROW PROJECTION. Preserved-but-unknown keys are not
   * surfaced here: the response is typed by `SystemSettingsResponseDto` and
   * consumed by the admin UI, and leaking unmodelled storage into a public
   * contract is a different (and worse) decision than not destroying it.
   * Preservation is a safety net, not a read path — see the header.
   */
  async getSettings() {
    const settings = await this.loadOrCreateRow();

    return this.toResponse(settings);
  }

  /**
   * The deployment-wide browser-notification policy, read only (#226).
   *
   * A NARROW ACCESSOR RATHER THAN `getSettings()`, for two reasons that both
   * matter on the path that calls it (the notification dispatcher, on every
   * event, plus two endpoints any authenticated user can reach):
   *
   *   1. IT DOES NOT CREATE THE ROW. `getSettings` goes through
   *      `loadOrCreateRow`, which INSERTs when the row is missing. A read on a
   *      fire-and-forget send path must not write — the same rule
   *      `NotificationsService.loadRecipient` follows for `user_settings`, and
   *      for the same reason: materialising a settings row as a side effect of
   *      sending a notification is a write nobody asked for, on a path with no
   *      caller left to report it to.
   *   2. IT RETURNS ONLY THIS BLOCK. `GET /api/system-settings` is gated on
   *      `system_settings:read`, which a Viewer does not hold, and widening
   *      that permission so a Viewer's browser can learn whether toasts are
   *      enabled would hand every account the whole settings blob.
   *      `GET /api/notifications/config` exists precisely so the answer
   *      can be published without the rest of the row; see its handler.
   *
   * Degrades exactly as every other read here does: a missing row, a `null`
   * value or a malformed one yields `DEFAULT_SYSTEM_SETTINGS.notifications`
   * through `readKnownSettings`, so a damaged row cannot make notifications
   * undeliverable.
   */
  async getNotificationsPolicy(): Promise<SystemNotificationsValue> {
    const row = await this.prisma.systemSettings.findUnique({
      where: { key: SETTINGS_KEY },
      select: { value: true },
    });

    return this.readKnownSettings(row?.value).notifications;
  }

  /**
   * The persisted maintenance window, read only (#257, epic #254).
   *
   * A NARROW ACCESSOR RATHER THAN `getSettings()`, for the two reasons
   * `getNotificationsPolicy` above gives, and one more that is specific to this
   * caller:
   *
   *   1. IT DOES NOT CREATE THE ROW. `getSettings` goes through
   *      `loadOrCreateRow`, which INSERTs when the row is missing. This is read
   *      by a GLOBAL GUARD on every request in the application; a read path
   *      that can write is not acceptable there at all, and least of all
   *      during a maintenance window, when the database may be exactly what is
   *      being worked on.
   *   2. IT RETURNS ONLY THIS BLOCK. The guard has no business seeing the
   *      whole settings row, and neither has anything it might hand a value to.
   *   3. IT IS ALLOWED TO THROW. `MaintenanceModeService.readPersisted` catches
   *      it and degrades to its last known state — the restore swap (#285)
   *      renames the live database, so "this read failed" is a NORMAL,
   *      anticipated outcome there rather than a bug. Nothing is swallowed
   *      here, so that caller can tell the difference.
   *
   * Degrades exactly as every other read here does: a missing row, a `null`
   * value or a malformed one yields `DEFAULT_SYSTEM_SETTINGS.maintenance`
   * through `readKnownSettings` — which means a damaged row reads as
   * `enabled: false` and cannot take the application off the air by accident.
   */
  async getMaintenancePolicy(): Promise<SystemMaintenanceValue> {
    const row = await this.prisma.systemSettings.findUnique({
      where: { key: SETTINGS_KEY },
      select: { value: true },
    });

    return this.readKnownSettings(row?.value).maintenance;
  }

  /**
   * The job-queue policy — history retention and the stuck-job threshold
   * (#263, epic #254).
   *
   * A NARROW ACCESSOR RATHER THAN `getSettings()`, for the two reasons
   * `getNotificationsPolicy` above gives, plus one that belongs to this
   * caller specifically:
   *
   *   1. IT DOES NOT CREATE THE ROW. `getSettings` goes through
   *      `loadOrCreateRow`, which INSERTs when the row is missing. Every
   *      caller here is a background timer — the lease reaper every ten
   *      minutes, the history-purge scheduler at midnight, the purge handler
   *      itself — and a cron tick materialising a settings row is a write
   *      nobody asked for, on a path with no request to attribute it to.
   *   2. IT RETURNS ONLY THIS BLOCK. The reaper needs one integer and the
   *      purge needs two values; neither has any business holding the whole
   *      settings blob.
   *   3. IT IS THE ONE READ PATH FOR THESE VALUES. `JobStuckService` and
   *      `JobHistoryPurgeHandler` both call this rather than reaching into
   *      `system_settings` themselves, so "where does the threshold come
   *      from" has exactly one answer and a fork changing the storage shape
   *      changes one method.
   *
   * Degrades exactly as every other read here does: a missing row, a `null`
   * value or a malformed one yields `DEFAULT_SYSTEM_SETTINGS.jobs` through
   * `readKnownSettings`, so a damaged row cannot leave dead leases unreaped
   * or history ungoverned — it falls back to the shipped policy.
   */
  async getJobsPolicy(): Promise<SystemJobsValue> {
    const row = await this.prisma.systemSettings.findUnique({
      where: { key: SETTINGS_KEY },
      select: { value: true },
    });

    return this.readKnownSettings(row?.value).jobs;
  }

  /**
   * The worker-fleet policy — the stale window, the offline multiplier and the
   * offline retention (#270, epic #254).
   *
   * A NARROW ACCESSOR RATHER THAN `getSettings()`, for exactly the three
   * reasons `getJobsPolicy` above gives, and read by exactly the callers that
   * argument was written for:
   *
   *   1. IT DOES NOT CREATE THE ROW. Its callers are two background timers —
   *      the stale-offline sweep every ten minutes and the offline prune
   *      daily — plus the admin fleet read. A cron tick materialising a
   *      settings row is a write nobody asked for on a path with no request
   *      to attribute it to.
   *   2. IT RETURNS ONLY THIS BLOCK. The sweep needs two integers and the
   *      prune needs one; neither has any business holding the whole settings
   *      blob.
   *   3. IT IS THE ONE READ PATH FOR THESE VALUES. `NodeLifecycleService` is
   *      the only caller and every consumer goes through it, so "which stale
   *      window is this?" has exactly one answer. That matters more here than
   *      anywhere else in this file, because the whole design of
   *      `offlineStaleMultiplier` — a MULTIPLE of the stale window rather than
   *      an independent duration — exists to stop the UI's "stale" pill and
   *      the database's `offline` status from becoming two unrelated notions
   *      of liveness. A second read path would reintroduce that drift by the
   *      back door.
   *
   * Degrades exactly as every other read here does: a missing row, a `null`
   * value or a malformed one yields `DEFAULT_SYSTEM_SETTINGS.nodes` through
   * `readKnownSettings`, so a damaged row cannot strand a dead fleet at
   * `online` forever — it falls back to the shipped policy.
   */
  async getNodesPolicy(): Promise<SystemNodesValue> {
    const row = await this.prisma.systemSettings.findUnique({
      where: { key: SETTINGS_KEY },
      select: { value: true },
    });

    return this.readKnownSettings(row?.value).nodes;
  }

  /**
   * The database-backup policy — schedule, retention, compression, the stale
   * window and the storage-provider name (#281, epic #254).
   *
   * A NARROW ACCESSOR RATHER THAN `getSettings()`, for exactly the three
   * reasons `getJobsPolicy` above gives, and each of them bites harder here:
   *
   *   1. IT DOES NOT CREATE THE ROW. Its callers are #282's scheduler tick and
   *      `DatabaseBackupRunnerService`'s three entry points (`queueBackup`,
   *      `runQueuedBackup` and `startBackup`). A cron materialising a
   *      settings row as a side effect of deciding whether to take a backup is
   *      a write nobody asked for — and it would happen on every tick of a
   *      deployment that has backups switched off.
   *   2. IT RETURNS ONLY THIS BLOCK. The runner needs three numbers and a
   *      provider name; handing it the whole settings blob widens what a
   *      background process holds for no reason.
   *   3. IT IS THE ONE READ PATH FOR THESE VALUES. `compressionLevel` reaches
   *      `pg_dump`'s argv and `runStaleMinutes` becomes the dump's SIGKILL
   *      deadline; a second read path is how the schedule an operator sees and
   *      the schedule that runs start to differ.
   *
   * Degrades exactly as every other read here does: a missing row, a `null`
   * value or a malformed one yields `DEFAULT_SYSTEM_SETTINGS.databaseBackup`
   * through `readKnownSettings`, so a damaged row cannot be the reason a
   * deployment stops taking backups — it falls back to the shipped policy.
   */
  async getDatabaseBackupPolicy(): Promise<SystemDatabaseBackupValue> {
    const row = await this.prisma.systemSettings.findUnique({
      where: { key: SETTINGS_KEY },
      select: { value: true },
    });

    return this.readKnownSettings(row?.value).databaseBackup;
  }

  /**
   * Replace system settings (PUT)
   */
  async replaceSettings(dto: UpdateSystemSettingsDto, userId: string) {
    // Read the stored value before overwriting it, purely to recover what the
    // body does not carry. `select` is narrow because nothing else is
    // needed — the upsert below still handles the row not existing yet, so
    // this read deliberately does NOT create anything.
    const current = await this.prisma.systemSettings.findUnique({
      where: { key: SETTINGS_KEY },
      select: { value: true },
    });

    // Fill in the namespaces a PUT body is allowed to omit (#256) BEFORE
    // validating, from the stored value — which `readKnownSettings` has already
    // completed with `DEFAULT_SYSTEM_SETTINGS` for anything storage lacks.
    //
    // This is what keeps "optional on the wire" from meaning "reset by
    // omission". `notifications` is untouched by this loop and is replaced
    // wholesale exactly as it always was: it is required on the wire, so it can
    // never be absent here. See
    // `OMITTABLE_ON_PUT`, and `updateSystemSettingsSchema` for why any
    // namespace is omittable at all.
    const body = dto as unknown as Record<string, unknown>;
    const currentValue = this.readKnownSettings(current?.value);
    const filled: Record<string, unknown> = { ...body };
    for (const key of OMITTABLE_ON_PUT) {
      if (body[key] === undefined) {
        filled[key] = (currentValue as unknown as Record<string, unknown>)[key];
      }
    }

    // Validate against schema. This still strips unknown keys out of the
    // REQUEST, and is meant to: the body is the untrusted half.
    const validated = systemSettingsSchema.parse(filled);

    // Read-then-write, unguarded, exactly as PATCH has always been: two
    // simultaneous PUTs can still race, and the loser's changes lose as they
    // always did. The race window is not widened for the preserved
    // keys in any way that matters, because both racers read the same
    // untouched unknown keys and write them back identically.
    const { value, preservedPaths } = this.mergePreservingUnknown(
      current?.value,
      validated,
    );

    const settings = await this.prisma.systemSettings.upsert({
      where: { key: SETTINGS_KEY },
      update: {
        value: value as any,
        updatedByUserId: userId,
        version: { increment: 1 },
      },
      create: {
        key: SETTINGS_KEY,
        value: value as any,
        updatedByUserId: userId,
      },
      include: {
        updatedByUser: {
          select: { id: true, email: true },
        },
      },
    });

    // Create audit event
    await this.createAuditEvent(userId, 'system_settings:replace', settings.id, {
      newValue: value,
      ...(preservedPaths.length > 0 ? { preservedKeys: preservedPaths } : {}),
    });

    this.reportPreserved('replace', preservedPaths);
    this.logger.log(`System settings replaced by user: ${userId}`);

    return this.toResponse(settings);
  }

  /**
   * Partial update system settings (PATCH)
   */
  async patchSettings(
    dto: PatchSystemSettingsDto,
    userId: string,
    expectedVersion?: number,
  ) {
    // Get the current ROW, not the projection: the merge below needs the raw
    // stored value to carry unknown keys forward (#130).
    const row = await this.loadOrCreateRow();

    // Normalise ONCE, through the guarded accessor, before anything is
    // dereferenced. This line used to be `row.value as unknown as
    // SystemSettingsValue` — a cast, not a check — and the hand-built `merged`
    // below then read nested fields straight off it, so a `null` (or string, or array) row threw a TypeError
    // before `mergePreservingUnknown`'s guards could run. PATCH is now exactly
    // as tolerant as PUT already was: unusable stored fields become defaults,
    // the caller's changes land on top, and the row becomes repairable through
    // the API rather than by hand-editing JSONB in production (#130).
    //
    // Note this is a PROJECTION for the merge only. The write below still
    // passes `row.value` — the raw stored value — to `mergePreservingUnknown`,
    // so unknown keys are recovered from the original, not from this narrowed
    // copy.
    const currentValue = this.readKnownSettings(row.value);

    // Optimistic concurrency check. Unchanged, and still reads its version
    // from the same row the merge is built from — so the version that was
    // checked and the value that is merged can never come from two different
    // reads.
    if (expectedVersion !== undefined && row.version !== expectedVersion) {
      throw new ConflictException(
        `Settings version mismatch. Expected ${expectedVersion}, found ${row.version}`,
      );
    }

    // Deep merge with existing settings, namespace by namespace.
    const merged: SystemSettingsValue = {
      // Field by field, NOT by spread — and `disabledEvents` is therefore REPLACED wholesale when the caller sends
      // one. That is RFC 7396's rule for arrays and the only usable semantics
      // here: a merged list could only ever grow, so the admin page's "stop
      // suppressing this event" would have no way to say so.
      notifications: {
        browserEnabled:
          dto.notifications?.browserEnabled ??
          currentValue.notifications.browserEnabled,
        disabledEvents:
          dto.notifications?.disabledEvents ??
          currentValue.notifications.disabledEvents,
      },
      // -----------------------------------------------------------------------
      // Operations namespaces (#256, epic #254)
      // -----------------------------------------------------------------------
      //
      // Written out field by field like `notifications`, and NOT with
      // a spread, because there is deliberately no generic deep merge in this
      // service. A generic one would have to guess: whether an array replaces
      // or concatenates (`disabledEvents` above settles that it replaces), and
      // whether an explicit `null` means "clear this" or "no opinion" — and
      // `maintenance.startedAt` needs those to be different answers, which is
      // why the two nullable fields test `!== undefined` instead of using `??`.
      // `??` treats a caller's `null` as absent, so clearing the window's
      // provenance would silently be a no-op.
      //
      // Verbose on purpose: this is the sixth of the six places a namespace
      // must be declared, and it is the one no schema can check for you.
      jobs: {
        history: {
          retentionDays:
            dto.jobs?.history?.retentionDays ??
            currentValue.jobs.history.retentionDays,
          purgeEnabled:
            dto.jobs?.history?.purgeEnabled ??
            currentValue.jobs.history.purgeEnabled,
        },
        stuckThresholdMinutes:
          dto.jobs?.stuckThresholdMinutes ??
          currentValue.jobs.stuckThresholdMinutes,
      },
      nodes: {
        staleHeartbeatSeconds:
          dto.nodes?.staleHeartbeatSeconds ??
          currentValue.nodes.staleHeartbeatSeconds,
        offlineStaleMultiplier:
          dto.nodes?.offlineStaleMultiplier ??
          currentValue.nodes.offlineStaleMultiplier,
        offlineRetentionDays:
          dto.nodes?.offlineRetentionDays ??
          currentValue.nodes.offlineRetentionDays,
        jobSecretBrokerEnabled:
          dto.nodes?.jobSecretBrokerEnabled ??
          currentValue.nodes.jobSecretBrokerEnabled,
      },
      databaseBackup: {
        enabled: dto.databaseBackup?.enabled ?? currentValue.databaseBackup.enabled,
        frequency:
          dto.databaseBackup?.frequency ?? currentValue.databaseBackup.frequency,
        dayOfWeek:
          dto.databaseBackup?.dayOfWeek ?? currentValue.databaseBackup.dayOfWeek,
        dayOfMonth:
          dto.databaseBackup?.dayOfMonth ?? currentValue.databaseBackup.dayOfMonth,
        timeOfDay:
          dto.databaseBackup?.timeOfDay ?? currentValue.databaseBackup.timeOfDay,
        timezone:
          dto.databaseBackup?.timezone ?? currentValue.databaseBackup.timezone,
        retentionCount:
          dto.databaseBackup?.retentionCount ??
          currentValue.databaseBackup.retentionCount,
        storageProvider:
          dto.databaseBackup?.storageProvider ??
          currentValue.databaseBackup.storageProvider,
        runStaleMinutes:
          dto.databaseBackup?.runStaleMinutes ??
          currentValue.databaseBackup.runStaleMinutes,
        compressionLevel:
          dto.databaseBackup?.compressionLevel ??
          currentValue.databaseBackup.compressionLevel,
        restoreRollbackMode:
          dto.databaseBackup?.restoreRollbackMode ??
          currentValue.databaseBackup.restoreRollbackMode,
        oldDatabaseRetentionHours:
          dto.databaseBackup?.oldDatabaseRetentionHours ??
          currentValue.databaseBackup.oldDatabaseRetentionHours,
        nodeOffloadEnabled:
          dto.databaseBackup?.nodeOffloadEnabled ??
          currentValue.databaseBackup.nodeOffloadEnabled,
      },
      maintenance: {
        enabled: dto.maintenance?.enabled ?? currentValue.maintenance.enabled,
        message: dto.maintenance?.message ?? currentValue.maintenance.message,
        allowAdmins:
          dto.maintenance?.allowAdmins ?? currentValue.maintenance.allowAdmins,
        // `!== undefined`, never `??` — an explicit `null` is a value here.
        startedAt:
          dto.maintenance?.startedAt !== undefined
            ? dto.maintenance.startedAt
            : currentValue.maintenance.startedAt,
        startedById:
          dto.maintenance?.startedById !== undefined
            ? dto.maintenance.startedById
            : currentValue.maintenance.startedById,
      },
    };

    // Validate merged result (still strict about the shape of what we know).
    const validated = systemSettingsSchema.parse(merged);

    // ...then restore what `parse` and the hand-built `merged` above both drop.
    // On a PATCH this is not a nicety: the caller asked to change one flag, so
    // anything else disappearing is unambiguously a defect regardless of what
    // one thinks PUT ought to mean.
    const { value, preservedPaths } = this.mergePreservingUnknown(
      row.value,
      validated,
    );

    const settings = await this.prisma.systemSettings.update({
      where: { key: SETTINGS_KEY },
      data: {
        value: value as any,
        updatedByUserId: userId,
        version: { increment: 1 },
      },
      include: {
        updatedByUser: {
          select: { id: true, email: true },
        },
      },
    });

    // Create audit event
    await this.createAuditEvent(userId, 'system_settings:patch', settings.id, {
      changes: dto,
      resultingValue: value,
      ...(preservedPaths.length > 0 ? { preservedKeys: preservedPaths } : {}),
    });

    this.reportPreserved('patch', preservedPaths);
    this.logger.log(`System settings patched by user: ${userId}`);

    return this.toResponse(settings);
  }

  /**
   * Create audit event
   */
  private async createAuditEvent(
    actorUserId: string,
    action: string,
    targetId: string,
    meta: Record<string, unknown>,
  ) {
    await this.prisma.auditEvent.create({
      data: {
        actorUserId,
        action,
        targetType: 'system_settings',
        targetId,
        meta: meta as any,
      },
    });
  }
}
