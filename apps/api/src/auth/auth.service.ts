import {
  Injectable,
  Logger,
  UnauthorizedException,
  ForbiddenException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomBytes } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AdminBootstrapService } from '../common/services/admin-bootstrap.service';
import { AllowlistService } from '../allowlist/allowlist.service';
import { DatabaseSeedException } from '../common/exceptions/database-seed.exception';
import { DEFAULT_ROLE } from '../common/constants/roles.constants';
import { DEFAULT_USER_SETTINGS } from '../common/types/settings.types';
import {
  normalizeProfileSettings,
  resolveProfileImageUrl,
} from '../common/profile-image/profile-image';
import { GoogleProfile } from './strategies/google.strategy';
import { JwtPayload } from './strategies/jwt.strategy';
import { AuthenticatedUser } from './interfaces/authenticated-user.interface';
import { TokenResponseDto } from './dto/auth-user.dto';
import { AuthProviderDto } from './dto/auth-provider.dto';
import { NotificationsService } from '../notifications/notifications.service';
import type { UserWelcomeEmailData } from '../email';

export interface FullTokenResponse {
  accessToken: string;
  expiresIn: number;
  refreshToken?: string; // Only returned on initial auth, not refresh
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly adminBootstrapService: AdminBootstrapService,
    private readonly allowlistService: AllowlistService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Handles Google OAuth login
   * Creates or updates user, links identity, checks admin bootstrap
   */
  async handleGoogleLogin(
    profile: GoogleProfile,
  ): Promise<FullTokenResponse> {
    this.logger.log(`Google login attempt for email: ${profile.email}`);

    // Check allowlist before any user lookup/creation
    const email = profile.email.toLowerCase();
    const isAllowed = await this.allowlistService.isEmailAllowed(email);
    const isInitialAdmin = this.isInitialAdminEmail(email);

    if (!isAllowed && !isInitialAdmin) {
      this.logger.warn(`Login denied - email not in allowlist: ${email}`);
      throw new ForbiddenException(
        'Your email is not authorized to access this application. Please contact an administrator.',
      );
    }

    // Check if identity already exists
    let identity = await this.prisma.userIdentity.findUnique({
      where: {
        provider_providerSubject: {
          provider: 'google',
          providerSubject: profile.id,
        },
      },
      include: {
        user: {
          include: {
            userRoles: {
              include: {
                role: {
                  include: {
                    rolePermissions: {
                      include: {
                        permission: true,
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });

    let user = identity?.user || null;

    // Set ONLY on the branch below that actually inserts a user row. This is
    // the fire-once condition for `user.welcome` (#128) — see the trigger at
    // the end of this method for why the notification is raised there and not
    // inside the branch.
    let userWasCreated = false;

    if (!user) {
      // Check if user exists by email (identity linking case)
      const existingUser = await this.prisma.user.findUnique({
        where: { email: profile.email },
        include: {
          userRoles: {
            include: {
              role: {
                include: {
                  rolePermissions: {
                    include: {
                      permission: true,
                    },
                  },
                },
              },
            },
          },
        },
      });

      if (existingUser) {
        // Link new identity to existing user
        this.logger.log(
          `Linking Google identity to existing user: ${existingUser.email}`,
        );
        await this.prisma.userIdentity.create({
          data: {
            userId: existingUser.id,
            provider: 'google',
            providerSubject: profile.id,
            providerEmail: profile.email,
          },
        });
        user = existingUser;
      } else {
        // Create new user with identity
        this.logger.log(`Creating new user: ${profile.email}`);
        user = await this.createNewUser(profile);
        userWasCreated = true;

        // Mark email as claimed in allowlist
        await this.allowlistService.markEmailClaimed(email, user.id);
      }
    }

    // Update provider profile information (don't overwrite user overrides)
    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        providerDisplayName: profile.displayName,
        providerProfileImageUrl: profile.picture || null,
      },
    });

    // Check if user is disabled
    if (!user.isActive) {
      this.logger.warn(`Login attempt by disabled user: ${user.email}`);
      throw new ForbiddenException('User account is disabled');
    }

    // Generate JWT tokens
    const tokens = await this.generateFullTokens(user);

    this.logger.log(`Login successful for user: ${user.email}`);

    // -------------------------------------------------------------------------
    // Trigger: `user.welcome` (#128, epic #109)
    // -------------------------------------------------------------------------
    //
    // FIRES ONCE PER ACCOUNT, and the guarantee is structural rather than a
    // check on some "welcomed" column. `userWasCreated` is set on exactly one
    // branch above: the one reached only when NO identity matched
    // (provider + subject) AND no user matched by email — i.e. the branch that
    // runs `INSERT INTO users`. Every subsequent login resolves an identity and
    // never enters it, and the identity-LINKING case (an existing account
    // adding a second provider) is a different branch that does not set the
    // flag, correctly: that user already has an account and was welcomed when
    // it was made.
    //
    // AND ONLY AFTER THE ROW IS COMMITTED. `createNewUser` wraps its inserts in
    // `prisma.$transaction`, and that promise has resolved — the transaction
    // has committed — before it returns. So by the time this line runs, the
    // user, its identity, its default role and its `user_settings` row are all
    // durable. That matters concretely: the dispatcher reads BOTH `users.email`
    // (for the address) and `user_settings.value` (for preferences) on its own
    // connection, outside any transaction of ours. Raising this inside
    // `createNewUser`'s transaction would have the dispatch race a row it
    // cannot see, and `loadRecipient` would log "user not found" and deliver
    // nothing.
    //
    // RAISED HERE, AT THE END, RATHER THAN IN THE CREATION BRANCH. Between the
    // insert and this point the method can still refuse the login — the
    // `isActive` check, or a failure generating tokens. Welcoming somebody to
    // an application they were just refused entry to is a worse message than
    // no message. The flag carries the fire-once condition down to the point
    // where the login is known to have succeeded.
    //
    // CONTAINED: `notify` never rejects and never joins a transaction, so a
    // mail outage cannot fail the login. It also returns before anything is
    // rendered or sent, so it adds no latency to the OAuth callback.
    if (userWasCreated) {
      const appUrl = this.configService.get<string>('appUrl');
      const payload: UserWelcomeEmailData = {
        recipientEmail: user.email,
        // Optional fields spread in conditionally rather than assigned
        // `undefined` — same convention as the notification channels.
        ...(profile.displayName ? { recipientName: profile.displayName } : {}),
        roles: user.userRoles.map((ur) => ur.role.name),
        ...(appUrl ? { appUrl: appUrl.replace(/\/+$/, '') } : {}),
      };

      await this.notifications.notify('user.welcome', user.id, payload);
    }

    return tokens;
  }

  /**
   * Creates a new user with default role, settings, and identity
   * Handles admin bootstrap if applicable
   */
  private async createNewUser(profile: GoogleProfile) {
    // Check if this should be the initial admin
    const shouldGrantAdmin =
      await this.adminBootstrapService.shouldGrantAdminRole(profile.email);

    // Get default role
    const defaultRole = await this.prisma.role.findUnique({
      where: { name: DEFAULT_ROLE },
      include: {
        rolePermissions: {
          include: {
            permission: true,
          },
        },
      },
    });

    if (!defaultRole) {
      this.logger.error(
        `CRITICAL: Default role "${DEFAULT_ROLE}" not found in database. ` +
          'Database seeds have not been run. Cannot create new users.',
      );
      throw new DatabaseSeedException(
        `Role "${DEFAULT_ROLE}"`,
        'npm run prisma:seed',
      );
    }

    // Create user with identity, role, and settings in transaction
    const user = await this.prisma.$transaction(async (tx) => {
      // Create user
      const newUser = await tx.user.create({
        data: {
          email: profile.email,
          providerDisplayName: profile.displayName,
          providerProfileImageUrl: profile.picture || null,
          isActive: true,
          // Create identity
          identities: {
            create: {
              provider: 'google',
              providerSubject: profile.id,
              providerEmail: profile.email,
            },
          },
          // Assign default role
          userRoles: {
            create: {
              roleId: defaultRole.id,
            },
          },
          // Create default user settings
          userSettings: {
            create: {
              value: DEFAULT_USER_SETTINGS as any,
            },
          },
        },
        include: {
          userRoles: {
            include: {
              role: {
                include: {
                  rolePermissions: {
                    include: {
                      permission: true,
                    },
                  },
                },
              },
            },
          },
        },
      });

      // Grant admin role if applicable
      if (shouldGrantAdmin) {
        // Get admin role and assign within transaction
        const adminRole = await tx.role.findUnique({
          where: { name: 'admin' },
        });

        if (!adminRole) {
          this.logger.error(
            'CRITICAL: Admin role not found in database. Database seeds have not been run.',
          );
          throw new DatabaseSeedException('Role "admin"', 'npm run prisma:seed');
        }

        await tx.userRole.upsert({
          where: {
            userId_roleId: {
              userId: newUser.id,
              roleId: adminRole.id,
            },
          },
          update: {},
          create: {
            userId: newUser.id,
            roleId: adminRole.id,
          },
        });
        this.logger.log(`Admin role assigned to user: ${newUser.id}`);

        // Reload user with admin role included
        const userWithAdmin = await tx.user.findUnique({
          where: { id: newUser.id },
          include: {
            userRoles: {
              include: {
                role: {
                  include: {
                    rolePermissions: {
                      include: {
                        permission: true,
                      },
                    },
                  },
                },
              },
            },
          },
        });

        return userWithAdmin!;
      }

      return newUser;
    });

    this.logger.log(`User created successfully: ${user.email}`);
    return user;
  }

  /**
   * Generates JWT access token for authenticated user
   */
  async generateTokens(user: {
    id: string;
    email: string;
    userRoles: Array<{ role: { name: string } }>;
  }): Promise<TokenResponseDto> {
    const roles = user.userRoles.map((ur) => ur.role.name);

    const payload: JwtPayload = {
      sub: user.id,
      email: user.email,
      roles,
    };

    const accessTtlMinutes = this.configService.get<number>(
      'jwt.accessTtlMinutes',
      15,
    );

    const accessToken = await this.jwtService.signAsync(payload, {
      expiresIn: `${accessTtlMinutes}m`,
    });

    return {
      accessToken,
      expiresIn: accessTtlMinutes * 60, // Convert to seconds
    };
  }

  /**
   * Generate both access and refresh tokens
   */
  async generateFullTokens(
    user: {
      id: string;
      email: string;
      userRoles: Array<{ role: { name: string } }>;
    },
    options?: { accessTtlMinutes?: number; refreshTtlDays?: number },
  ): Promise<FullTokenResponse> {
    const accessToken = this.generateAccessToken(user, options?.accessTtlMinutes);
    const refreshToken = await this.createRefreshToken(user.id, options?.refreshTtlDays);

    return {
      accessToken: accessToken.token,
      expiresIn: accessToken.expiresIn,
      refreshToken,
    };
  }

  /**
   * Generate access token only
   */
  private generateAccessToken(
    user: {
      id: string;
      email: string;
      userRoles: Array<{ role: { name: string } }>;
    },
    ttlMinutesOverride?: number,
  ) {
    const roles = user.userRoles.map((ur) => ur.role.name);

    const payload: JwtPayload = {
      sub: user.id,
      email: user.email,
      roles,
    };

    const accessTtlMinutes =
      ttlMinutesOverride ??
      this.configService.get<number>('jwt.accessTtlMinutes', 15);

    return {
      token: this.jwtService.sign(payload, { expiresIn: `${accessTtlMinutes}m` }),
      expiresIn: accessTtlMinutes * 60,
    };
  }

  /**
   * Create a new refresh token
   */
  private async createRefreshToken(userId: string, ttlDaysOverride?: number): Promise<string> {
    const refreshTtlDays =
      ttlDaysOverride ??
      this.configService.get<number>('jwt.refreshTtlDays', 14);
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + refreshTtlDays);

    // Generate random token
    const token = randomBytes(32).toString('hex');
    const tokenHash = this.hashToken(token);

    // Store hashed token in database
    await this.prisma.refreshToken.create({
      data: {
        userId,
        tokenHash,
        expiresAt,
      },
    });

    this.logger.debug(`Created refresh token for user: ${userId}`);

    return token;
  }

  /**
   * Refresh access token using refresh token
   */
  async refreshAccessToken(refreshToken: string): Promise<FullTokenResponse> {
    const tokenHash = this.hashToken(refreshToken);

    // Find valid refresh token
    const storedToken = await this.prisma.refreshToken.findUnique({
      where: { tokenHash },
      include: {
        user: {
          include: {
            userRoles: {
              include: { role: true },
            },
          },
        },
      },
    });

    if (!storedToken) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    // Check if revoked
    if (storedToken.revokedAt) {
      // Potential token reuse attack - revoke all tokens for user
      await this.revokeAllUserTokens(storedToken.userId);
      this.logger.warn(
        `Refresh token reuse detected for user: ${storedToken.userId}`,
      );
      throw new UnauthorizedException('Refresh token has been revoked');
    }

    // Check if expired
    if (storedToken.expiresAt < new Date()) {
      throw new UnauthorizedException('Refresh token has expired');
    }

    // Check if user is active
    if (!storedToken.user.isActive) {
      throw new UnauthorizedException('User account is deactivated');
    }

    // Rotate token - revoke old one, create new one
    await this.prisma.refreshToken.update({
      where: { id: storedToken.id },
      data: { revokedAt: new Date() },
    });

    // Generate new tokens
    const newRefreshToken = await this.createRefreshToken(storedToken.userId);
    const accessToken = this.generateAccessToken(storedToken.user);

    return {
      accessToken: accessToken.token,
      expiresIn: accessToken.expiresIn,
      refreshToken: newRefreshToken,
    };
  }

  /**
   * Logout - revoke refresh token
   */
  async logout(userId: string, refreshToken?: string): Promise<void> {
    if (refreshToken) {
      // Revoke specific token
      const tokenHash = this.hashToken(refreshToken);
      await this.prisma.refreshToken.updateMany({
        where: { tokenHash, userId },
        data: { revokedAt: new Date() },
      });
    } else {
      // Revoke all tokens for user
      await this.revokeAllUserTokens(userId);
    }

    this.logger.log(`User logged out: ${userId}`);
  }

  /**
   * Revoke all refresh tokens for a user
   */
  async revokeAllUserTokens(userId: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: {
        userId,
        revokedAt: null,
      },
      data: { revokedAt: new Date() },
    });
  }

  /**
   * Clean up expired tokens (run periodically)
   */
  async cleanupExpiredTokens(): Promise<number> {
    const result = await this.prisma.refreshToken.deleteMany({
      where: {
        OR: [
          { expiresAt: { lt: new Date() } },
          { revokedAt: { not: null } },
        ],
      },
    });

    this.logger.log(`Cleaned up ${result.count} expired/revoked tokens`);
    return result.count;
  }

  /**
   * Hash token for storage
   */
  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  /**
   * Validates JWT payload and returns user with roles and permissions
   */
  async validateJwtPayload(payload: JwtPayload): Promise<AuthenticatedUser | null> {
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      include: {
        userRoles: {
          include: {
            role: {
              include: {
                rolePermissions: {
                  include: {
                    permission: true,
                  },
                },
              },
            },
          },
        },
      },
    });

    if (!user || !user.isActive) {
      return null;
    }

    return user;
  }

  /**
   * Returns list of enabled OAuth providers
   */
  async getEnabledProviders(): Promise<AuthProviderDto[]> {
    const providers: AuthProviderDto[] = [];

    // Check if Google OAuth is configured
    const googleClientId = this.configService.get<string>('google.clientId');
    const googleClientSecret = this.configService.get<string>(
      'google.clientSecret',
    );

    if (googleClientId && googleClientSecret) {
      providers.push({
        name: 'google',
        enabled: true,
      });
    }

    return providers;
  }

  /**
   * Returns current user details with computed display name and image
   */
  async getCurrentUser(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        userRoles: {
          include: {
            role: {
              include: {
                rolePermissions: {
                  include: {
                    permission: true,
                  },
                },
              },
            },
          },
        },
        userSettings: {
          select: { value: true },
        },
      },
    });

    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    // Compute display name (override takes precedence)
    const displayName = user.displayName || user.providerDisplayName || null;

    // Profile image (#367): resolved from `profile.imageSource`. The unused
    // `users.profile_image_url` column is deliberately not consulted. The
    // provider URL and whether an uploaded picture exists are exposed too, so
    // the settings UI can preview each option whichever one is selected — the
    // uploaded one through the authenticated GET /user-settings/profile-image,
    // since the public avatar URL only serves while `upload` is selected.
    const storedProfile = (
      user.userSettings?.value as { profile?: unknown } | null | undefined
    )?.profile;
    const profileImageUrl = resolveProfileImageUrl(user, storedProfile);
    const hasUploadedProfileImage =
      normalizeProfileSettings(storedProfile).imageObjectId !== null;

    // Extract roles
    const roles = user.userRoles.map((ur) => ({
      name: ur.role.name,
    }));

    // Aggregate permissions
    const permissionsSet = new Set<string>();
    user.userRoles.forEach((ur) => {
      ur.role.rolePermissions.forEach((rp) => {
        permissionsSet.add(rp.permission.name);
      });
    });
    const permissions = Array.from(permissionsSet);

    return {
      id: user.id,
      email: user.email,
      displayName,
      profileImageUrl,
      providerProfileImageUrl: user.providerProfileImageUrl ?? null,
      hasUploadedProfileImage,
      isActive: user.isActive,
      roles,
      permissions,
    };
  }

  /**
   * Check if email matches the initial admin email
   */
  private isInitialAdminEmail(email: string): boolean {
    const initialAdminEmail = this.configService.get<string>('INITIAL_ADMIN_EMAIL');
    return initialAdminEmail ? email === initialAdminEmail.toLowerCase() : false;
  }
}
