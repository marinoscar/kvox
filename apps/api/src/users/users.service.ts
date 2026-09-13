import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { UserListQueryDto } from './dto/user-list-query.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { UpdateUserRolesDto } from './dto/update-user-roles.dto';
import { ROLES } from '../common/constants/roles.constants';
import { NotificationsService } from '../notifications/notifications.service';
import type { RoleChangedEmailData } from '../email';
import { resolveProfileImageUrl } from '../common/profile-image/profile-image';

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly config: ConfigService,
  ) {}

  /**
   * List users with pagination and filtering
   */
  async listUsers(query: UserListQueryDto) {
    const { page, pageSize, search, role, isActive, sortBy, sortOrder } = query;
    const skip = (page - 1) * pageSize;

    // Build where clause
    const where: any = {};

    if (search) {
      where.OR = [
        { email: { contains: search, mode: 'insensitive' } },
        { displayName: { contains: search, mode: 'insensitive' } },
        { providerDisplayName: { contains: search, mode: 'insensitive' } },
      ];
    }

    if (role) {
      where.userRoles = {
        some: {
          role: { name: role },
        },
      };
    }

    if (isActive !== undefined) {
      where.isActive = isActive;
    }

    // Execute query
    const [items, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        skip,
        take: pageSize,
        orderBy: { [sortBy]: sortOrder },
        include: {
          userRoles: {
            include: { role: true },
          },
          // Same query, no N+1: needed to resolve `profileImageUrl` (#367).
          userSettings: {
            select: { value: true },
          },
        },
      }),
      this.prisma.user.count({ where }),
    ]);

    // Transform to response format
    const transformedItems = items.map((user) => ({
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      providerDisplayName: user.providerDisplayName,
      profileImageUrl: this.resolveImage(user),
      providerProfileImageUrl: user.providerProfileImageUrl,
      isActive: user.isActive,
      roles: user.userRoles.map((ur) => ur.role.name),
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    }));

    return {
      items: transformedItems,
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    };
  }

  /**
   * Get user by ID
   */
  async getUserById(id: string) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      include: {
        userRoles: {
          include: { role: true },
        },
        identities: {
          select: {
            provider: true,
            providerEmail: true,
            createdAt: true,
          },
        },
        userSettings: {
          select: { value: true },
        },
      },
    });

    if (!user) {
      throw new NotFoundException(`User with ID ${id} not found`);
    }

    return {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      providerDisplayName: user.providerDisplayName,
      profileImageUrl: this.resolveImage(user),
      providerProfileImageUrl: user.providerProfileImageUrl,
      isActive: user.isActive,
      roles: user.userRoles.map((ur) => ur.role.name),
      identities: user.identities,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    };
  }

  /**
   * Update user (admin actions)
   */
  async updateUser(
    id: string,
    dto: UpdateUserDto,
    adminUserId: string,
  ) {
    // Prevent admin from deactivating themselves
    if (dto.isActive === false && id === adminUserId) {
      throw new ForbiddenException('Cannot deactivate your own account');
    }

    const user = await this.prisma.user.findUnique({ where: { id } });

    if (!user) {
      throw new NotFoundException(`User with ID ${id} not found`);
    }

    const updated = await this.prisma.user.update({
      where: { id },
      data: {
        displayName: dto.displayName,
        isActive: dto.isActive,
      },
      include: {
        userRoles: {
          include: { role: true },
        },
        userSettings: {
          select: { value: true },
        },
      },
    });

    // Log audit event
    await this.createAuditEvent(adminUserId, 'user:update', 'user', id, {
      changes: dto,
    });

    this.logger.log(`User ${id} updated by admin ${adminUserId}`);

    return {
      id: updated.id,
      email: updated.email,
      displayName: updated.displayName,
      providerDisplayName: updated.providerDisplayName,
      profileImageUrl: this.resolveImage(updated),
      providerProfileImageUrl: updated.providerProfileImageUrl,
      isActive: updated.isActive,
      roles: updated.userRoles.map((ur) => ur.role.name),
      createdAt: updated.createdAt,
      updatedAt: updated.updatedAt,
    };
  }

  /**
   * Update user roles
   */
  async updateUserRoles(
    id: string,
    dto: UpdateUserRolesDto,
    adminUserId: string,
  ) {
    // Prevent admin from removing their own admin role
    if (id === adminUserId && !dto.roleNames.includes(ROLES.ADMIN)) {
      throw new ForbiddenException('Cannot remove admin role from yourself');
    }

    // The roles held BEFORE the change are read here, in the lookup that was
    // already happening, because they are gone the moment the transaction
    // below runs — `deleteMany` then `createMany` replaces the set wholesale.
    // `security.role_changed` reports a DELTA (see role-changed.email.ts: "you
    // are now a Viewer" cannot tell the reader whether they gained access or
    // lost it), so the before-state has to be captured on this side of it.
    const user = await this.prisma.user.findUnique({
      where: { id },
      include: {
        userRoles: {
          include: { role: true },
        },
      },
    });

    if (!user) {
      throw new NotFoundException(`User with ID ${id} not found`);
    }

    const previousRoles = user.userRoles.map((ur) => ur.role.name);

    // Validate all roles exist
    const roles = await this.prisma.role.findMany({
      where: { name: { in: dto.roleNames } },
    });

    if (roles.length !== dto.roleNames.length) {
      const foundNames = roles.map((r) => r.name);
      const invalid = dto.roleNames.filter((n) => !foundNames.includes(n));
      throw new BadRequestException(`Invalid roles: ${invalid.join(', ')}`);
    }

    // Replace all roles in a transaction
    await this.prisma.$transaction(async (tx) => {
      // Remove existing roles
      await tx.userRole.deleteMany({ where: { userId: id } });

      // Add new roles
      await tx.userRole.createMany({
        data: roles.map((role) => ({
          userId: id,
          roleId: role.id,
        })),
      });
    });

    // Log audit event
    await this.createAuditEvent(adminUserId, 'user:roles_update', 'user', id, {
      newRoles: dto.roleNames,
    });

    this.logger.log(
      `User ${id} roles updated to [${dto.roleNames.join(', ')}] by admin ${adminUserId}`,
    );

    // -------------------------------------------------------------------------
    // Trigger: `security.role_changed` (#128, epic #109)
    // -------------------------------------------------------------------------
    //
    // AFTER THE TRANSACTION, NOT INSIDE IT. Two independent reasons, and the
    // first is the property the whole epic exists to prove:
    //
    //   1. A send failure MUST NOT roll back the role change. `notify` is
    //      detached — it schedules the dispatch on a later microtask and
    //      returns before anything is rendered or sent — so the dispatch does
    //      not run inside the `$transaction` above (which has already
    //      committed), does not share a Prisma transaction client with it, and
    //      cannot fail it. It also never rejects: every failure below it
    //      becomes a `notification_deliveries` row with an `error`, never an
    //      exception reaching here.
    //
    //   2. It must not delay this request. `notify` returns immediately; the
    //      admin's PATCH does not wait on a mail server. Awaiting it is still
    //      correct and cheap — it means "scheduled", not "delivered" — and it
    //      is awaited here only so a `no-floating-promises` rule has nothing to
    //      complain about.
    //
    // MANDATORY EVENT: `security.role_changed` is `mandatory: true` in the
    // registry, so the recipient's stored preferences are ignored by
    // `resolveChannels` and both declared channels (email and the in-app bell)
    // are always attempted. A privilege change nobody can see is the failure
    // this event exists to prevent.
    //
    // NO SELF-SUPPRESSION. An admin who changes their OWN roles still gets the
    // notification. Suppressing it would be a rule with no security value —
    // the alerting case is precisely the one where the actor and the account
    // owner are believed to be the same person and are not.
    const payload: RoleChangedEmailData = {
      recipientEmail: user.email,
      previousRoles,
      currentRoles: dto.roleNames,
      changedAt: new Date(),
      appUrl: this.appUrl(),
    };

    // The ACTOR IS NOT IN THE PAYLOAD, deliberately — see the long note in
    // role-changed.email.ts. `audit_events` above records who made the change,
    // which is the controlled place for it.
    await this.notifications.notify('security.role_changed', id, payload);

    return this.getUserById(id);
  }

  /**
   * The picture representing a user, per their `profile.imageSource` (#367).
   * `users.profile_image_url` is deliberately not consulted — nothing writes it.
   */
  private resolveImage(user: {
    id: string;
    providerProfileImageUrl: string | null;
    userSettings?: { value: unknown } | null;
  }): string | null {
    const storedProfile = (
      user.userSettings?.value as { profile?: unknown } | null | undefined
    )?.profile;
    return resolveProfileImageUrl(user, storedProfile);
  }

  /**
   * Absolute URL of the application root, for a notification's CTA.
   *
   * Built here rather than in the template, which is a pure function of its
   * input and has no business reading configuration. `undefined` when
   * `APP_URL` is unset: the layout then omits the button rather than rendering
   * one that goes nowhere.
   */
  private appUrl(): string | undefined {
    const appUrl = this.config.get<string>('appUrl');
    return appUrl ? appUrl.replace(/\/+$/, '') : undefined;
  }

  /**
   * Create audit event
   */
  private async createAuditEvent(
    actorUserId: string,
    action: string,
    targetType: string,
    targetId: string,
    meta: Record<string, unknown>,
  ) {
    await this.prisma.auditEvent.create({
      data: {
        actorUserId,
        action,
        targetType,
        targetId,
        meta: meta as any,
      },
    });
  }
}
