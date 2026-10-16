// =============================================================================
// The base categories' user-data hooks (issue #80, split by #460)
// =============================================================================
//
// `files`, `credentials` and `onboarding`: the counts and the destructive steps
// that stay in the user-data module. Their declarations are `user-data.base.ts`,
// which is kept light for the manifest; these classes are provided by
// `UserDataModule` under the tokens exported there.
// =============================================================================

import { Injectable, Logger } from '@nestjs/common';

import { AiUserKeysPurger } from '../platform/ai/ai-user-keys.purger';
import { PrismaService } from '../prisma/prisma.service';
import { UserSettingsService } from '@marinoscar/platform-api/settings';
import { ObjectsService } from '@marinoscar/platform-api/storage';
import { KvoxManagedObjectsService } from '../kvox-objects/kvox-managed-objects.service';
import {
  auditUserData,
  describe,
  USER_DATA_PURGE_BATCH,
  USER_DATA_PURGE_MAX_BATCHES,
} from './user-data.support';

// =============================================================================
// files — unmanaged storage objects
// =============================================================================

@Injectable()
export class FilesUserDataHooks {
  private readonly logger = new Logger(FilesUserDataHooks.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly objects: ObjectsService,
    private readonly managedObjects: KvoxManagedObjectsService,
  ) {}

  /** `files` in `GET /api/user-data/summary`. */
  async summarize(userId: string): Promise<{ count: number; bytes: string }> {
    // `kvoxOwnership: null` is "no module owns it" -- the whole definition of
    // "a file" here, see below.
    const files = await this.managedObjects.summarize({ uploadedById: userId, kvoxOwnership: null });

    // ⚠ `managed_by IS NULL` IS THE WHOLE DEFINITION OF "a file" HERE. A
      // transcript's source audio and a note's rendered export are also rows
      // this user uploaded, and they belong to the transcript and the note —
    // deleting them under `files` would gut content the user did not ask to
    // touch. Issue #21 built `managed_by` for exactly this distinction and
    // the generic storage endpoints already draw the same line.
    return {
      count: files.count,
      bytes: files.bytes.toString(),
    };
  }

  // ===========================================================================
  // Step 5 — unmanaged storage objects
  // ===========================================================================

  /**
   * Delete the caller's plain uploads: bytes and row, through `ObjectsService`.
   *
   * ⚠ `kvoxOwnership: null` (no `kvox_object_ownership` row) IS PART OF THE
   * QUERY, not a check after the fact. A transcript's source audio, a note's
   * rendered export and every other module-owned object are ownership-stamped
   * precisely so they can only be removed by the module that understands them
   * (issue #21), and their bytes are already on their way out through the purge
   * jobs steps 2 and 3 queued. The platform's `ObjectsService.delete` does NOT
   * refuse a managed object (the 409 is a request hook on the generic route),
   * so this filter is the only thing that keeps a live transcript's audio safe.
   *
   * `ObjectsService.delete` is used because it is the one implementation of
   * "remove an object's bytes, its row, its chunks and write the audit event".
   */
  async purge(userId: string): Promise<void> {
    let deleted = 0;
    const failed = new Set<string>();
    const orgId = await this.managedObjects.resolveOrg();

    for (let batch = 0; batch < USER_DATA_PURGE_MAX_BATCHES; batch += 1) {
      const rows = await this.managedObjects.findMany({
        where: {
          uploadedById: userId,
          kvoxOwnership: null,
          ...(failed.size > 0 ? { id: { notIn: [...failed] } } : {}),
        },
        select: { id: true },
        orderBy: { id: 'asc' },
        take: USER_DATA_PURGE_BATCH,
      });

      if (rows.length === 0) {
        if (deleted > 0 || failed.size > 0) {
          await auditUserData(this.prisma, userId, 'user_data:files_deleted', {
            count: deleted,
            failed: failed.size,
          });
        }

        this.logger.log(
          `User ${userId}: ${deleted} unmanaged file(s) deleted, ${failed.size} could not be`,
        );

        return;
      }

      for (const row of rows) {
        try {
          await this.objects.delete(row.id, userId, orgId);
          deleted += 1;
        } catch (error) {
          // ⚠ RECORDED AND EXCLUDED FROM THE NEXT PAGE. An object whose bytes
          // the provider refuses to delete keeps its row, so without this the
          // same page is selected forever. Tolerating the failure rather than
          // throwing is the same choice every other step makes: one
          // unreachable file must not strand the rest of a deletion.
          failed.add(row.id);

          this.logger.warn(
            `Could not delete storage object ${row.id} for user ${userId}: ${describe(error)}`,
          );
        }
      }
    }

    throw new Error(
      `Bulk file deletion for user ${userId} did not converge after ` +
        `${USER_DATA_PURGE_MAX_BATCHES} batches`,
    );
  }
}

// =============================================================================
// credentials — `everything` only
// =============================================================================

/**
 * Revokes every active personal access token of a user.
 *
 * PLATFORM-ADOPTION-SHIM(#465): this app's own `PatService.revokeAllForUser` went
 * with the identity module, and the platform's `PatService` has no revoke-all
 * (its `revokeToken` is per token, per caller). This is the same one
 * `updateMany` the old method ran: it REVOKES (stamps `revoked_at`) rather than
 * deletes, so the audit trail of a token's existence survives. The platform's
 * user-data slice replaces it.
 */
@Injectable()
export class PatRevoker {
  private readonly logger = new Logger(PatRevoker.name);

  constructor(private readonly prisma: PrismaService) {}

  async revokeAllForUser(userId: string): Promise<number> {
    const { count } = await this.prisma.personalAccessToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    this.logger.log(`Revoked all ${count} active PAT(s) for user: ${userId}`);

    return count;
  }
}

@Injectable()
export class CredentialsUserDataHooks {
  private readonly logger = new Logger(CredentialsUserDataHooks.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly aiKeys: AiUserKeysPurger,
    private readonly pat: PatRevoker,
  ) {}

  /** `credentials` in `GET /api/user-data/summary`. */
  async summarize(userId: string): Promise<{ aiKeys: number; accessTokens: number }> {
    const [aiKeys, accessTokens] = await Promise.all([
      this.aiKeys.count(userId),
      this.prisma.personalAccessToken.count({ where: { userId, revokedAt: null } }),
    ]);

    return { aiKeys, accessTokens };
  }

  // ===========================================================================
  // Step 1 — credentials (`everything` only)
  // ===========================================================================

  /**
   * Erase every AI provider key and revoke every personal access token.
   *
   * The platform keys go through the service that owns them (`UserAiKeysService`
   * via `AiUserKeysPurger`: it deletes the row and audits it, one call per
   * provider), and the tokens through `PatRevoker` because revoking (not
   * deleting) is that decision's one home.
   */
  async purge(userId: string): Promise<void> {
    const aiKeys = await this.aiKeys.removeAll(userId);
    const tokens = await this.pat.revokeAllForUser(userId);

    await auditUserData(this.prisma, userId, 'user_data:credentials_destroyed', {
      aiKeys,
      accessTokens: tokens,
    });

    this.logger.warn(
      `User ${userId}: removed ${aiKeys} AI key(s) and revoked ${tokens} access token(s)`,
    );
  }
}

// =============================================================================
// onboarding — `everything` only, no inventory
// =============================================================================

@Injectable()
export class OnboardingUserDataHooks {
  private readonly logger = new Logger(OnboardingUserDataHooks.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly userSettings: UserSettingsService,
  ) {}

  // ===========================================================================
  // Step 6 — onboarding state (`everything` only)
  // ===========================================================================

  /**
   * Forget that this user has ever been onboarded.
   *
   * ⚠ IT CLEARS EXACTLY ONE NAMESPACE, AND THAT IS THE WHOLE CONTRACT.
   * `theme`, `profile`, `navigation`, `notifications` and `dataTables` are
   * untouched — the account still works, the user is still signed in looking
   * at it, and "delete my data" is not "reset my preferences". A widening of
   * this call to the whole settings row is pinned against in
   * `user-data.base.spec.ts` for exactly that reason: it would be a
   * one-word change here and an invisible, unasked-for change to the user's
   * screen.
   *
   * ⚠ IT REUSES `UserSettingsService.patchSettings` AND HAND-WRITES NO JSONB
   * EDIT. `{ onboarding: null }` is already a supported, tested operation
   * (issue #272): `onboardingPatchSchema` is `.nullable()`, `mergeOnboarding`
   * returns `undefined` for `null`, and `patchSettings` then omits the key
   * entirely rather than storing `{}`. That collapse-to-ABSENT is precisely
   * the state a wipe wants, because absent is how "never onboarded" is spelled
   * throughout epic #271 — a stored `{}` would be a PRESENT `onboarding` key
   * and would read as "onboarded, with no opinions". A second, independently
   * written namespace removal in this file is the duplication `scopeIncludes`'s
   * own header argues against, and this one would be worse than most: it would
   * have to reproduce the collapse rule from memory, and getting it wrong
   * fails silently and permanently.
   *
   * ⚠ NO `If-Match`. `patchSettings`' third argument is an optimistic
   * concurrency expectation, and this call has none to state: it is the server
   * acting on a job the user queued minutes ago, not a browser tab racing
   * another tab. Passing a version read moments earlier would turn a user who
   * happened to toggle their theme mid-deletion into a `failed` purge.
   *
   * ⚠ IT THROWS RATHER THAN SWALLOWING, unlike the notes/transcripts semantic
   * index cleanup, and the asymmetry is about POSITION rather than importance.
   * That one runs BETWEEN destructive steps, where failing would leave the user
   * with a `failed` row and no idea which half ran. This one runs last, after
   * every destructive step has completed and written its own audit row, so a
   * failure here is unambiguous: everything was deleted and the reset did not
   * happen. Reporting that honestly costs a `failed` job the user can
   * re-request — the handler is re-entrant, so the second run deletes nothing
   * and retries just this. Swallowing would cost the opposite: onboarding state
   * surviving a full wipe with nothing anywhere saying so, which is the exact
   * bug this step was added to fix.
   */
  async purge(userId: string): Promise<void> {
    await this.userSettings.patchSettings(userId, { onboarding: null });

    await auditUserData(this.prisma, userId, 'user_data:onboarding_reset', {});

    this.logger.log(
      `User ${userId}: first-run onboarding state cleared — the checklist and ` +
        `welcome surfaces will be offered again`,
    );
  }
}
