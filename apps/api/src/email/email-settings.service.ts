import { ConflictException, Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { z } from 'zod';

import { PrismaService } from '../prisma/prisma.service';
import { CredentialsService } from '../credentials/credentials.service';
import {
  DEFAULT_EMAIL_SETTINGS,
  EmailSettings,
  emailSettingsSchema,
} from './email-settings.schema';
import {
  SMTP_CREDENTIAL_LABEL,
  SMTP_CREDENTIAL_NAME,
  SMTP_CREDENTIAL_PURPOSE,
} from './smtp-credential.constants';
import type { UpdateEmailSettingsInput } from './dto/update-email-settings.dto';

// =============================================================================
// EmailSettingsService — where email configuration is read from (issue #122)
// =============================================================================
//
// WHERE THESE SETTINGS LIVE, AND WHY
//
// In the existing `system_settings` table, as epic #109 and issue #122 call
// for — but in a row of its OWN, under key 'email', NOT inside the 'global'
// row's blob. No new table, no migration; `system_settings.key` is already
// `@unique` and the table is already keyed for exactly this.
//
// The reason it is not inside the 'global' blob is not taste, it is that the
// blob would eat it. `SystemSettingsService` rebuilds that value field by
// field on every write:
//
//   • replaceSettings (PUT)  → `systemSettingsSchema.parse(dto)`, and zod
//                              STRIPS unknown keys, so anything not in that
//                              schema is dropped from the stored object.
//   • patchSettings (PATCH)  → hand-builds `merged` from the modelled
//                              namespaces, which discards every other key
//                              even on a partial update.
//
// So an `email` key inside the 'global' blob would be silently destroyed the
// next time an admin saved an unrelated general setting — mail stops working,
// nothing in the audit trail explains why, and the admin's action ("I toggled
// an unrelated setting") has no visible connection to the outcome ("email is
// unconfigured"). Widening `systemSettingsSchema` does not fix it: a PUT whose
// DTO omits `email` still stores an object without it.
//
// A separate row makes that impossible: the two settings surfaces write
// different rows, and neither can clobber the other. It also keeps SMTP host
// and username out of `GET /api/system-settings`' response, which is a smaller
// blast radius for no extra cost, and it gives #124's page its own version
// counter for optimistic concurrency instead of sharing one with a page that
// has nothing to do with email.
//
// #124 owns the WRITE path and adds it here, next to this read, so both halves
// of "what is the email configuration" stay in one file. That write path also
// routes the SMTP PASSWORD -- to `CredentialsService`, never into the blob --
// for the reason spelled out on `update` below.
// =============================================================================

/**
 * The `system_settings.key` this configuration is stored under.
 *
 * Exported so #124's write path and any test fixture address the same row by
 * the same constant rather than by a repeated string literal.
 */
export const EMAIL_SETTINGS_KEY = 'email';

/**
 * The masked view of the stored SMTP password that the admin page renders.
 *
 * A boolean alone was the alternative and is not enough: an admin who has just
 * rotated a credential needs to see WHICH value is live, and "when, and by
 * whom" is the difference between "my change saved" and "I am looking at a
 * colleague's value from months ago".
 *
 * EVERY FIELD HERE IS NON-SECRET BY CONSTRUCTION. `hint` is the credential
 * store's own mask, derived on write from the plaintext by code that already
 * holds it; nothing in this module can widen it, and no other part of the
 * secret is representable in this shape.
 */
export interface SmtpPasswordStatus {
  /** Is a password stored at `(purpose 'smtp', name 'default')`? */
  configured: boolean;

  /** The store's mask, e.g. `••••x9fQ`. Null when nothing is stored. */
  hint: string | null;

  /** When the stored password was last written. */
  updatedAt: Date | null;

  /** Who last wrote it. Null when nothing is stored, or the user was deleted. */
  updatedByUserId: string | null;
}

/**
 * What the admin settings page reads: the configuration plus the three things
 * it cannot derive -- whether a password exists, why the stored row would not
 * parse, and the version/provenance metadata.
 *
 * Extends {@link EmailSettings} rather than nesting it, so a field added to the
 * schema appears on this view with no edit here. The response DTO
 * (`./dto/email-settings-response.dto.ts`) is derived from the same schema for
 * the same reason, and carries a compile-time proof that no secret-bearing
 * field crept into the extension.
 */
export interface EmailSettingsAdminView extends EmailSettings {
  smtpPasswordStatus: SmtpPasswordStatus;

  /**
   * Why the stored row could not be read, when it could not be. Null normally.
   * FIELD PATHS ONLY -- see the note where it is built.
   */
  settingsError: string | null;

  /** Bumped on every write. The optimistic-concurrency token for `If-Match`. */
  version: number;

  updatedAt: Date | null;

  updatedBy: { id: string; email: string } | null;
}

/**
 * A zod failure rendered as the list of field paths that failed.
 *
 * PATHS, NEVER VALUES, and the two callers both depend on that: one logs the
 * result and one returns it to an admin. `zod`'s own `message` strings can
 * quote the received value, so the issue objects are never stringified
 * wholesale. There is no secret in this schema today -- there is a
 * compile-time proof of that in email-settings.schema.ts -- and this function
 * is what keeps the claim true if the schema ever grows.
 */
function describeInvalidPaths(error: z.ZodError): string {
  return error.issues
    .map((issue) => issue.path.join('.') || '(root)')
    .join(', ');
}

/**
 * Drop the settings fields an admin left empty.
 *
 * An HTML form cannot express "absent": a cleared input submits `''`, and a
 * reset controlled component submits `null`. Every optional field in
 * `emailSettingsSchema` expresses "not configured" as the KEY BEING MISSING
 * (`.min(1)` on the strings, so `''` is a validation error rather than a
 * value). Without this step, an admin switching from SMTP to SES could not
 * save without first inventing a value for a field they are abandoning.
 *
 * `provider` IS EXEMPT: `null` there is a real, persisted state -- "no
 * transport chosen" -- and stripping it would drop a required key and fail the
 * parse. That distinction is the whole reason this is an explicit function
 * rather than a blanket falsy filter.
 *
 * The SMTP PASSWORD never reaches here: it is destructured off in `update`
 * before this is called. `''` there means "keep the stored one" and must
 * survive intact; putting it through this function would convert it to
 * "absent", which is the same thing to `CredentialsService` today but is a
 * coincidence, not a contract, and not one worth depending on.
 */
function stripUnsetSettingFields(
  input: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(input)) {
    if (key === 'provider') {
      out[key] = value;
      continue;
    }

    if (value === '' || value === null) continue;

    out[key] = value;
  }

  return out;
}

/**
 * Is this submission "I did not retype the password"?
 *
 * Mirrors `CredentialsService.isBlankSecret` exactly, including the ABSENCE of
 * `.trim()`: a passphrase whose surrounding whitespace is significant is a
 * real password, and silently altering a secret's bytes produces an
 * authentication failure with no visible cause.
 *
 * It exists here only to decide WHETHER TO CALL `setSecret` at all (see
 * `update`); the preserve behaviour itself belongs to the store and is not
 * reimplemented. If the two definitions ever need to differ, that is a bug in
 * this one.
 */
function isBlankPassword(value: string | null | undefined): boolean {
  return value === undefined || value === null || value === '';
}

@Injectable()
export class EmailSettingsService {
  private readonly logger = new Logger(EmailSettingsService.name);

  constructor(
    private readonly prisma: PrismaService,
    // The SMTP password's only home. `EmailSettingsService` holds this
    // reference so that "save the email configuration" is ONE operation with
    // one transactional story, rather than a controller stitching a settings
    // write and a credential write together and getting the order wrong.
    //
    // Note it is only ever used through `setSecret` (write) and `describe`
    // (masked read). `getSecret` -- the plaintext one -- is never called from
    // this file, and must not be: nothing on the settings path needs the
    // password's value, and a call to it here would put plaintext one careless
    // `return` away from an admin response.
    private readonly credentials: CredentialsService,
  ) {}

  /**
   * Read the current email configuration.
   *
   * @returns validated settings; {@link DEFAULT_EMAIL_SETTINGS} when nothing
   *          has been configured yet.
   * @throws if a row exists but does not validate (see below). Callers inside
   *         a provider are safe: `BaseEmailProvider.send` turns this into a
   *         `{ success: false, error }`, which is how an admin gets told.
   */
  async get(): Promise<EmailSettings> {
    const row = await this.prisma.systemSettings.findUnique({
      where: { key: EMAIL_SETTINGS_KEY },
      select: { value: true },
    });

    if (!row) {
      // Absent is NOT an error: a fresh install has no email configuration and
      // that is a normal, expected state. Callers see "no provider selected"
      // and report it as such.
      return DEFAULT_EMAIL_SETTINGS;
    }

    const parsed = emailSettingsSchema.safeParse(row.value);

    if (!parsed.success) {
      // THROW, DO NOT FALL BACK TO DEFAULTS. Silently substituting defaults
      // for a stored-but-invalid configuration reports the system as "email
      // not configured" when what actually happened is that a hand-edited row,
      // a bad migration, or an older schema left something unreadable. That is
      // the same silent-disablement failure CredentialsService refuses on a
      // decrypt error, for the same reason: a configuration problem has to be
      // visible to the person who can fix it.
      //
      // FIELD PATHS ONLY, NEVER VALUES. No secret is in this schema by
      // construction, but an error message that echoes stored configuration is
      // a habit that stops being safe the moment the schema grows. `zod`'s own
      // `message` strings can quote the received value, so only `path` is used.
      const paths = describeInvalidPaths(parsed.error);

      this.logger.error(
        `Stored email settings are invalid at: ${paths}. Email is unusable until they are saved again.`,
      );

      throw new Error(
        `Stored email settings are invalid at: ${paths}. Re-save the email configuration.`,
      );
    }

    return parsed.data;
  }

  // ---------------------------------------------------------------------------
  // Admin surface (#124)
  // ---------------------------------------------------------------------------

  /**
   * Everything `GET /api/email-settings` renders: the configuration, whether a
   * password is stored, and the provenance/version metadata.
   *
   * SEPARATE FROM {@link get} ON PURPOSE, in two ways that matter.
   *
   * 1. IT DOES NOT THROW ON AN INVALID STORED ROW; it reports the problem in
   *    `settingsError` and returns the defaults alongside it. `get` is the
   *    SEND path and is right to throw -- a corrupt row must not be reported
   *    to a provider as the benign "email is not configured". This is the
   *    REPAIR path, and a 500 here would make the broken row take down the one
   *    screen capable of fixing it, leaving no in-app route back. The failure
   *    is still loud: it is in the payload, in front of the person who can act
   *    on it, which is the property the throw exists to protect.
   *
   * 2. IT TOUCHES THE CREDENTIAL STORE, which `get` deliberately does not. A
   *    send path has no business paying for a credential lookup it will not
   *    use, and keeping the two apart means the provider's read stays a single
   *    settings query.
   *
   * The password itself is NOT read here. `describe` returns `CredentialInfo`,
   * a type that carries a compile-time proof it cannot hold secret material,
   * and whose query does not select the ciphertext column at all -- so for
   * this request the encrypted bytes never leave Postgres.
   */
  async describeForAdmin(): Promise<EmailSettingsAdminView> {
    const row = await this.prisma.systemSettings.findUnique({
      where: { key: EMAIL_SETTINGS_KEY },
      include: { updatedByUser: { select: { id: true, email: true } } },
    });

    let settings: EmailSettings = DEFAULT_EMAIL_SETTINGS;
    let settingsError: string | null = null;

    if (row) {
      const parsed = emailSettingsSchema.safeParse(row.value);

      if (parsed.success) {
        settings = parsed.data;
      } else {
        // FIELD PATHS ONLY, NEVER VALUES -- the same rule as `get`. No secret
        // is in this schema by construction, but a message that echoes stored
        // configuration stops being safe the moment the schema grows, and
        // zod's own `message` strings can quote the received value.
        const paths = describeInvalidPaths(parsed.error);

        this.logger.error(
          `Stored email settings are invalid at: ${paths}. Serving defaults to the settings page so they can be re-saved.`,
        );

        settingsError = `The stored email configuration is invalid at: ${paths}. Correct those fields and save to repair it.`;
      }
    }

    return this.toAdminView(settings, settingsError, row);
  }

  /**
   * Replace the email configuration (`PUT /api/email-settings`).
   *
   * TWO DESTINATIONS, ONE SUBMISSION. The ordinary settings go to the `email`
   * row of `system_settings`; the SMTP password goes to the encrypted
   * credential store and NOWHERE ELSE.
   *
   * -----------------------------------------------------------------------
   * WHY THE PASSWORD IS WRITTEN FIRST
   * -----------------------------------------------------------------------
   *
   * `CredentialsService.setSecret` rejects (400) a blank secret written to an
   * address that holds nothing yet. Doing the settings write first would mean
   * that request persists an SMTP username with no password behind it and then
   * 400s -- the admin sees a failure, the configuration changed anyway, and the
   * next send fails for a reason the error never mentioned. Password first
   * makes that refusal happen before anything is persisted.
   *
   * The opposite partial failure (credential written, settings write fails) is
   * harmless by construction: a stored password that no settings row points at
   * yet is inert, and the next successful save picks it up. Given the choice
   * of which half to leave orphaned, the inert one is the right answer.
   *
   * -----------------------------------------------------------------------
   * BLANK PRESERVES -- AND WHY `setSecret` IS SKIPPED ENTIRELY WHEN BLANK
   * -----------------------------------------------------------------------
   *
   * An empty password field means "I did not retype the password", so the
   * stored one is kept. `CredentialsService` already implements exactly that
   * and this method must not reimplement, second-guess or pre-normalise it:
   * no `.trim()`, no `''` -> `undefined` coercion, no "erase when empty"
   * branch. The value arrives here byte-for-byte as submitted.
   *
   * What this method DOES decide is whether to call `setSecret` at all, and it
   * calls it only for a non-blank value. Calling it with a blank one on a
   * system that has never stored an SMTP password -- an SES deployment, or an
   * IP-authorised relay with no credential -- would raise that first-write 400
   * on an ordinary save that has nothing to do with SMTP. Skipping the call
   * produces the identical outcome for an existing credential (preserved) and
   * the correct one for a non-existent one (still absent, no error).
   *
   * Erasing a stored password is `CredentialsService.deleteSecret`, from a
   * distinct control. It is deliberately not reachable through this endpoint.
   *
   * @param expectedVersion optional `If-Match`; a mismatch is a 409 rather
   *                        than a silent overwrite of a colleague's save.
   */
  async update(
    input: UpdateEmailSettingsInput,
    userId: string,
    expectedVersion?: number,
  ): Promise<EmailSettingsAdminView> {
    // Destructured out FIRST, so the password is a named local that never
    // travels with the rest of the body. `emailSettingsSchema.parse` below
    // would strip it anyway (zod drops unknown keys) -- that is the structural
    // guarantee -- but relying on a silent strip to keep a secret out of a
    // persisted blob is a guarantee nobody reading the call site can see.
    const { smtpPassword, ...submitted } = input;

    const settings = emailSettingsSchema.parse(
      stripUnsetSettingFields(submitted),
    );

    // Read the current row once, for the concurrency check. `version` starts
    // at 0 for "no row yet" so a first save can be guarded with `If-Match: 0`
    // rather than having no way to express "I believe nothing is stored".
    const existing = await this.prisma.systemSettings.findUnique({
      where: { key: EMAIL_SETTINGS_KEY },
      select: { version: true },
    });
    const currentVersion = existing?.version ?? 0;

    if (expectedVersion !== undefined && currentVersion !== expectedVersion) {
      throw new ConflictException(
        `Email settings version mismatch. Expected ${expectedVersion}, found ${currentVersion}`,
      );
    }

    // See the header: password first, and only when one was actually typed.
    const passwordSubmitted = !isBlankPassword(smtpPassword);

    if (passwordSubmitted) {
      await this.credentials.setSecret(
        SMTP_CREDENTIAL_PURPOSE,
        SMTP_CREDENTIAL_NAME,
        // Passed through UNTOUCHED. See the blank-preserves note above.
        smtpPassword,
        { label: SMTP_CREDENTIAL_LABEL, updatedByUserId: userId },
      );
    }

    const row = await this.prisma.systemSettings.upsert({
      where: { key: EMAIL_SETTINGS_KEY },
      update: {
        value: settings as unknown as Prisma.InputJsonValue,
        updatedByUserId: userId,
        version: { increment: 1 },
      },
      create: {
        key: EMAIL_SETTINGS_KEY,
        value: settings as unknown as Prisma.InputJsonValue,
        updatedByUserId: userId,
      },
      include: { updatedByUser: { select: { id: true, email: true } } },
    });

    await this.prisma.auditEvent.create({
      data: {
        actorUserId: userId,
        action: 'email_settings:replace',
        targetType: 'system_settings',
        targetId: row.id,
        meta: {
          // SAFE TO RECORD IN FULL: `settings` is the output of
          // `emailSettingsSchema.parse`, and that schema carries a
          // compile-time proof that it has no secret-bearing field. The
          // password is not in this object and cannot become so without that
          // proof failing to compile.
          newValue: settings as unknown as Prisma.InputJsonValue,
          // WHETHER the password changed, never what it changed to. This is
          // the fact an audit trail needs -- "who rotated the SMTP credential,
          // and when" -- and it is the whole of what can be safely recorded.
          smtpPasswordChanged: passwordSubmitted,
        } as unknown as Prisma.InputJsonValue,
      },
    });

    // userId only. No settings values, no recipient, and above all no
    // password: application logs are shipped, indexed and retained far more
    // widely than this table is.
    this.logger.log(
      `Email settings replaced by user ${userId}` +
        (passwordSubmitted ? ' (SMTP password updated)' : ''),
    );

    return this.toAdminView(settings, null, row);
  }

  /**
   * Assemble the admin view from an already-validated settings object and the
   * row it came from.
   *
   * Shared by {@link describeForAdmin} and {@link update} so a PUT's response
   * is built by the same code as the following GET -- otherwise the page can
   * render one shape after saving and a different one after a reload, and the
   * difference is invisible until someone hits it.
   *
   * Fields are named EXPLICITLY rather than spread from the row, matching
   * `CredentialsService.toInfo` and for the same reason: a spread makes the
   * response shape a consequence of whatever the query happened to select, so
   * a later `include` or a plain `findUnique` with no `select` would silently
   * start serialising columns nobody decided to publish.
   */
  private async toAdminView(
    settings: EmailSettings,
    settingsError: string | null,
    row: {
      version: number;
      updatedAt: Date;
      updatedByUser: { id: string; email: string } | null;
    } | null,
  ): Promise<EmailSettingsAdminView> {
    // The masked read. NOT `getSecret` -- `describe` returns `CredentialInfo`,
    // which has no field capable of carrying secret material, so there is
    // nothing on this path that could be widened into a leak.
    const info = await this.credentials.describe(
      SMTP_CREDENTIAL_PURPOSE,
      SMTP_CREDENTIAL_NAME,
    );

    return {
      ...settings,
      smtpPasswordStatus: {
        configured: info !== null,
        // The store's own mask ('••••' plus at most four trailing
        // characters, and nothing at all below eight). Derived on write by
        // `CredentialsService`; never computed here, because computing it
        // would mean holding the plaintext to compute it from.
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
}
