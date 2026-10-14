import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../../prisma/prisma.service';
import { UpdateUserSettingsDto } from '../dto/update-user-settings.dto';
import { PatchUserSettingsDto } from '../dto/update-user-settings.dto';
import {
  DEFAULT_USER_SETTINGS,
  UserSettingsValue,
} from '../../common/types/settings.types';
import { userSettingsSchema } from '../../common/schemas/settings.schema';
import {
  userSettingsNamespaceRegistry,
  type UserSettingsNamespaces,
} from '../registry';
import {
  USER_SETTINGS_NAMESPACE_CHANGED_EVENT,
  type UserSettingsNamespaceChangedEvent,
} from './user-settings.events';
import {
  isAvatarObjectFor,
  normalizeProfileSettings,
  type NormalizedProfileSettings,
} from '../../common/profile-image/profile-image';

@Injectable()
export class UserSettingsService {
  private readonly logger = new Logger(UserSettingsService.name);

  constructor(
    private readonly prisma: PrismaService,
    // Announces `user-settings.namespace-changed` (#459). Global via
    // `EventEmitterModule.forRoot()` in AppModule.
    private readonly events: EventEmitter2,
  ) {}

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
      // Every registered namespace the user has stored something for, in
      // registration order. Absent stays absent: an absent `onboarding` is how a
      // client knows this user has never been onboarded (#272) — emitting `{}`
      // would say the opposite of nothing — and an absent `graph` means every
      // default (#369), which the client resolves itself.
      ...this.storedNamespaces(value),
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
    // about. A namespace missing from `userSettingsSchema` is accepted by the
    // controller, dropped here, and never seen again by a subsequent GET — with
    // no error anywhere. `userSettingsSchema` is composed from the user
    // settings namespace registry, so a namespace is known here as soon as its
    // declaration is registered in `kvox.manifest.ts`.
    const validated = userSettingsSchema.parse(dto);

    // Caps enforced here rather than in zod — see assertNamespaceLimits.
    this.assertNamespaceLimits(validated);

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

    this.emitNamespaceChanges(
      userId,
      stored?.value as unknown as UserSettingsValue | undefined,
      validated,
    );

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

    // Optional namespaces: each registered namespace merges its own patch, and
    // the key is only set when the merge produced something, so an emptied
    // namespace collapses back to absent instead of being stored as `{}`
    // (absent means "use built-in defaults", `{}` would not).
    const currentNamespaces = current as unknown as Record<string, unknown>;
    const patchNamespaces = dto as unknown as Record<string, unknown>;
    const mergedNamespaces = merged as unknown as Record<string, unknown>;
    for (const ns of userSettingsNamespaceRegistry.list()) {
      const mergedNamespace = ns.merge(
        currentNamespaces[ns.key],
        patchNamespaces[ns.key],
      );
      if (mergedNamespace !== undefined) {
        mergedNamespaces[ns.key] = mergedNamespace;
      }
    }

    // Enforce the caps AFTER the merge — see assertNamespaceLimits.
    this.assertNamespaceLimits(merged);

    // Validate merged result.
    //
    // WARNING: as in replaceSettings, this call silently strips unknown keys.
    // A namespace that is not registered disappears right here and never
    // round-trips through GET. See the note in replaceSettings.
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

    this.emitNamespaceChanges(userId, current as unknown as UserSettingsValue, validated);

    this.logger.log(`Settings patched for user: ${userId}`);

    const value = settings.value as unknown as UserSettingsValue;

    return this.toResponse(value, settings.updatedAt, settings.version);
  }

  /**
   * The registered namespaces a stored value actually carries. Absent keys are
   * left out, never set to `undefined`.
   */
  private storedNamespaces(
    value: UserSettingsValue,
  ): Partial<UserSettingsNamespaces> {
    const stored = value as unknown as Record<string, unknown>;
    const present: Record<string, unknown> = {};
    for (const ns of userSettingsNamespaceRegistry.list()) {
      if (stored[ns.key] !== undefined) {
        present[ns.key] = stored[ns.key];
      }
    }
    return present as Partial<UserSettingsNamespaces>;
  }

  /**
   * Run every registered namespace's `assertLimits` against the value about to
   * be stored (on PUT) or the MERGED value (on PATCH).
   *
   * These caps cannot be expressed in zod (`z.record()` has no key-count
   * refinement) and have to be checked against the merged result rather than the
   * request body: a 3-entry patch on top of 39 stored entries is over the cap
   * while the body alone is not. Doing that inside the post-merge
   * `userSettingsSchema.parse()` would surface it as a raw `ZodError` thrown
   * from the service, which escapes as a 500, not the 400 the client deserves,
   * hence the namespace throws a `BadRequestException` itself.
   */
  private assertNamespaceLimits(value: UserSettingsValue): void {
    const stored = value as unknown as Record<string, unknown>;
    for (const ns of userSettingsNamespaceRegistry.list()) {
      ns.assertLimits?.(stored[ns.key]);
    }
  }

  /**
   * Announce, once per registered namespace whose stored value CHANGED, that it
   * did (`user-settings.namespace-changed`). Compared on `JSON.stringify` of the
   * before and after values, so a namespace absent on both sides is not a
   * change. A listener decides for itself whether the change matters to it (the
   * graph module's forwarder compares the EFFECTIVE preferences before it emits
   * anything).
   *
   * Wrapped in try/catch because `EventEmitter2` dispatches synchronously: a
   * throwing listener must never turn a committed settings write into an error
   * response (the same guard `JobTerminalService.emitSettled` uses).
   */
  private emitNamespaceChanges(
    userId: string,
    previous: UserSettingsValue | undefined,
    next: UserSettingsValue,
  ): void {
    const before = (previous ?? {}) as unknown as Record<string, unknown>;
    const after = next as unknown as Record<string, unknown>;

    for (const ns of userSettingsNamespaceRegistry.list()) {
      if (JSON.stringify(before[ns.key]) === JSON.stringify(after[ns.key])) {
        continue;
      }

      const event: UserSettingsNamespaceChangedEvent = {
        userId,
        key: ns.key,
        previous: before[ns.key],
        next: after[ns.key],
      };
      try {
        this.events.emit(USER_SETTINGS_NAMESPACE_CHANGED_EVENT, event);
      } catch (error) {
        this.logger.error(
          `A ${USER_SETTINGS_NAMESPACE_CHANGED_EVENT} listener threw for user ${userId} ` +
            `(namespace "${ns.key}"); the settings write is unaffected: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      }
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

