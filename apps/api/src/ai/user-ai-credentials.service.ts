import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { decryptSecret, encryptSecret } from '../common/crypto/secret-cipher';
import { PrismaService } from '../prisma/prisma.service';
import { AI_CREDENTIAL_PURPOSE } from './ai-credential.constants';
import { AiProviderRegistry } from './ai-provider.registry';
import { AiSettingsService } from './ai-settings.service';
import {
  createProviderContext,
  type AiConnectionTest,
} from './providers/ai-provider.interface';

// =============================================================================
// UserAiCredentialsService (issue #47, epic #45)
// =============================================================================
//
// The one place a USER'S OWN AI provider key is written, read and erased. Epic
// #45 is strict BYO — no deployment key, no fallback, no shared spend — so this
// service is the entire credential story for the feature, and everything that
// makes `CredentialsService` safe has to be true here too:
//
//   1. NO PLAINTEXT EGRESS. `getSecret` (plaintext, server-side only) and
//      `describe`/`list` (presentation) are different methods returning
//      different types. `AiCredentialStatus` HAS NO FIELD ABLE TO CARRY A
//      SECRET, and the queries behind it do not select the `secret` column at
//      all — so for an ordinary read the ciphertext never leaves Postgres.
//      Nothing in this file may interpolate a secret into a log line or an
//      error message; the only variables permitted in either are the user id
//      and the provider id.
//
//   2. BLANK PRESERVES. A settings form renders the key box EMPTY, because the
//      stored value is unreadable by design. An empty submission therefore
//      means "I did not retype my key" and can NEVER mean "erase it" — erasing
//      is `remove()`, reached from `DELETE /api/ai-credentials/:provider` and a
//      distinct control. The value is stored BYTE-FOR-BYTE as submitted: no
//      `.trim()`, no normalisation. Silently altering a credential produces an
//      authentication failure with no visible cause.
//
// -----------------------------------------------------------------------------
// WHY THIS IS NOT `CredentialsService` WITH A COMPOSITE NAME
// -----------------------------------------------------------------------------
//
// `credentials` is keyed `(purpose, name)` with NO foreign key to `users`, and
// cannot grow one — it exists to hold secrets that belong to the DEPLOYMENT
// (`Credential.updatedByUserId` is `SetNull` precisely so offboarding an
// administrator does not delete a working SMTP configuration). A per-user key
// stored there as `name: 'openai:<userId>'` would therefore outlive its owner's
// account forever, with no enumeration path short of string-parsing every row.
// `user_ai_credentials.user_id` cascades. That is the whole argument, and it is
// why this service reimplements the small parts of `CredentialsService` it
// needs (the hint derivation, the blank-preserves rule) rather than borrowing a
// table whose lifetime model is wrong.
//
// THE CIPHER IS NOT REIMPLEMENTED. `encryptSecret`/`decryptSecret` are used
// unchanged, under a new `purpose` (`AI_CREDENTIAL_PURPOSE`) — zero new
// cryptography, and domain separation from every other secret this application
// stores.
// =============================================================================

const HINT_MASK = '••••';

/**
 * Number of trailing characters revealed in a hint.
 *
 * FOUR, and the floor below, are copied deliberately from
 * `CredentialsService`: four is enough to tell two API keys apart in a list,
 * which is the entire job of a hint, and more is not a better hint — it is a
 * worse secret. Two independent masking rules for two credential stores would
 * be two independent decisions about how much of a secret it is acceptable to
 * show.
 */
const HINT_REVEALED_CHARS = 4;

/** Below this length, reveal nothing. See `CredentialsService.deriveHint`. */
const HINT_MIN_LENGTH_TO_REVEAL = 8;

/**
 * Derive the non-secret display hint from the plaintext.
 *
 * Called only from the write path, where this service already holds the
 * plaintext for encryption, so it adds no new exposure — which is also why
 * callers cannot supply a hint and get it wrong.
 *
 * Iterates code points rather than UTF-16 units, matching `CredentialsService`:
 * `'…'.slice(-4)` can cut a surrogate pair in half and leave a lone surrogate,
 * which is not valid UTF-8 and fails on the way into a Postgres `text` column —
 * so a key with an emoji in it would make saving fail with a completely
 * unrelated error.
 */
function deriveHint(plaintext: string): string {
  const codePoints = Array.from(plaintext);

  if (codePoints.length < HINT_MIN_LENGTH_TO_REVEAL) {
    return HINT_MASK;
  }

  return `${HINT_MASK}${codePoints.slice(-HINT_REVEALED_CHARS).join('')}`;
}

/**
 * Is this submission "I did not retype the key"?
 *
 * Mirrors `CredentialsService`'s own definition exactly, including the ABSENCE
 * of `.trim()`. See invariant 2 in the header.
 */
function isBlankSecret(value: string | null | undefined): boolean {
  return value === undefined || value === null || value === '';
}

/**
 * The masked view of one stored key, as every read endpoint returns it.
 *
 * ⚠ EVERY FIELD IS NON-SECRET BY CONSTRUCTION, and there is deliberately no
 * field able to hold key material. `hint` is the mask derived above by code
 * that already had the plaintext; nothing in this module can widen it.
 */
export interface AiCredentialStatus {
  /** Which registered provider this key is for. */
  provider: string;
  /** Always true for a row that exists; present so a client can render a list
   *  of every registered provider with a `configured` flag per row. */
  configured: boolean;
  /** The mask, e.g. `••••a1b2`. Null when nothing is stored. */
  hint: string | null;
  /** The user's own label for this key ("work", "personal"). Non-secret. */
  label: string | null;
  /** When the key was last used for a generation or a successful probe. */
  lastUsedAt: Date | null;
  updatedAt: Date | null;
}

/** `PUT /api/ai-credentials` after validation. `apiKey` is WRITE-ONLY. */
export interface SaveAiCredentialInput {
  provider: string;
  /** The key. Blank/absent preserves the stored one — see invariant 2. */
  apiKey?: string | null;
  /** An optional non-secret label. `null` clears it; absent leaves it alone. */
  label?: string | null;
}

/** `POST /api/ai-credentials/test` after validation. */
export interface TestAiCredentialInput {
  provider: string;
  /** The UNSAVED key to probe. Absent falls back to the stored one. */
  apiKey?: string | null;
}

/**
 * The `select` used by every presentation read.
 *
 * ⚠ `secret` IS ABSENT, AND THAT IS THE MECHANISM, not a nicety: with this
 * projection the ciphertext is never even transferred out of Postgres for a
 * read that has no business decrypting it. Adding `secret: true` here would
 * quietly put encrypted key material on the path to a response serialiser.
 */
const STATUS_SELECT = {
  provider: true,
  hint: true,
  label: true,
  lastUsedAt: true,
  updatedAt: true,
} as const;

@Injectable()
export class UserAiCredentialsService {
  private readonly logger = new Logger(UserAiCredentialsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: AiProviderRegistry,
    private readonly settings: AiSettingsService,
  ) {}

  // ---------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------

  /**
   * Every key THIS user has stored, masked.
   *
   * SCOPED BY `userId` IN THE QUERY ITSELF, never filtered afterwards: the
   * caller's id comes from the JWT and is the only thing that decides which
   * rows exist for this request, so there is no route by which one user's
   * listing can contain another's row.
   */
  async list(userId: string): Promise<AiCredentialStatus[]> {
    const rows = await this.prisma.userAiCredential.findMany({
      where: { userId },
      select: STATUS_SELECT,
      orderBy: { provider: 'asc' },
    });

    return rows.map((row) => ({
      provider: row.provider,
      configured: true,
      hint: row.hint,
      label: row.label,
      lastUsedAt: row.lastUsedAt,
      updatedAt: row.updatedAt,
    }));
  }

  /**
   * Does this user have a key for this provider?
   *
   * ⚠ `select: { id: true }`, NEVER `getSecret`. This is the question
   * `GET /api/ai/config`'s `keyConfigured` answers on an ordinary user request,
   * and a path that decrypts a credential to answer a capability question is a
   * path one careless `return` away from publishing it. Same discipline
   * `TranscriptionConfigService` states for using `describe` over `getSecret`.
   */
  async hasKey(userId: string, provider: string): Promise<boolean> {
    const row = await this.prisma.userAiCredential.findUnique({
      where: { userId_provider: { userId, provider } },
      select: { id: true },
    });

    return row !== null;
  }

  /**
   * The PLAINTEXT key, for the one caller that needs it: the code about to make
   * an outbound request on this user's behalf.
   *
   * ⚠ THE RESULT MUST BE HANDED STRAIGHT TO `createProviderContext` AND
   * DROPPED. Do not store it on an instance field, do not put it in a job
   * payload, do not log it, do not return it from anything with an HTTP route
   * above it. Returns `null` — never throws — when the user has no key, because
   * "this user has not set one up" is the normal state of every account on the
   * day AI is enabled and is reported as `keyConfigured: false`, not as an
   * error.
   */
  async getSecret(userId: string, provider: string): Promise<string | null> {
    const row = await this.prisma.userAiCredential.findUnique({
      where: { userId_provider: { userId, provider } },
      select: { secret: true },
    });

    if (!row) return null;

    // A decrypt failure here means the payload is corrupt, was encrypted under
    // a different purpose, or `SECRETS_ENCRYPTION_KEY` has changed. The message
    // `decryptSecret` throws already says all three and carries nothing derived
    // from the key; it is deliberately not caught and softened into `null`,
    // because "you have no key" and "your key cannot be read" need different
    // fixes and only one of them is the user's.
    return decryptSecret(row.secret, AI_CREDENTIAL_PURPOSE);
  }

  /**
   * Record that a key was used. Fire-and-forget provenance for the settings
   * page, never something this application acts on.
   *
   * SWALLOWS ITS OWN FAILURE on purpose: this is called from the generation
   * path immediately after a successful provider call, and failing a completed
   * generation because a timestamp write lost a race would be an absurd trade.
   */
  async markUsed(userId: string, provider: string): Promise<void> {
    try {
      await this.prisma.userAiCredential.update({
        where: { userId_provider: { userId, provider } },
        data: { lastUsedAt: new Date() },
      });
    } catch {
      this.logger.debug(
        `Could not record last-used for user ${userId}'s "${provider}" key; ignoring.`,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Writes
  // ---------------------------------------------------------------------------

  /**
   * Save or replace THIS user's key for one provider.
   *
   * AN UPSERT ON `(userId, provider)`, which is the unique constraint itself —
   * never a `findFirst` followed by a create, which cannot close the race two
   * concurrent saves from the same account would open (two browser tabs is
   * enough).
   *
   * ⚠ THE KEY IS ENCRYPTED BEFORE IT IS WRITTEN AND IS NEVER RETURNED. What
   * comes back is `AiCredentialStatus`, which has no field able to carry it.
   *
   * BLANK PRESERVES (invariant 2), with one deliberate refinement over
   * `CredentialsService.setSecret`: a blank submission against an address that
   * holds NOTHING YET is a 400 here rather than a silent no-op, because unlike
   * an admin settings PUT — where a blank key field rides along with a dozen
   * unrelated settings — this endpoint's entire purpose is the key. A blank one
   * with nothing stored is a user who pressed Save on an empty form, and
   * telling them so is more useful than a 200 that changed nothing.
   */
  async save(input: SaveAiCredentialInput, userId: string): Promise<AiCredentialStatus> {
    const provider = this.requireProvider(input.provider);

    const existing = await this.prisma.userAiCredential.findUnique({
      where: { userId_provider: { userId, provider: provider.id } },
      select: { id: true },
    });

    const keySubmitted = !isBlankSecret(input.apiKey);

    if (!keySubmitted && !existing) {
      throw new BadRequestException(
        `No API key was supplied and none is stored for "${provider.id}". Paste your key and try again.`,
      );
    }

    const label = input.label === undefined ? undefined : input.label;

    if (keySubmitted) {
      // Passed to the cipher UNTOUCHED — see invariant 2 on why there is no
      // `.trim()` anywhere on this path.
      const raw = input.apiKey as string;

      await this.prisma.userAiCredential.upsert({
        where: { userId_provider: { userId, provider: provider.id } },
        create: {
          userId,
          provider: provider.id,
          secret: encryptSecret(raw, AI_CREDENTIAL_PURPOSE),
          hint: deriveHint(raw),
          label: label ?? null,
        },
        update: {
          secret: encryptSecret(raw, AI_CREDENTIAL_PURPOSE),
          hint: deriveHint(raw),
          ...(label === undefined ? {} : { label }),
        },
      });
    } else if (label !== undefined) {
      // Label-only edit against an existing row. The stored ciphertext and its
      // hint are untouched, which is the whole of what "blank preserves" means.
      await this.prisma.userAiCredential.update({
        where: { userId_provider: { userId, provider: provider.id } },
        data: { label },
      });
    }

    await this.audit(
      userId,
      existing ? 'ai_credential:replace' : 'ai_credential:create',
      provider.id,
      {
        provider: provider.id,
        // WHETHER the key changed, never what it changed to. That is the fact
        // an audit trail needs — "who rotated their AI credential, and when" —
        // and it is the whole of what can safely be recorded.
        apiKeyChanged: keySubmitted,
        labelChanged: label !== undefined,
      },
    );

    // userId and provider only. Never the key, never the hint: application logs
    // are shipped, indexed and retained far more widely than the audit table.
    this.logger.log(
      `User ${userId} ${existing ? 'replaced' : 'saved'} an AI key for "${provider.id}"`,
    );

    return this.describe(userId, provider.id);
  }

  /**
   * Erase THIS user's key for one provider.
   *
   * The ONLY path that destroys a key — separate from `save` so that destroying
   * a credential is always something a caller asked for by name, exactly as
   * `TranscriptionSettingsService.removeCredential` is.
   *
   * SCOPED BY `userId` IN THE `where` ITSELF. A delete that matched on
   * `provider` alone and then checked ownership afterwards would be one refactor
   * away from deleting somebody else's key; here there is no such row to match.
   *
   * IDEMPOTENT: removing a key that is not there succeeds, because the caller's
   * goal is "there is no key here" and a double-clicked button should not
   * produce an error.
   */
  async remove(userId: string, providerId: string): Promise<void> {
    const provider = this.requireProvider(providerId);

    const { count } = await this.prisma.userAiCredential.deleteMany({
      where: { userId, provider: provider.id },
    });

    // Audited even when nothing was deleted — "this user asked for their key to
    // be gone" is the event, and a reader of the trail should not have to infer
    // that a no-op delete never happened.
    await this.audit(userId, 'ai_credential:delete', provider.id, {
      provider: provider.id,
      existed: count > 0,
    });

    this.logger.log(
      `User ${userId} removed their AI key for "${provider.id}" (existed: ${count > 0})`,
    );
  }

  /**
   * Erase EVERY key this user has stored, whatever provider it names.
   *
   * ⚠ EXISTS BECAUSE `remove` CANNOT DO THIS, not as a convenience wrapper over
   * it. `remove` starts with `requireProvider`, which throws for a provider id
   * this build's registry no longer carries — correct for a caller naming one
   * by hand, and fatal for a bulk erase, where a row left behind by a provider
   * that was removed from the catalogue is precisely the row a user asking for
   * all their keys to be gone most needs gone. Looping `list()` × `remove()`
   * would skip exactly those rows and report success.
   *
   * IN-PROCESS ONLY — no controller reaches this. The Danger Zone
   * (`user.data.purge`, issue #80) is its one caller; erasing every key at once
   * is not an HTTP surface this application wants to own, because nothing over
   * HTTP needs it and a route that exists can be reached by mistake.
   *
   * Idempotent, and audited even at zero: "this user asked for every key to be
   * gone" is the event, the same reasoning `remove` states.
   */
  async removeAll(userId: string): Promise<number> {
    const { count } = await this.prisma.userAiCredential.deleteMany({ where: { userId } });

    await this.audit(userId, 'ai_credential:delete_all', userId, { removed: count });

    this.logger.log(`User ${userId} removed all ${count} of their AI key(s)`);

    return count;
  }

  // ---------------------------------------------------------------------------
  // Probe
  // ---------------------------------------------------------------------------

  /**
   * Probe a key — INCLUDING ONE THAT HAS NOT BEEN SAVED.
   *
   * ⚠ NEVER THROWS FOR A FAILED PROBE. It resolves `{ ok: false, detail }` and
   * the controller answers **200**, for exactly the reason
   * `POST /api/transcription-settings/test` does: A REFUSED PROBE IS A
   * SUCCESSFUL DIAGNOSIS, and it is the entire point of the call. A 4xx here
   * would make every client that checks the status code report "could not test
   * your key" for the one case the endpoint exists to report precisely.
   *
   * It throws only for a request that is malformed — an unknown provider, or no
   * key supplied and none stored — which is a different thing from a failed
   * probe and which the caller can fix without the network being involved.
   *
   * THE REQUEST'S KEY WINS over the stored one. That ordering is the workflow:
   * paste a key, press Test, learn whether it works BEFORE committing it. The
   * stored key is the fallback, which covers "is the key I saved last month
   * still valid?".
   */
  async testConnection(
    input: TestAiCredentialInput,
    userId: string,
  ): Promise<AiConnectionTest> {
    const provider = this.requireProvider(input.provider);

    const apiKey = isBlankSecret(input.apiKey)
      ? await this.getSecret(userId, provider.id)
      : (input.apiKey as string);

    if (isBlankSecret(apiKey)) {
      // Not a failed probe — there was nothing to probe with.
      throw new BadRequestException(
        `No API key for "${provider.id}": none was supplied and none is stored. Paste a key and try again.`,
      );
    }

    const policy = await this.settings.get();
    const storedBlock =
      (policy.providers as Record<string, unknown>)[provider.id] ?? {};

    const settingsParse = provider.settingsSchema.safeParse(storedBlock);

    if (!settingsParse.success) {
      // The DEPLOYMENT's configuration is unusable, not the user's key. A 400
      // naming the fields, so the sentence a user is shown can say this is for
      // an administrator to fix.
      throw new BadRequestException(
        `This deployment's configuration for provider "${provider.id}" is invalid (${settingsParse.error.issues
          .map((issue) => issue.path.join('.') || '(root)')
          .join(', ')}). An administrator must correct it before a key can be tested.`,
      );
    }

    const result = await provider.testConnection(
      // ⚠ The only place a plaintext key enters a provider context on this
      // path. Built here, passed down, dropped — never stored on an instance
      // field and never logged.
      createProviderContext(apiKey as string, settingsParse.data),
    );

    if (result.ok && isBlankSecret(input.apiKey)) {
      // A successful probe of the STORED key is a use of it, so the settings
      // page can say "last verified" without a column of its own. A probe of an
      // unsaved key touches nothing, because there is no row to touch.
      await this.markUsed(userId, provider.id);
    }

    await this.audit(userId, 'ai_credential:test', provider.id, {
      provider: provider.id,
      ok: result.ok,
      latencyMs: result.latencyMs,
      // This application's own sentence, never an echo of anything submitted.
      detail: result.detail,
      // Whether the caller supplied a key inline, which is the difference
      // between "a user proved a new key" and "a user re-checked the stored
      // one". Never the key itself.
      usedSuppliedKey: !isBlankSecret(input.apiKey),
    });

    return result;
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /** One masked status, or a 404 when this user has no key for that provider. */
  private async describe(
    userId: string,
    providerId: string,
  ): Promise<AiCredentialStatus> {
    const row = await this.prisma.userAiCredential.findUnique({
      where: { userId_provider: { userId, provider: providerId } },
      select: STATUS_SELECT,
    });

    if (!row) {
      throw new NotFoundException(
        `No API key is stored for provider "${providerId}".`,
      );
    }

    return {
      provider: row.provider,
      configured: true,
      hint: row.hint,
      label: row.label,
      lastUsedAt: row.lastUsedAt,
      updatedAt: row.updatedAt,
    };
  }

  /**
   * Resolve a provider id, or 400 naming the valid ones.
   *
   * A 400 RATHER THAN A 404: the caller named something that is not a provider
   * at all, which is a malformed request, not a missing resource. The known ids
   * are listed because the caller cannot otherwise discover them from this
   * endpoint.
   */
  private requireProvider(providerId: string) {
    const provider = this.registry.get(providerId);

    if (!provider) {
      throw new BadRequestException(
        `Unknown AI provider "${providerId}". Known providers: ${this.registry.ids().join(', ') || 'none'}.`,
      );
    }

    return provider;
  }

  /**
   * One audit row.
   *
   * `targetType: 'user_ai_credential'` and `targetId: <providerId>` rather than
   * the row's uuid, deliberately: a delete removes the row, so a trail keyed on
   * its id would point at nothing precisely for the event most worth reading
   * later. The pair `(actorUserId, targetId)` is the address that stays
   * meaningful — the same reasoning `TranscriptionSettingsService` uses when it
   * records the namespace name instead of a row id.
   *
   * ⚠ `meta` NEVER CARRIES KEY MATERIAL, not even the hint. `apiKeyChanged` is
   * a boolean on purpose.
   */
  private async audit(
    actorUserId: string,
    action: string,
    providerId: string,
    meta: Record<string, unknown>,
  ): Promise<void> {
    await this.prisma.auditEvent.create({
      data: {
        actorUserId,
        action,
        targetType: 'user_ai_credential',
        targetId: providerId,
        meta: meta as unknown as Prisma.InputJsonValue,
      },
    });
  }
}
