import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { AddEmailDto } from './dto/add-email.dto';
import { AllowlistQueryDto } from './dto/allowlist-query.dto';
import { NotificationsService } from '../notifications/notifications.service';
import type { AllowlistInvitationEmailData } from '../email';

@Injectable()
export class AllowlistService {
  private readonly logger = new Logger(AllowlistService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly config: ConfigService,
  ) {}

  /**
   * List allowed emails with pagination and filtering
   */
  async listAllowedEmails(query: AllowlistQueryDto) {
    const { page, pageSize, search, status, sortBy, sortOrder } = query;
    const skip = (page - 1) * pageSize;

    // Build where clause
    const where: any = {};

    if (search) {
      where.email = { contains: search, mode: 'insensitive' };
    }

    if (status === 'pending') {
      where.claimedById = null;
    } else if (status === 'claimed') {
      where.claimedById = { not: null };
    }

    // Execute query
    const [items, total] = await Promise.all([
      this.prisma.allowedEmail.findMany({
        where,
        skip,
        take: pageSize,
        orderBy: { [sortBy]: sortOrder },
        include: {
          addedBy: {
            select: {
              id: true,
              email: true,
            },
          },
          claimedBy: {
            select: {
              id: true,
              email: true,
            },
          },
        },
      }),
      this.prisma.allowedEmail.count({ where }),
    ]);

    return {
      items,
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    };
  }

  /**
   * Add email to allowlist
   */
  async addEmail(dto: AddEmailDto, adminUserId: string) {
    const email = dto.email.toLowerCase();

    // Check for duplicates
    const existing = await this.prisma.allowedEmail.findUnique({
      where: { email },
    });

    if (existing) {
      throw new ConflictException(
        `Email ${email} is already in the allowlist`,
      );
    }

    // Create entry
    const entry = await this.prisma.allowedEmail.create({
      data: {
        email,
        notes: dto.notes,
        addedById: adminUserId,
      },
      include: {
        addedBy: {
          select: {
            id: true,
            email: true,
          },
        },
      },
    });

    // Create audit event
    await this.createAuditEvent(
      adminUserId,
      'allowlist:add',
      'allowed_email',
      entry.id,
      { email },
    );

    this.logger.log(`Email ${email} added to allowlist by admin ${adminUserId}`);

    // -------------------------------------------------------------------------
    // Trigger: `allowlist.invitation` (#128, epic #109)
    // -------------------------------------------------------------------------
    //
    // THE ONE NOTIFICATION IN THIS EPIC WITH OBVIOUS USER VALUE: without it an
    // admin adds an address here and then has to tell the person out of band,
    // which is a step that gets forgotten and an invitation that never arrives.
    //
    // `notifyAddress`, NOT `notify`. The recipient has no user id to pass —
    // having no account is the entire meaning of being newly allowlisted — and
    // therefore no `user_settings` row and no preferences to resolve. See the
    // long note on `NotificationsService.notifyAddress` for why that is a
    // second way of BUILDING a recipient rather than a bypass of the
    // preference gate, and why it still resolves the address to an account
    // when one happens to exist (an admin CAN allowlist an address that
    // already has a user — the initial admin bypasses this list entirely, and
    // entries can be removed and re-added).
    //
    // AFTER THE ENTRY IS COMMITTED, AND AFTER THE AUDIT ROW. Sending first
    // would mail somebody an invitation to sign in with an address the
    // database does not yet allow — the login would be refused and the
    // recipient would have no way to understand why. The insert above is a
    // plain, already-committed write, so by the time this line runs the
    // permission is real.
    //
    // FAILURE IS CONTAINED: `notifyAddress` never rejects and never joins a
    // transaction, so a mail outage cannot fail or roll back the allowlist
    // entry. The admin's POST succeeds and the failed send is a
    // `notification_deliveries` row with the provider's error.
    const signInUrl = this.signInUrl();

    // Optional fields are SPREAD IN CONDITIONALLY rather than assigned
    // `undefined`, matching the convention the notification channels already
    // use: an absent key and a key holding `undefined` render identically
    // today, but only the former survives being serialised, logged or
    // compared, and only the former stays correct if
    // `exactOptionalPropertyTypes` is ever turned on.
    const payload: AllowlistInvitationEmailData = {
      recipientEmail: email,
      // `addedBy` came free with the `include` on the create above — no extra
      // query. Optional because `added_by_id` is nullable (`onDelete:
      // SetNull`), so an entry outlives the admin who created it.
      ...(entry.addedBy?.email ? { invitedBy: entry.addedBy.email } : {}),
      ...(signInUrl ? { signInUrl } : {}),
    };

    // `dto.notes` IS DELIBERATELY NOT IN THE PAYLOAD. It is an administrator's
    // private annotation about this person ("contractor, ends in March"),
    // written with no expectation that they will read it. Omitting it at the
    // call site rather than in the template means no future edit to the copy
    // can surface it.
    await this.notifications.notifyAddress('allowlist.invitation', email, payload);

    return entry;
  }

  /**
   * Remove email from allowlist
   */
  async removeEmail(id: string, adminUserId: string) {
    // Find entry
    const entry = await this.prisma.allowedEmail.findUnique({
      where: { id },
    });

    if (!entry) {
      throw new NotFoundException(`Allowlist entry with ID ${id} not found`);
    }

    // Check if claimed
    if (entry.claimedById) {
      throw new BadRequestException(
        'Cannot remove allowlist entry that has been claimed by a user',
      );
    }

    // Delete entry
    await this.prisma.allowedEmail.delete({
      where: { id },
    });

    // Create audit event
    await this.createAuditEvent(
      adminUserId,
      'allowlist:remove',
      'allowed_email',
      id,
      { email: entry.email },
    );

    this.logger.log(
      `Email ${entry.email} removed from allowlist by admin ${adminUserId}`,
    );
  }

  /**
   * Check if email is in allowlist
   */
  async isEmailAllowed(email: string): Promise<boolean> {
    const normalizedEmail = email.toLowerCase();
    const entry = await this.prisma.allowedEmail.findUnique({
      where: { email: normalizedEmail },
    });

    return entry !== null;
  }

  /**
   * Mark email as claimed by a user
   */
  async markEmailClaimed(email: string, userId: string): Promise<void> {
    const normalizedEmail = email.toLowerCase();

    // Find entry
    const entry = await this.prisma.allowedEmail.findUnique({
      where: { email: normalizedEmail },
    });

    // If entry doesn't exist or already claimed, do nothing (idempotent)
    if (!entry || entry.claimedById) {
      return;
    }

    // Update entry
    await this.prisma.allowedEmail.update({
      where: { id: entry.id },
      data: {
        claimedById: userId,
        claimedAt: new Date(),
      },
    });

    this.logger.log(`Email ${normalizedEmail} claimed by user ${userId}`);
  }

  /**
   * Absolute URL of the sign-in page, for the invitation's CTA.
   *
   * Built here rather than in the template, which is a pure function of its
   * input and has no business reading configuration or knowing the web app's
   * route table. `undefined` when `APP_URL` is unset — the layout then omits
   * the button rather than rendering one that goes nowhere.
   */
  private signInUrl(): string | undefined {
    const appUrl = this.config.get<string>('appUrl');
    return appUrl ? `${appUrl.replace(/\/+$/, '')}/login` : undefined;
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
