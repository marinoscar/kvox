import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes, createHash } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService } from '../auth/auth.service';
import { PatService } from '../pat/pat.service';
import { DeviceCodeStatus, Prisma } from '@prisma/client';
import { DeviceTokenType } from './dto/device-code-request.dto';
import { DeviceTokenResponseDto } from './dto/device-token-response.dto';
// Every failure of the token endpoint goes through this factory, never through
// a bare `new BadRequestException({ error: … })`. Thrown directly, that body is
// flattened by the global exception filter into a generic 400 and the RFC code
// is destroyed — which is exactly what #153 was. The factory brands the
// exception so the filter sends `{ error, error_description }` verbatim.
import { deviceTokenError } from './exceptions/device-token-error.exception';

/**
 * Service for handling Device Authorization Flow (RFC 8628)
 */
@Injectable()
export class DeviceAuthService {
  private readonly logger = new Logger(DeviceAuthService.name);

  // Characters for user code generation (unambiguous)
  private readonly USER_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

  // Tracking last poll times for rate limiting
  private readonly pollTimestamps = new Map<string, number>();

  // Prefix stamped onto every token this flow mints, so a row in the web UI's
  // Access Tokens list is immediately identifiable as device-flow-issued
  // rather than hand-created (#141). Kept in one constant because it is
  // budgeted against PAT_NAME_MAX_LENGTH below.
  private readonly PAT_NAME_PREFIX = 'Device: ';

  // `createPatSchema` caps a PAT name at 100 characters. We call PatService
  // DIRECTLY here, so that zod schema never runs on our input and cannot
  // protect us — an over-long `deviceName` would reach Postgres unchecked.
  // Enforcing the same ceiling ourselves keeps device-issued tokens
  // indistinguishable from UI-created ones as far as the column is concerned.
  private readonly PAT_NAME_MAX_LENGTH = 100;

  // Shown when `deviceName` is missing, not a string, or sanitises away to
  // nothing. Never leave the name empty: `createPatSchema` requires min(1), and
  // more importantly an unlabelled row in the Access Tokens page is a token a
  // user cannot confidently revoke.
  private readonly PAT_NAME_FALLBACK = 'Unnamed device';

  constructor(
    private readonly prisma: PrismaService,
    private readonly authService: AuthService,
    private readonly configService: ConfigService,
    // PatModule is @Global and registered in AppModule, so this resolves
    // without DeviceAuthModule importing it — the same way JwtAuthGuard already
    // depends on PatService. Importing it here as well would be harmless but
    // redundant.
    private readonly patService: PatService,
  ) {}

  /**
   * Generate a new device code pair
   */
  async generateDeviceCode(clientInfo?: Record<string, any>) {
    const expiryMinutes = this.configService.get<number>(
      'deviceAuth.expiryMinutes',
      15,
    );
    const pollInterval = this.configService.get<number>(
      'deviceAuth.pollInterval',
      5,
    );
    const appUrl = this.configService.get<string>('appUrl');

    // Generate device code (secure random string)
    const deviceCode = randomBytes(32).toString('hex');
    const deviceCodeHash = this.hashToken(deviceCode);

    // Generate user code (human-readable)
    const userCode = this.generateUserCode();

    // Calculate expiration
    const expiresAt = new Date();
    expiresAt.setMinutes(expiresAt.getMinutes() + expiryMinutes);

    // Store in database
    await this.prisma.deviceCode.create({
      data: {
        deviceCode: deviceCodeHash,
        userCode,
        status: DeviceCodeStatus.pending,
        clientInfo: clientInfo || {},
        scopes: [], // Future extension for scoped permissions
        expiresAt,
      },
    });

    this.logger.log(`Generated device code with user code: ${userCode}`);

    // Build response
    const verificationUri = `${appUrl}/activate`;
    const verificationUriComplete = `${verificationUri}?code=${userCode}`;

    return {
      deviceCode,
      userCode,
      verificationUri,
      verificationUriComplete,
      expiresIn: expiryMinutes * 60, // Convert to seconds
      interval: pollInterval,
    };
  }

  /**
   * Poll for device authorization status
   */
  async pollForToken(deviceCode: string) {
    const deviceCodeHash = this.hashToken(deviceCode);
    const pollInterval = this.configService.get<number>(
      'deviceAuth.pollInterval',
      5,
    );

    // Check rate limiting
    const lastPoll = this.pollTimestamps.get(deviceCodeHash);
    const now = Date.now();

    if (lastPoll && now - lastPoll < pollInterval * 1000) {
      throw deviceTokenError(
        'slow_down',
        'Polling too frequently. Please slow down.',
      );
    }

    // Update last poll timestamp
    this.pollTimestamps.set(deviceCodeHash, now);

    // Find device code
    const record = await this.prisma.deviceCode.findUnique({
      where: { deviceCode: deviceCodeHash },
      include: {
        user: {
          include: {
            userRoles: {
              include: {
                role: true,
              },
            },
          },
        },
      },
    });

    if (!record) {
      throw deviceTokenError('invalid_grant', 'Invalid device code');
    }

    // Check if expired
    if (record.expiresAt < new Date()) {
      await this.prisma.deviceCode.update({
        where: { id: record.id },
        data: { status: DeviceCodeStatus.expired },
      });

      throw deviceTokenError('expired_token', 'The device code has expired');
    }

    // Check status
    switch (record.status) {
      case DeviceCodeStatus.pending:
        throw deviceTokenError(
          'authorization_pending',
          'User has not yet authorized this device',
        );

      case DeviceCodeStatus.denied:
        throw deviceTokenError(
          'access_denied',
          'User denied the authorization request',
        );

      case DeviceCodeStatus.expired:
        throw deviceTokenError('expired_token', 'The device code has expired');

      case DeviceCodeStatus.approved: {
        if (!record.user) {
          throw deviceTokenError(
            'invalid_grant',
            'User information not found',
          );
        }

        // A device that asked for a PAT gets one MINTED RIGHT HERE, at poll
        // time — not at approval time. See issuePatCredential() for why that
        // ordering is the security-relevant part of #141.
        if (this.readTokenType(record.clientInfo) === 'pat') {
          return await this.issuePatCredential(
            record.id,
            record.user.id,
            record.user.email,
            record.clientInfo,
            deviceCodeHash,
          );
        }

        // ------------------------------------------------------------------
        // Session path — UNCHANGED from before #141, deliberately. Every line
        // below, including the non-atomic "generate then mark used" ordering,
        // is the behaviour existing device clients already depend on. The PAT
        // branch above returns before reaching it, so nothing here can regress.
        // ------------------------------------------------------------------

        // Generate tokens with device-specific expiry
        const tokenExpiryDays = this.configService.get<number>(
          'deviceAuth.tokenExpiryDays',
          7,
        );
        const tokens = await this.authService.generateFullTokens(record.user, {
          accessTtlMinutes: tokenExpiryDays * 24 * 60,
          refreshTtlDays: tokenExpiryDays,
        });

        // Mark as used (update status to expired to prevent reuse)
        await this.prisma.deviceCode.update({
          where: { id: record.id },
          data: { status: DeviceCodeStatus.expired },
        });

        // Clean up poll timestamp
        this.pollTimestamps.delete(deviceCodeHash);

        this.logger.log(
          `Device authorized successfully for user: ${record.user.email}`,
        );

        return {
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken!,
          tokenType: 'Bearer',
          expiresIn: tokens.expiresIn,
        };
      }

      default:
        throw deviceTokenError(
          'invalid_request',
          'Unknown device code status',
        );
    }
  }

  /**
   * Get activation info for the frontend
   */
  async getActivationInfo(userCode?: string) {
    const appUrl = this.configService.get<string>('appUrl');
    const verificationUri = `${appUrl}/activate`;

    if (!userCode) {
      return { verificationUri };
    }

    // Normalize user code
    const normalizedCode = userCode.toUpperCase().replace(/\s/g, '');

    // Find device code by user code
    const record = await this.prisma.deviceCode.findUnique({
      where: { userCode: normalizedCode },
    });

    if (!record) {
      throw new NotFoundException('Invalid user code');
    }

    // Check if expired
    if (record.expiresAt < new Date()) {
      throw new BadRequestException('This code has expired');
    }

    // Check if already processed
    if (
      record.status === DeviceCodeStatus.approved ||
      record.status === DeviceCodeStatus.denied
    ) {
      throw new BadRequestException('This code has already been processed');
    }

    return {
      verificationUri,
      userCode: record.userCode,
      clientInfo: record.clientInfo as Record<string, any> | undefined,
      expiresAt: record.expiresAt.toISOString(),
    };
  }

  /**
   * Authorize or deny a device
   */
  async authorizeDevice(userId: string, userCode: string, approve: boolean) {
    // Normalize user code
    const normalizedCode = userCode.toUpperCase().replace(/\s/g, '');

    // Find device code
    const record = await this.prisma.deviceCode.findUnique({
      where: { userCode: normalizedCode },
    });

    if (!record) {
      throw new NotFoundException('Invalid user code');
    }

    // Check if expired
    if (record.expiresAt < new Date()) {
      throw new BadRequestException('This code has expired');
    }

    // Check if already processed
    if (
      record.status === DeviceCodeStatus.approved ||
      record.status === DeviceCodeStatus.denied
    ) {
      throw new BadRequestException('This code has already been processed');
    }

    // Update status
    const newStatus = approve
      ? DeviceCodeStatus.approved
      : DeviceCodeStatus.denied;

    await this.prisma.deviceCode.update({
      where: { id: record.id },
      data: {
        status: newStatus,
        userId: approve ? userId : null,
      },
    });

    const action = approve ? 'approved' : 'denied';
    this.logger.log(
      `Device ${action} by user ${userId} with code: ${normalizedCode}`,
    );

    return {
      success: true,
      message: approve
        ? 'Device authorized successfully'
        : 'Device authorization denied',
    };
  }

  /**
   * Get user's approved device sessions
   */
  async getUserDeviceSessions(
    userId: string,
    page: number = 1,
    limit: number = 10,
  ) {
    const skip = (page - 1) * limit;

    const [sessions, total] = await Promise.all([
      this.prisma.deviceCode.findMany({
        where: {
          userId,
          status: DeviceCodeStatus.approved,
        },
        orderBy: {
          createdAt: 'desc',
        },
        skip,
        take: limit,
      }),
      this.prisma.deviceCode.count({
        where: {
          userId,
          status: DeviceCodeStatus.approved,
        },
      }),
    ]);

    return {
      sessions: sessions.map((session) => ({
        id: session.id,
        userCode: session.userCode,
        status: session.status,
        clientInfo: session.clientInfo as Record<string, any> | undefined,
        createdAt: session.createdAt.toISOString(),
        expiresAt: session.expiresAt.toISOString(),
      })),
      total,
      page,
      limit,
    };
  }

  /**
   * Revoke a device session
   */
  async revokeDeviceSession(userId: string, sessionId: string) {
    const session = await this.prisma.deviceCode.findUnique({
      where: { id: sessionId },
    });

    if (!session) {
      throw new NotFoundException('Session not found');
    }

    // Verify ownership
    if (session.userId !== userId) {
      throw new NotFoundException('Session not found');
    }

    // Update status to denied
    await this.prisma.deviceCode.update({
      where: { id: sessionId },
      data: { status: DeviceCodeStatus.denied },
    });

    this.logger.log(`Device session revoked: ${sessionId} by user: ${userId}`);

    return {
      success: true,
      message: 'Device session revoked successfully',
    };
  }

  /**
   * Clean up expired device codes (scheduled task)
   */
  async cleanupExpiredCodes(): Promise<number> {
    const result = await this.prisma.deviceCode.deleteMany({
      where: {
        OR: [
          { expiresAt: { lt: new Date() } },
          {
            status: DeviceCodeStatus.expired,
            updatedAt: {
              lt: new Date(Date.now() - 24 * 60 * 60 * 1000), // 1 day old
            },
          },
        ],
      },
    });

    this.logger.log(`Cleaned up ${result.count} expired device codes`);
    return result.count;
  }

  /**
   * Read the credential kind a device asked for out of its stored `clientInfo`.
   *
   * `clientInfo` is a JSONB column, so what comes back is `Prisma.JsonValue` —
   * it is NOT guaranteed to still match ClientInfoSchema. Rows written before
   * #141 have no `tokenType` at all, and the column is writable by anything
   * with database access. Anything that is not literally `'pat'` therefore
   * means `'session'`: the fallback is the SAFE direction (a short-lived,
   * refreshable credential), so a corrupt or legacy row degrades to the old
   * behaviour rather than silently minting a 90-day token.
   */
  private readTokenType(clientInfo: Prisma.JsonValue | null): DeviceTokenType {
    if (
      clientInfo &&
      typeof clientInfo === 'object' &&
      !Array.isArray(clientInfo) &&
      (clientInfo as Record<string, unknown>).tokenType === 'pat'
    ) {
      return 'pat';
    }

    return 'session';
  }

  /**
   * Mint a personal access token for an approved device and hand it back once.
   *
   * ---------------------------------------------------------------------------
   * WHERE THE RAW TOKEN LIVES BETWEEN APPROVAL AND COLLECTION (#141)
   * ---------------------------------------------------------------------------
   * Nowhere. That is the whole point, and it is why this runs on the POLL and
   * not on the approval.
   *
   * The tempting shape is: the user clicks Approve, we mint the PAT there, and
   * we stash the raw token on the `device_codes` row (`client_info` is JSONB
   * and would take it happily) until the device's next poll collects it. That
   * would be a serious regression. `PatService.createToken` returns the raw
   * token EXACTLY ONCE and stores only a SHA-256 hash, precisely so that a
   * database backup, a replica, a `SELECT *` in a support tool, a query log, or
   * an SQL-injection read yields no usable credential. Writing the raw token
   * into another table — even briefly, even in a row we delete afterwards —
   * reintroduces the plaintext-credential-at-rest problem the PAT design
   * already solved, in a table that is publicly writable at one end (anyone can
   * `POST /auth/device/code`) and swept by a cleanup task rather than by
   * careful deletion. Worse, the window is not short: RFC 8628 polling is
   * best-effort, so the plaintext would sit there for the full device-code
   * lifetime if the CLI is slow, backgrounded, or simply killed after the user
   * approves.
   *
   * So approval records INTENT ONLY — `status = approved` plus `userId`, which
   * is exactly what it already recorded — and the credential is created here,
   * in the request that will return it. The raw token exists in this process's
   * memory and in the HTTPS response body, and never touches persistent
   * storage. This also mirrors what the session path has always done (tokens
   * generated at poll time, not at approve time), so there is one rule for both
   * credential kinds.
   *
   * Consequences, accepted deliberately:
   *   - Approve-then-never-poll creates NO token. Good: no orphaned long-lived
   *     credential exists for a CLI that died, and nothing needs reaping.
   *   - The token cannot be re-fetched. A device that loses the response must
   *     re-run the flow. Correct for a write-once secret.
   * ---------------------------------------------------------------------------
   */
  private async issuePatCredential(
    deviceCodeId: string,
    userId: string,
    userEmail: string,
    clientInfo: Prisma.JsonValue | null,
    deviceCodeHash: string,
  ): Promise<DeviceTokenResponseDto> {
    // Claim the device code ATOMICALLY, before minting anything.
    //
    // The session path mints first and marks used afterwards; that is safe
    // enough there because a duplicated JWT expires on its own in days and
    // cannot be enumerated later. A duplicated PAT is a different animal: two
    // concurrent polls on the same device code would leave two independently
    // valid, months-long credentials on the account, and revoking the one the
    // user can see in the Access Tokens page would not revoke the other. The
    // in-memory `pollTimestamps` rate limiter cannot prevent this — it is
    // per-process, so it does nothing across replicas, and its own
    // check-then-set races too.
    //
    // `updateMany` with `status: approved` in the WHERE clause makes the
    // transition a single conditional UPDATE: exactly one caller sees
    // count === 1, everyone else sees 0 and is refused.
    const claim = await this.prisma.deviceCode.updateMany({
      where: { id: deviceCodeId, status: DeviceCodeStatus.approved },
      data: { status: DeviceCodeStatus.expired },
    });

    if (claim.count !== 1) {
      throw deviceTokenError(
        'invalid_grant',
        'This device code has already been used',
      );
    }

    // Note the ordering: the code is consumed BEFORE the token is minted, so if
    // createToken throws, the device must re-authorize. Failing closed is the
    // right direction — the alternative leaves a still-claimable approval
    // behind, which is a standing invitation to mint a long-lived credential.
    const expiryDays = this.resolvePatExpiryDays();
    const name = this.buildPatName(clientInfo);

    const pat = await this.patService.createToken(userId, {
      name,
      durationValue: expiryDays,
      durationUnit: 'days',
    });

    // Clean up poll timestamp (mirrors the session path)
    this.pollTimestamps.delete(deviceCodeHash);

    // Log the id and the SANITISED name — never `pat.token`, which is the
    // credential itself, and never the raw `deviceName`, which is
    // attacker-supplied and would otherwise carry newlines into the log stream.
    this.logger.log(
      `Device authorized for user ${userEmail}; issued PAT "${name}" (${pat.id}) valid ${expiryDays} day(s)`,
    );

    return {
      // A PAT is presented as `Authorization: Bearer pat_...`; JwtAuthGuard
      // recognises the `pat_` prefix and validates it through
      // PatService.validateToken, setting the same AuthenticatedUser shape on
      // the request that the JWT strategy sets. RolesGuard and PermissionsGuard
      // therefore behave identically — this token authenticates against the
      // ordinary guarded endpoints, which is the risk #141 flagged.
      accessToken: pat.token,
      tokenType: 'Bearer',
      // No `refreshToken`: see DeviceTokenResponseDto.
      expiresIn: Math.max(
        0,
        Math.floor((new Date(pat.expiresAt).getTime() - Date.now()) / 1000),
      ),
      credentialType: 'pat',
      expiresAt: pat.expiresAt,
      tokenId: pat.id,
      tokenName: pat.name,
    };
  }

  /**
   * Resolve the configured PAT lifetime, clamped to what a hand-created PAT is
   * allowed to have.
   *
   * We bypass `createPatSchema` by calling PatService directly, so a fat-fingered
   * `DEVICE_PAT_EXPIRY_DAYS=9000` would otherwise mint a 24-year credential that
   * the web UI would never have permitted — and a non-numeric value would make
   * `expiresAt` an Invalid Date, which lands in the database as a null-ish
   * timestamp and produces a token whose expiry check behaves unpredictably.
   * Clamping keeps device-issued tokens inside the same envelope as UI-issued
   * ones, and makes misconfiguration loud rather than dangerous.
   */
  private resolvePatExpiryDays(): number {
    const DEFAULT_DAYS = 90;
    const MIN_DAYS = 1;
    const MAX_DAYS = 999; // matches createPatSchema's durationValue ceiling

    const configured = this.configService.get<number>(
      'deviceAuth.patExpiryDays',
      DEFAULT_DAYS,
    );

    const days = Math.floor(Number(configured));

    if (!Number.isFinite(days) || days < MIN_DAYS || days > MAX_DAYS) {
      this.logger.warn(
        `Invalid deviceAuth.patExpiryDays (${String(configured)}); falling back to ${DEFAULT_DAYS} days`,
      );
      return DEFAULT_DAYS;
    }

    return days;
  }

  /**
   * Build the display name for a device-issued PAT from untrusted `clientInfo`.
   *
   * `deviceName` reaches the web UI's Access Tokens list, and it arrives from an
   * UNAUTHENTICATED caller: `POST /auth/device/code` is `@Public()`, so anyone
   * who can reach the API can choose this string, and any user who approves a
   * code then sees it. It also reaches the application log. Treat it as hostile:
   *
   *   - Non-strings (JSONB round-trips objects, numbers, null happily) would
   *     blow up on `.trim()`, turning an approved poll into a 500.
   *   - Empty or whitespace-only names violate `createPatSchema`'s min(1) and,
   *     worse, produce a row a user cannot confidently identify to revoke.
   *   - C0/C1 control characters — newlines above all — forge extra lines in the
   *     Pino log stream and wreck the list rendering.
   *   - Bidi overrides (U+202E and friends) and zero-width characters let a
   *     name render as something other than what is stored, which is exactly
   *     how a user is talked out of revoking the right token.
   *   - Over-long names would exceed the 100-character ceiling the PAT UI
   *     enforces and could push the identifying prefix off the screen.
   *
   * The prefix is applied AFTER sanitising and truncating, so it can never be
   * displaced: however hostile the input, the row still starts with "Device: ".
   */
  private buildPatName(clientInfo: Prisma.JsonValue | null): string {
    const raw =
      clientInfo &&
      typeof clientInfo === 'object' &&
      !Array.isArray(clientInfo)
        ? (clientInfo as Record<string, unknown>).deviceName
        : undefined;

    let name = typeof raw === 'string' ? raw : '';

    name = name
      // Normalise compatibility forms first, so fullwidth/lookalike variants of
      // the characters stripped below cannot survive by disguise.
      .normalize('NFKC')
      // C0 controls, DEL, and C1 controls.
      .replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ')
      // Zero-width and bidirectional formatting characters: invisible on screen,
      // so they let stored text and displayed text disagree.
      .replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, '')
      // Collapse the runs the substitutions above may have created.
      .replace(/\s+/g, ' ')
      .trim();

    if (name.length === 0) {
      name = this.PAT_NAME_FALLBACK;
    }

    const budget = this.PAT_NAME_MAX_LENGTH - this.PAT_NAME_PREFIX.length;

    if (name.length > budget) {
      // Reserve one character for the ellipsis so the result lands exactly on
      // the ceiling rather than one over it.
      name = `${name.slice(0, budget - 1)}\u2026`;
    }

    return `${this.PAT_NAME_PREFIX}${name}`;
  }

  /**
   * Generate a human-readable user code
   */
  private generateUserCode(): string {
    const chars = this.USER_CODE_CHARS;
    let code = '';

    // Generate 8 random characters
    for (let i = 0; i < 8; i++) {
      const randomIndex = randomBytes(1)[0] % chars.length;
      code += chars[randomIndex];
    }

    // Format as XXXX-XXXX
    return `${code.substring(0, 4)}-${code.substring(4, 8)}`;
  }

  /**
   * Hash token for storage
   */
  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}
