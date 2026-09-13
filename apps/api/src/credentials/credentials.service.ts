import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { decryptSecret, encryptSecret } from '../common/crypto/secret-cipher';
import type {
  CredentialInfo,
  CredentialMeta,
} from './interfaces/credential-info.interface';

// =============================================================================
// CredentialsService — encrypted credential store (issue #115, epic #108)
// =============================================================================
//
// One audited place to put a secret an ADMINISTRATOR configures at runtime: an
// SMTP password (#109, the immediate consumer), an OAuth client secret, a
// webhook signing key, a second bucket's S3 key. Deploy-time secrets
// (JWT_SECRET, AWS_SECRET_ACCESS_KEY, GOOGLE_CLIENT_SECRET) are NOT this —
// they come from the environment and correctly stay there.
//
// Records are addressed by `(purpose, name)`:
//
//   purpose  the sub-key domain from #114 — 'smtp', 'oauth', …
//   name     the discriminator within it  — 'default', a provider id, …
//
// WHY THIS IS NOT A BLOB IN system_settings: that table is read and returned
// wholesale by the settings endpoints. A secret inside it is one careless
// response away from exposure. The separation is the feature.
//
// WHY THIS IS NOT A COLUMN PER CONSUMER (`smtp_password` on an email row):
// every new secret would be a migration plus a bespoke encrypt call plus its
// own chance to end up in a DTO, with no shared no-egress guarantee.
//
// TWO INVARIANTS THIS CLASS EXISTS TO HOLD — read these before editing:
//
//   1. NO PLAINTEXT EGRESS. `getSecret` (plaintext, server-side only) and
//      `describe`/`list` (presentation) are different methods returning
//      different types; `CredentialInfo` has no field able to carry a secret.
//      See interfaces/credential-info.interface.ts for the compile-time
//      proofs. Additionally: nothing in this file may interpolate a secret
//      into a log line or an error message. The only variables permitted in
//      either are `purpose` and `name`.
//
//   2. BLANK PRESERVES. An admin form renders the password field empty
//      because the stored value is not readable. An empty submission
//      therefore means "keep what is stored" and can NEVER mean "erase it".
//      Erasing is `deleteSecret`, reached from a distinct control.
//
// THIS MODULE HAS NO CONTROLLER, ON PURPOSE. #109 injects the service and
// consumes it directly. Credentials have no HTTP surface here, so there is no
// route to accidentally widen and no OpenAPI schema that could grow a secret
// field. A future admin UI adds its endpoints in its own module, where the
// review is about that endpoint rather than buried in infrastructure.
// =============================================================================

/**
 * Columns that make up a `CredentialInfo`, as a Prisma `select`.
 *
 * Typed as `Record<keyof CredentialInfo, true>` so the select and the
 * presentation type cannot drift: adding a field to `CredentialInfo` without
 * selecting it fails to compile, and — the direction that matters — selecting
 * `secret` here fails too, because `CredentialInfo` has no such key and object
 * literals are checked for excess properties.
 *
 * The practical effect is that for a presentation read the ciphertext never
 * leaves Postgres at all: it is not in the SELECT list, so it is never in the
 * result set, never in a query log, and never in a heap dump of this process.
 */
const CREDENTIAL_INFO_SELECT: Record<keyof CredentialInfo, true> = {
  purpose: true,
  name: true,
  hint: true,
  label: true,
  updatedByUserId: true,
  createdAt: true,
  updatedAt: true,
};

/** The mask shown for the unreadable part of a secret. */
const HINT_MASK = '••••';

/**
 * Number of trailing characters revealed in a hint.
 *
 * Four is enough to tell two API keys apart in a list, which is the entire job
 * of a hint. More is not a better hint, it is a worse secret.
 */
const HINT_REVEALED_CHARS = 4;

/**
 * Below this length, reveal nothing.
 *
 * At 4 characters "the last 4" is the whole secret; at 5 it is all but one. The
 * floor keeps the hint from being a substantial fraction of a short PIN-like
 * value. Anything at or above 8 loses at most half.
 */
const HINT_MIN_LENGTH_TO_REVEAL = 8;

/**
 * Derive the non-secret display hint from the plaintext.
 *
 * Called only from the write path, where the service already holds the
 * plaintext for encryption, so this adds no new exposure — and it is why
 * `CredentialMeta` has no `hint` field for a caller to fill in wrongly.
 *
 * Iterates code points rather than UTF-16 units: `'…'.slice(-4)` can cut a
 * surrogate pair in half and leave a lone surrogate, which is not valid UTF-8
 * and blows up on the way into a Postgres `text` column — a passphrase with an
 * emoji in it would make saving fail with a completely unrelated error.
 */
function deriveHint(plaintext: string): string {
  const codePoints = Array.from(plaintext);

  if (codePoints.length < HINT_MIN_LENGTH_TO_REVEAL) {
    return HINT_MASK;
  }

  return `${HINT_MASK}${codePoints.slice(-HINT_REVEALED_CHARS).join('')}`;
}

/**
 * Is this write a "preserve what is stored" write?
 *
 * `undefined` and `null` are both here because a JSON body deserialises an
 * omitted field to `undefined` and an explicitly-null one to `null`, and an
 * admin form means the same thing by both: "I did not type a new password."
 *
 * NOTE THE ABSENCE OF `.trim()`. A whitespace-only submission counts as a real
 * value, and a secret is stored byte-for-byte. Normalising a secret's bytes is
 * not this service's call: the caller may legitimately hold a token whose
 * surrounding whitespace is significant, and silently altering it produces an
 * authentication failure with no visible cause. Trimming user input is a
 * presentation-layer decision, made where the form is.
 */
function isBlankSecret(
  secret: string | null | undefined,
): secret is null | undefined | '' {
  return secret === undefined || secret === null || secret === '';
}

@Injectable()
export class CredentialsService {
  private readonly logger = new Logger(CredentialsService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ---------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------

  /**
   * SERVER-SIDE ONLY. RETURNS PLAINTEXT. NEVER CALL THIS FROM A CONTROLLER.
   *
   * The only method in the store that yields a decrypted value. Use it at the
   * moment of use — opening an SMTP connection, signing a webhook — and let it
   * go out of scope immediately. Do not cache it on an instance field, do not
   * put it in a DTO, do not log it, and do not pass it to an error constructor.
   *
   * For anything a user will see, use {@link describe} or {@link list}, which
   * return a type that cannot hold a secret at all.
   *
   * @returns the plaintext, or `null` if no credential exists at this address.
   * @throws if the credential exists but cannot be decrypted (see below).
   */
  async getSecret(purpose: string, name: string): Promise<string | null> {
    this.assertAddress(purpose, name);

    const row = await this.prisma.credential.findUnique({
      where: { purpose_name: { purpose, name } },
      select: { secret: true },
    });

    if (!row) {
      // A missing credential is "not configured", not an error. The consumer
      // decides what that means — #109 falls back to "email is not set up"
      // rather than crashing a request path.
      return null;
    }

    try {
      // The store's address and the cipher's sub-key domain are THE SAME
      // STRING, by construction rather than by convention. That coupling is
      // deliberate: it makes #114's domain separation impossible to get wrong
      // here, because there is no second variable to keep in sync. A row under
      // purpose 'smtp' can only ever be read with the 'smtp' sub-key, so a
      // ciphertext lifted into another purpose's row — by a SQL write, or by a
      // bug copying rows — fails authentication instead of decrypting into a
      // context where it means something else.
      return decryptSecret(row.secret, purpose);
    } catch {
      // Swallow the original error rather than chaining it as `cause`.
      //
      // The global HttpExceptionFilter logs `exception.stack` for any 5xx and,
      // outside production, copies it into the response body. Whatever is
      // thrown here therefore reaches both the log pipeline and possibly a
      // client, so it carries the address and nothing else. secret-cipher
      // already promises a flat error with no key material in it; not
      // forwarding it is the second layer.
      //
      // An HttpException (rather than a bare Error) specifically to stay out
      // of that stack-in-the-response-body branch of the filter, which only
      // fires for non-HttpException errors.
      //
      // THROWING, NOT RETURNING NULL: a credential that exists but will not
      // decrypt means the encryption key changed or a row was tampered with.
      // Reporting that as "not configured" would let a key rotation quietly
      // disable email, which is precisely the silent failure epic #108 exists
      // to avoid. Per the epic, key loss means the credential must be
      // re-entered — and that has to be visible.
      this.logger.error(
        `Failed to decrypt credential "${purpose}/${name}": the payload is corrupt or SECRETS_ENCRYPTION_KEY has changed. The credential must be re-entered.`,
      );

      throw new InternalServerErrorException(
        `Credential "${purpose}/${name}" could not be decrypted. It must be set again.`,
      );
    }
  }

  /**
   * Presentation read for a single credential: metadata and a masked hint.
   *
   * Safe to serialise into an API response. `CredentialInfo` has no field
   * capable of holding a secret, and the ciphertext is not even fetched.
   *
   * @returns the info, or `null` if nothing is stored at this address.
   */
  async describe(purpose: string, name: string): Promise<CredentialInfo | null> {
    this.assertAddress(purpose, name);

    const row = await this.prisma.credential.findUnique({
      where: { purpose_name: { purpose, name } },
      select: CREDENTIAL_INFO_SELECT,
    });

    return row ? this.toInfo(row) : null;
  }

  /**
   * Presentation read for every credential under one purpose, ordered by name
   * so an admin list is stable across renders.
   *
   * Scoped to a purpose rather than offering an unscoped "all credentials":
   * an admin screen is always about one thing ("SMTP"), and a global listing
   * is the shape that grows a "show me everything" endpoint.
   */
  async list(purpose: string): Promise<CredentialInfo[]> {
    this.assertIdentifier(purpose, 'purpose');

    const rows = await this.prisma.credential.findMany({
      where: { purpose },
      select: CREDENTIAL_INFO_SELECT,
      orderBy: { name: 'asc' },
    });

    return rows.map((row) => this.toInfo(row));
  }

  // ---------------------------------------------------------------------------
  // Writes
  // ---------------------------------------------------------------------------

  /**
   * Create or update the credential at `(purpose, name)`.
   *
   * BLANK PRESERVES. `undefined`, `null`, or `''` for `secret` means "the admin
   * did not retype the password", so the stored ciphertext and its hint are
   * left exactly as they are while any metadata in `meta` is still applied.
   * Getting this backwards destroys a working configuration the first time
   * somebody edits an unrelated field on the same form — which is exactly how
   * it happens, because the form always renders that field empty.
   *
   * There is no way to erase a secret through this method. That is
   * {@link deleteSecret}, deliberately separate.
   *
   * `hint` is derived here from the plaintext; callers do not supply it.
   *
   * @throws BadRequestException if a blank secret is written to an address
   *         that does not exist yet (see the first-write note inline).
   */
  async setSecret(
    purpose: string,
    name: string,
    secret: string | null | undefined,
    meta: CredentialMeta = {},
  ): Promise<void> {
    this.assertAddress(purpose, name);

    // Only the metadata keys the caller actually passed. Building this by hand
    // rather than spreading `meta` keeps an unknown property on the incoming
    // object out of the Prisma `data` — and keeps `undefined` (meaning "leave
    // it alone") from being confused with `null` (meaning "clear it").
    const metaUpdate: Prisma.CredentialUpdateInput = {};
    if (meta.label !== undefined) metaUpdate.label = meta.label;
    if (meta.updatedByUserId !== undefined) {
      metaUpdate.updatedByUser = meta.updatedByUserId
        ? { connect: { id: meta.updatedByUserId } }
        : { disconnect: true };
    }

    // A type guard rather than a plain boolean, so the else-branch narrows
    // `secret` to `string` on its own. No cast, no second copy of the
    // definition of "blank" that could drift away from the one above.
    if (isBlankSecret(secret)) {
      await this.applyMetadataOnly(purpose, name, metaUpdate);
      return;
    }

    const encrypted = encryptSecret(secret, purpose);
    const hint = deriveHint(secret);

    await this.prisma.credential.upsert({
      where: { purpose_name: { purpose, name } },
      create: {
        purpose,
        name,
        secret: encrypted,
        hint,
        label: meta.label ?? null,
        ...(meta.updatedByUserId
          ? { updatedByUser: { connect: { id: meta.updatedByUserId } } }
          : {}),
      },
      update: {
        secret: encrypted,
        hint,
        ...metaUpdate,
      },
    });

    // Address only. `secret`, `encrypted`, and `hint` must never appear in a
    // log line — see invariant 1 in the header.
    this.logger.log(`Stored credential "${purpose}/${name}"`);
  }

  /**
   * Remove the credential at `(purpose, name)`.
   *
   * The ONLY way to erase a secret, and separate from {@link setSecret} so
   * that destroying a credential is always something a caller asked for by
   * name. An admin UI reaches this from a distinct control, not by clearing a
   * field and saving.
   *
   * Idempotent: deleting an absent credential is a no-op, not a 404. The
   * caller's goal is "there is no credential here", and that goal is already
   * met — a double-clicked delete button should not produce an error toast.
   */
  async deleteSecret(purpose: string, name: string): Promise<void> {
    this.assertAddress(purpose, name);

    // deleteMany, not delete: `delete` throws P2025 when the row is absent,
    // which would have to be caught and discarded here anyway to get the
    // idempotency above.
    const { count } = await this.prisma.credential.deleteMany({
      where: { purpose, name },
    });

    if (count > 0) {
      this.logger.log(`Deleted credential "${purpose}/${name}"`);
    }
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /**
   * The blank-secret branch of {@link setSecret}: apply metadata, keep the
   * stored ciphertext and hint untouched.
   */
  private async applyMetadataOnly(
    purpose: string,
    name: string,
    metaUpdate: Prisma.CredentialUpdateInput,
  ): Promise<void> {
    // FIRST-WRITE CASE — blank secret, no existing row. This is an ERROR, not
    // a no-op and not an empty credential.
    //
    // Treating it as a no-op is worse: the admin's form reports success, the
    // UI shows a configured-looking credential that does not exist, and the
    // failure surfaces later and elsewhere as "SMTP is not configured" — far
    // from the action that caused it, with nothing in the audit trail.
    //
    // Creating the row with an empty secret is worse still: `describe` would
    // then report a credential that exists, and the consumer would try to
    // authenticate with an empty password against a live server.
    //
    // So: refuse, loudly and immediately, at the moment the admin is looking
    // at the form. "Blank preserves" is a statement about an EXISTING value;
    // with nothing stored there is nothing to preserve, and the only honest
    // answer is that a new credential needs a secret. BadRequestException
    // because this is a caller/operator input problem (400), not a fault.
    const existing = await this.prisma.credential.findUnique({
      where: { purpose_name: { purpose, name } },
      select: { id: true },
    });

    if (!existing) {
      // Address only — no hint of what was submitted.
      throw new BadRequestException(
        `Cannot create credential "${purpose}/${name}" without a secret. A blank value preserves an existing secret, but there is none stored at this address yet.`,
      );
    }

    // Nothing to change: a blank secret and no metadata is a request to leave
    // the credential exactly as it is. Return without writing, so `updatedAt`
    // keeps meaning "when this credential last changed" rather than "when a
    // form was last submitted".
    if (Object.keys(metaUpdate).length === 0) {
      return;
    }

    await this.prisma.credential.update({
      where: { id: existing.id },
      // `secret` and `hint` are absent from this object, which is what
      // preserves them. Do not add them here: everything reaching this branch
      // has, by definition, no new plaintext to encrypt or hint.
      data: metaUpdate,
    });

    this.logger.log(
      `Updated metadata for credential "${purpose}/${name}" (secret preserved)`,
    );
  }

  /**
   * Build a `CredentialInfo` field by field.
   *
   * Explicitly, NEVER by spreading the row. A spread makes the response shape
   * a consequence of whatever the query happened to select, so a later edit
   * that adds `secret: true` to a select — or swaps in a plain `findUnique`
   * with no select at all — would silently start serialising the ciphertext.
   * Naming the fields means the response shape is decided here, once, in code
   * that is about the response shape. The parameter is typed as
   * `CredentialInfo` rather than as the Prisma row for the same reason: a row
   * arriving with extra columns is narrowed on the way in.
   */
  private toInfo(row: CredentialInfo): CredentialInfo {
    return {
      purpose: row.purpose,
      name: row.name,
      hint: row.hint,
      label: row.label,
      updatedByUserId: row.updatedByUserId,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  /**
   * Reject an unusable address component.
   *
   * Runtime checks despite the `string` types because a config value, a JSON
   * round-trip, or a plain-JS caller can all deliver something else.
   *
   * WHITESPACE IS REJECTED RATHER THAN TRIMMED, and `purpose` is the reason:
   * it is also the cipher's sub-key domain, so `'smtp '` and `'smtp'` derive
   * two different keys. Silently trimming would let a row written under one
   * spelling become permanently unreadable under the other, with both looking
   * identical in a log. `name` is held to the same rule so the two halves of
   * the address behave the same way. These are code-level constants, not user
   * input; there is nothing legitimate to normalise.
   */
  private assertIdentifier(value: string, field: 'purpose' | 'name'): void {
    if (typeof value !== 'string' || value.length === 0) {
      throw new BadRequestException(
        `Credential ${field} must be a non-empty string.`,
      );
    }

    if (value !== value.trim()) {
      throw new BadRequestException(
        `Credential ${field} must not have leading or trailing whitespace.`,
      );
    }
  }

  private assertAddress(purpose: string, name: string): void {
    this.assertIdentifier(purpose, 'purpose');
    this.assertIdentifier(name, 'name');
  }
}
