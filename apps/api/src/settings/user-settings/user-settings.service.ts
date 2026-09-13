import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { UpdateUserSettingsDto } from '../dto/update-user-settings.dto';
import { PatchUserSettingsDto } from '../dto/update-user-settings.dto';
import {
  DEFAULT_USER_SETTINGS,
  UserSettingsValue,
} from '../../common/types/settings.types';
import { userSettingsSchema } from '../../common/schemas/settings.schema';
import {
  DATA_TABLE_MAX_TABLES,
  DataTablesPatchValue,
  DataTablesValue,
  NavigationPatchValue,
  NavigationValue,
  NOTIFICATION_MAX_EVENTS_PER_CHANNEL,
  NotificationChannelPreferencesValue,
  NotificationsPatchValue,
  NotificationsValue,
} from '../../common/schemas/user-settings-namespaces.schema';
import type { NotificationChannel } from '../../notifications/notification-events';
import {
  isAvatarObjectFor,
  normalizeProfileSettings,
  type NormalizedProfileSettings,
} from '../../common/profile-image/profile-image';

@Injectable()
export class UserSettingsService {
  private readonly logger = new Logger(UserSettingsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Build the API response projection for a stored settings value.
   *
   * Optional namespaces are emitted ONLY when present — we never put
   * `dataTables: undefined` in the body, because an absent namespace is the
   * signal to the client that it should apply its own built-in defaults.
   */
  private toResponse(
    value: UserSettingsValue,
    updatedAt: Date,
    version: number,
  ) {
    return {
      theme: value.theme,
      // Normalised on every read: rows written before #367 carry the legacy
      // `useProviderImage` flag instead of `imageSource`.
      profile: normalizeProfileSettings(value.profile),
      ...(value.dataTables !== undefined
        ? { dataTables: value.dataTables }
        : {}),
      ...(value.navigation !== undefined
        ? { navigation: value.navigation }
        : {}),
      ...(value.notifications !== undefined
        ? { notifications: value.notifications }
        : {}),
      updatedAt,
      version,
    };
  }

  /**
   * Get user settings for current user
   * Creates default settings if none exist
   */
  async getSettings(userId: string) {
    let settings = await this.prisma.userSettings.findUnique({
      where: { userId },
    });

    // Create default settings if not found
    if (!settings) {
      settings = await this.prisma.userSettings.create({
        data: {
          userId,
          value: DEFAULT_USER_SETTINGS as any,
        },
      });
      this.logger.log(`Created default settings for user: ${userId}`);
    }

    const value = settings.value as unknown as UserSettingsValue;

    return this.toResponse(value, settings.updatedAt, settings.version);
  }

  /**
   * Replace user settings (PUT)
   */
  async replaceSettings(userId: string, dto: UpdateUserSettingsDto) {
    // Validate against schema.
    //
    // WARNING: this line silently STRIPS any key the schema does not know
    // about. It is exactly the line that made adding `dataTables` /
    // `navigation` a six-file change: a namespace missing from
    // `userSettingsSchema` is accepted by the controller, dropped here, and
    // never seen again by a subsequent GET — with no error anywhere. If you
    // are adding a new namespace, add it to
    // common/schemas/user-settings-namespaces.schema.ts and wire it into
    // `userSettingsSchema` before anything else.
    const validated = userSettingsSchema.parse(dto);

    // Caps enforced here rather than in zod — see assertDataTableLimit.
    this.assertDataTableLimit(validated.dataTables);
    this.assertNotificationLimit(validated.notifications);

    // Profile image (#367). An omitted `imageObjectId` keeps the stored one
    // rather than silently orphaning an uploaded avatar; `null` clears it.
    const stored = await this.prisma.userSettings.findUnique({
      where: { userId },
    });
    const previousProfile = normalizeProfileSettings(
      (stored?.value as unknown as UserSettingsValue | undefined)?.profile,
    );
    const nextProfile: NormalizedProfileSettings = {
      ...validated.profile,
      imageObjectId:
        validated.profile.imageObjectId !== undefined
          ? validated.profile.imageObjectId
          : previousProfile.imageObjectId,
    };
    await this.assertProfileImageReference(userId, previousProfile, nextProfile);
    validated.profile = nextProfile;

    const settings = await this.prisma.userSettings.upsert({
      where: { userId },
      update: {
        value: validated as any,
        version: { increment: 1 },
      },
      create: {
        userId,
        value: validated as any,
      },
    });

    // Sync display name to user table if provided
    if (validated.profile.displayName !== undefined) {
      await this.syncDisplayName(userId, validated.profile.displayName);
    }

    this.logger.log(`Settings replaced for user: ${userId}`);

    const value = settings.value as unknown as UserSettingsValue;

    return this.toResponse(value, settings.updatedAt, settings.version);
  }

  /**
   * Partial update user settings (PATCH)
   * Uses JSON Merge Patch semantics
   */
  async patchSettings(
    userId: string,
    dto: PatchUserSettingsDto,
    expectedVersion?: number,
  ) {
    // Get current settings
    const current = await this.getSettings(userId);

    // Optimistic concurrency check
    if (expectedVersion !== undefined && current.version !== expectedVersion) {
      throw new ConflictException(
        `Settings version mismatch. Expected ${expectedVersion}, found ${current.version}`,
      );
    }

    // Merge with existing settings
    const merged: UserSettingsValue = {
      theme: dto.theme ?? current.theme,
      profile: {
        displayName:
          dto.profile?.displayName !== undefined
            ? dto.profile.displayName
            : current.profile.displayName,
        imageSource:
          dto.profile?.imageSource !== undefined
            ? dto.profile.imageSource
            : current.profile.imageSource,
        // `!== undefined`, never `??`: an explicit `null` clears the reference.
        imageObjectId:
          dto.profile?.imageObjectId !== undefined
            ? dto.profile.imageObjectId
            : current.profile.imageObjectId,
      },
    };

    // `current.profile` is already normalised (getSettings -> toResponse).
    await this.assertProfileImageReference(
      userId,
      current.profile,
      merged.profile as NormalizedProfileSettings,
    );

    // Optional namespaces: only set the key when the merge produced something,
    // so an emptied namespace collapses back to absent instead of being stored
    // as `{}` (absent means "use built-in defaults", `{}` would not).
    const mergedDataTables = this.mergeDataTables(
      current.dataTables,
      dto.dataTables,
    );
    if (mergedDataTables !== undefined) {
      merged.dataTables = mergedDataTables;
    }

    const mergedNavigation = this.mergeNavigation(
      current.navigation,
      dto.navigation,
    );
    if (mergedNavigation !== undefined) {
      merged.navigation = mergedNavigation;
    }

    const mergedNotifications = this.mergeNotifications(
      current.notifications,
      dto.notifications,
    );
    if (mergedNotifications !== undefined) {
      merged.notifications = mergedNotifications;
    }

    // Enforce the caps AFTER the merge — see assertDataTableLimit.
    this.assertDataTableLimit(merged.dataTables);
    this.assertNotificationLimit(merged.notifications);

    // Validate merged result.
    //
    // WARNING: as in replaceSettings, this call silently strips unknown keys.
    // A namespace that is not part of `userSettingsSchema` disappears right
    // here and never round-trips through GET. See the note in replaceSettings.
    const validated = userSettingsSchema.parse(merged);

    const settings = await this.prisma.userSettings.update({
      where: { userId },
      data: {
        value: validated as any,
        version: { increment: 1 },
      },
    });

    // Sync display name to user table if changed
    if (dto.profile?.displayName !== undefined) {
      await this.syncDisplayName(userId, dto.profile.displayName);
    }

    this.logger.log(`Settings patched for user: ${userId}`);

    const value = settings.value as unknown as UserSettingsValue;

    return this.toResponse(value, settings.updatedAt, settings.version);
  }

  /**
   * Merge the `dataTables` namespace using JSON Merge Patch semantics,
   * PER TABLE ID.
   *
   * - patch absent            -> keep the stored namespace untouched
   * - patch is `null`         -> clear the whole namespace
   * - `{ jobs: null }`        -> delete the `jobs` entry, leave others alone
   * - `{ jobs: { pageSize } }`-> REPLACE the `jobs` entry wholesale. This is
   *   deliberately not a deep merge: a table's preferences are a single
   *   coherent view state, and a client that sends a partial entry is stating
   *   the entry it wants, so any previously stored `density` for `jobs` is
   *   discarded. Entries for other tables are never affected.
   *
   * An empty result collapses to `undefined` so the namespace disappears from
   * storage rather than persisting as `{}`.
   */
  private mergeDataTables(
    current: DataTablesValue | undefined,
    patch: DataTablesPatchValue | null | undefined,
  ): DataTablesValue | undefined {
    if (patch === undefined) {
      return current;
    }

    if (patch === null) {
      return undefined;
    }

    const merged: DataTablesValue = { ...(current ?? {}) };

    for (const [tableId, entry] of Object.entries(patch)) {
      if (entry === null) {
        delete merged[tableId];
      } else if (entry !== undefined) {
        merged[tableId] = entry;
      }
    }

    return Object.keys(merged).length > 0 ? merged : undefined;
  }

  /**
   * Merge the `navigation` namespace field-wise.
   *
   * - patch absent           -> keep the stored namespace untouched
   * - patch is `null`        -> clear the whole namespace
   * - field omitted          -> stored value untouched
   * - field set to a value   -> replaces the stored value
   * - field set to `null`    -> deletes the field, so the client falls back to
   *   its built-in default rather than to a hard-coded stored one
   *
   * As with dataTables, an empty result collapses to `undefined`.
   */
  private mergeNavigation(
    current: NavigationValue | undefined,
    patch: NavigationPatchValue | null | undefined,
  ): NavigationValue | undefined {
    if (patch === undefined) {
      return current;
    }

    if (patch === null) {
      return undefined;
    }

    const merged: NavigationValue = { ...(current ?? {}) };

    if (patch.railCollapsed === null) {
      delete merged.railCollapsed;
    } else if (patch.railCollapsed !== undefined) {
      merged.railCollapsed = patch.railCollapsed;
    }

    return Object.keys(merged).length > 0 ? merged : undefined;
  }

  /**
   * Merge the `notifications` namespace (#126, epic #109) using JSON Merge
   * Patch semantics, PER CHANNEL and then PER EVENT KEY.
   *
   * - patch absent                       -> keep the stored namespace untouched
   * - patch is `null`                    -> clear the whole namespace
   * - `{ email: null }`                  -> clear the `email` channel, leaving
   *   any `browser` preferences alone
   * - `{ email: { 'user.welcome': null } }` -> DELETE that one event key, so
   *   the event falls back to the registry's `defaultEnabled`. This is the
   *   operation the preferences page sends when a control returns to its
   *   default; storing the default value instead would pin that user to
   *   today's default forever and re-materialise the key the sparse contract
   *   exists to keep absent.
   * - `{ email: { 'user.welcome': false } }` -> set that one key, touching
   *   nothing else on the channel.
   *
   * WHY THIS DEEP-MERGES WHERE mergeDataTables REPLACES. A data table entry is
   * one coherent view state, so a client sending it is stating the whole
   * entry. A channel's preferences are the opposite: a row of INDEPENDENT
   * per-event choices, and #126 PATCHes exactly the one key the user just
   * toggled. Replacing the channel wholesale would therefore erase every other
   * preference on that channel on every single toggle — silently re-enabling
   * mail the user had already turned off, which is the loudest possible
   * regression for a notifications feature.
   *
   * COLLAPSING IS LOAD-BEARING AT BOTH LEVELS. A channel whose last key was
   * deleted is removed rather than stored as `{}`, and an empty namespace
   * returns `undefined` so the caller omits the key entirely. Absent means
   * "use the built-in defaults"; `{}` is a second spelling of the same state
   * that the read path does not produce (`readNotificationPreferences` drops
   * empty maps too), and two spellings of one state is how the UI and the
   * dispatcher end up disagreeing about whether a user has an opinion.
   *
   * DELIBERATELY NO `mandatory` CHECK HERE. A stored `false` for a mandatory
   * event is accepted and is inert: `isChannelEnabled` (#125) tests
   * `event.mandatory` before it ever looks at stored preferences, so the value
   * is never consulted. That resolver is the single security gate on purpose —
   * it also covers rows written before an event became mandatory, and requests
   * that never went near the UI. A second gate here could only disagree with
   * the one that actually decides delivery.
   *
   * Event keys are NOT validated against the registry — see the header of
   * user-settings-namespaces.schema.ts for the three ways that breaks.
   */
  private mergeNotifications(
    current: NotificationsValue | undefined,
    patch: NotificationsPatchValue | null | undefined,
  ): NotificationsValue | undefined {
    if (patch === undefined) {
      return current;
    }

    if (patch === null) {
      return undefined;
    }

    const merged: NotificationsValue = {};

    // Copy the stored namespace one level deep. A shallow `{ ...current }`
    // would share the per-channel objects with the value we just read, and the
    // `delete` below would then mutate them in place.
    for (const [channel, events] of Object.entries(current ?? {})) {
      if (events !== undefined) {
        merged[channel as NotificationChannel] = { ...events };
      }
    }

    for (const [channel, channelPatch] of Object.entries(patch)) {
      const key = channel as NotificationChannel;

      if (channelPatch === null) {
        delete merged[key];
        continue;
      }

      if (channelPatch === undefined) {
        continue;
      }

      const events: NotificationChannelPreferencesValue = {
        ...(merged[key] ?? {}),
      };

      for (const [eventKey, choice] of Object.entries(channelPatch)) {
        if (choice === null) {
          delete events[eventKey];
        } else if (choice !== undefined) {
          events[eventKey] = choice;
        }
      }

      if (Object.keys(events).length > 0) {
        merged[key] = events;
      } else {
        // Last key deleted: the channel goes away rather than persisting as
        // `{}`. See "COLLAPSING IS LOAD-BEARING" above.
        delete merged[key];
      }
    }

    return Object.keys(merged).length > 0 ? merged : undefined;
  }

  /**
   * Enforce the per-user cap on persisted notification preferences.
   *
   * The event level is an OPEN map — event keys are registry data and are
   * deliberately not validated against the registry (see
   * user-settings-namespaces.schema.ts) — so without a cap an authenticated
   * user can inflate their own `user_settings` row without limit by PATCHing
   * arbitrary keys. The channel level is closed by the enum, so bounding the
   * entries per channel bounds the namespace.
   *
   * Enforced here, not in zod, for the same two reasons as
   * assertDataTableLimit: `z.record()` has no key-count refinement, and the
   * cap has to be checked against the MERGED result rather than the request
   * body. A ZodError thrown from the service would escape as a 500 instead of
   * the 400 the client deserves, hence the explicit BadRequestException.
   */
  private assertNotificationLimit(
    notifications: NotificationsValue | undefined,
  ): void {
    if (!notifications) {
      return;
    }

    for (const [channel, events] of Object.entries(notifications)) {
      const count = Object.keys(events ?? {}).length;
      if (count > NOTIFICATION_MAX_EVENTS_PER_CHANNEL) {
        throw new BadRequestException(
          `Too many notification preferences for channel "${channel}": ${count} exceeds the maximum of ${NOTIFICATION_MAX_EVENTS_PER_CHANNEL}. Remove preferences you no longer need (send them as null) before adding new ones.`,
        );
      }
    }
  }

  /**
   * Enforce the per-user cap on the number of persisted data table entries.
   *
   * This is a storage-exhaustion control (see
   * user-settings-namespaces.schema.ts), and it is enforced HERE rather than in
   * zod for two reasons:
   *
   * 1. `z.record()` cannot express "at most N keys" — there is no key-count
   *    refinement that survives the record type.
   * 2. Even if it could, the cap has to be checked against the MERGED result,
   *    not the request body: a 3-entry patch on top of 39 stored entries is
   *    over the cap while the body alone is not. Doing that check inside the
   *    post-merge `userSettingsSchema.parse()` would surface it as a raw
   *    `ZodError` thrown from the service — which escapes as a 500, not the
   *    400 the client deserves. Hence an explicit BadRequestException.
   */
  private assertDataTableLimit(dataTables: DataTablesValue | undefined): void {
    if (!dataTables) {
      return;
    }

    const count = Object.keys(dataTables).length;
    if (count > DATA_TABLE_MAX_TABLES) {
      throw new BadRequestException(
        `Too many data table preferences: ${count} exceeds the maximum of ${DATA_TABLE_MAX_TABLES}. Remove entries for tables you no longer use (send them as null) before adding new ones.`,
      );
    }
  }

  /**
   * Validate the profile image reference a write would store (#367).
   *
   * - `imageSource: 'upload'` without an `imageObjectId` is always a 400.
   * - When the image fields CHANGE, the resulting `imageObjectId` must name an
   *   avatar the caller uploaded through `POST /api/user-settings/profile-image`
   *   (owned, `avatars/<userId>/` key, `purpose: 'avatar'`, `ready`, validated
   *   image type) whenever it is being newly set or `upload` is being selected.
   *   That is what stops a client pointing its public avatar URL at an
   *   arbitrary object — its own generic uploads included, whose MIME type is
   *   whatever the uploader claimed.
   * - When they are UNCHANGED the check is skipped, so an unrelated write
   *   (a theme toggle) never fails because a stored avatar object was since
   *   removed through the generic storage API.
   * - Switching to `none`/`provider` keeps the stored id without re-checking it.
   *
   * A BadRequestException, not a ZodError, so the client gets a 400.
   */
  private async assertProfileImageReference(
    userId: string,
    previous: NormalizedProfileSettings,
    next: NormalizedProfileSettings,
  ): Promise<void> {
    const nextObjectId = next.imageObjectId ?? null;

    if (next.imageSource === 'upload' && !nextObjectId) {
      throw new BadRequestException(
        'profile.imageSource "upload" requires profile.imageObjectId. Upload a picture with POST /api/user-settings/profile-image first.',
      );
    }

    const changed =
      previous.imageSource !== next.imageSource ||
      previous.imageObjectId !== nextObjectId;
    if (!changed || !nextObjectId) {
      return;
    }

    const needsCheck =
      nextObjectId !== previous.imageObjectId || next.imageSource === 'upload';
    if (!needsCheck) {
      return;
    }

    const object = await this.prisma.storageObject.findUnique({
      where: { id: nextObjectId },
      select: {
        uploadedById: true,
        storageKey: true,
        status: true,
        mimeType: true,
        metadata: true,
      },
    });

    if (!isAvatarObjectFor(object, userId)) {
      throw new BadRequestException(
        'profile.imageObjectId must reference a profile image you uploaded with POST /api/user-settings/profile-image.',
      );
    }
  }

  /**
   * Sync display name from settings to user table
   */
  private async syncDisplayName(
    userId: string,
    displayName: string | undefined,
  ) {
    await this.prisma.user.update({
      where: { id: userId },
      data: { displayName: displayName || null },
    });
  }

  /**
   * Update theme preference
   */
  async updateTheme(userId: string, theme: 'light' | 'dark' | 'system') {
    return this.patchSettings(userId, { theme });
  }
}
