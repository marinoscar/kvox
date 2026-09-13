// =============================================================================
// NodeCredentialService — the `nod_` bearer credential (issue #267, epic #254)
// =============================================================================
//
// A worker node has to authenticate to the API before it can register,
// heartbeat, claim a job or report a result (#268). This service mints and
// validates the credential it does that with.
//
// It is modelled DELIBERATELY CLOSELY on `pat/pat.service.ts` — same
// `randomBytes(32).toString('hex')` entropy, same sha256-at-rest, same short
// display prefix, same show-the-raw-value-exactly-once contract, same
// fire-and-forget `lastUsedAt` stamp. Where the two differ, the difference is
// load-bearing and is written out at the point it appears. Reading the two
// side by side should make every divergence obvious; anything that looks the
// same IS the same, on purpose.
//
// -----------------------------------------------------------------------------
// WHY THIS EXISTS AT ALL, RATHER THAN REUSING A PAT
// -----------------------------------------------------------------------------
//
// The tempting answer is "a node is just another automated client, give it a
// PAT". That answer is wrong, and it is wrong in a way that only shows up
// after a leak.
//
// A PAT carries its owner's FULL AUTHORITY. `JwtAuthGuard` resolves a `pat_`
// token to the owning `AuthenticatedUser` and hands it to `RolesGuard` and
// `PermissionsGuard` exactly as the JWT strategy would, and
// `test/auth/pat-universality.integration.spec.ts` exists specifically to
// prove that this holds on EVERY authenticated route with no narrower scope —
// that universality is a documented promise of this API, not an accident.
//
// Now consider where a node credential physically lives: a config file on a
// spare box, a container image someone else's cluster pulls, a `.env` on a
// machine nobody has patched since it was set up, read by a long-lived
// process that nobody is watching. If the credential sitting there is a PAT
// and its owner is an admin — and the owner IS an admin, because
// `nodes:write` is admin-only in `prisma/seed-data.ts` — then whoever reads
// that file owns the deployment: `PATCH /api/users/:id` to grant themselves
// a role, `PUT /api/system-settings`, the lot.
//
// So a node credential is a SEPARATE TOKEN FAMILY with its own prefix, and
// the guard confines that prefix to `/api/nodes/*` by route allowlist. The
// blast radius of a leaked worker token becomes "can pretend to be a worker",
// which is bad but bounded and observable, instead of "is an administrator".
// The allowlist lives in the guard rather than in this service; see
// `auth/guards/jwt-auth.guard.ts` and docs/specs/worker-nodes.md for why.
//
// -----------------------------------------------------------------------------
// WHAT THIS SERVICE IS NOT RESPONSIBLE FOR
// -----------------------------------------------------------------------------
//
// It does not know which routes a `nod_` token may reach. `validateToken`
// answers exactly one question — "is this string a live credential, and whose
// is it" — and returns an `AuthenticatedUser` or `null`. It has more than one
// caller by design (the guard today; #268's node control plane may well want
// to resolve a credential without an HTTP request in front of it), and a
// route allowlist buried in here would be an authorization decision made by a
// component that cannot see the route. Rejected alternative, recorded in
// docs/specs/worker-nodes.md.
// =============================================================================

import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash, randomBytes } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { CreateNodeCredentialDto } from './dto/create-node-credential.dto';

/**
 * The token family marker.
 *
 * It is a CONSTANT and not a literal typed four times because three separate
 * components have to agree on it or the security model quietly stops working:
 * this service (which mints it), `JwtAuthGuard` (which routes on it), and
 * `MaintenanceGuard.OPAQUE_BEARER_PREFIXES` (which refuses to treat it as an
 * admin bypass). A typo in any one of them is not a crash — it is a token
 * that falls through to a different branch and is handled by the wrong rules.
 */
export const NODE_TOKEN_PREFIX = 'nod_';

/** Hex characters of the random part kept in `tokenPrefix` for display. */
const DISPLAY_PREFIX_HEX_CHARS = 4;

/** One day in milliseconds — the unit `expiresInDays` is expressed in. */
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** The masked shape returned by {@link NodeCredentialService.listCredentials}. */
export interface NodeCredentialListRow {
  id: string;
  name: string;
  tokenPrefix: string;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  createdAt: Date;
  revokedAt: Date | null;
}

/**
 * {@link NodeCredentialListRow} plus its owner — the shape the ADMIN listing
 * returns (#270).
 *
 * A separate interface rather than an optional `user` on the row above,
 * because the two answer different questions and are read by different
 * surfaces: `GET /node-credentials` is "my credentials", where the owner is
 * the caller and naming them is noise, and `GET /admin/nodes/credentials` is
 * "every long-lived worker token in this deployment", where whose it is IS the
 * audit. An optional field would let the admin surface silently render
 * `undefined` the day somebody reused the owner-scoped query.
 */
export interface AdminNodeCredentialRow extends NodeCredentialListRow {
  // The column on `User` is `displayName`; the admin DTO exposes it as
  // `owner.name` (see `NodesAdminService.listCredentials`, which does the
  // mapping). Renaming this back to `name` breaks the select, not the DTO.
  user: { id: string; email: string; displayName: string | null };
}

/**
 * The owner columns {@link NodeCredentialService.listAllCredentials} joins.
 *
 * Hoisted out of the inline `select` (and exported) for the same reason
 * `nodes-admin.service.ts`'s `OWNER_SELECT` is: it lets
 * `test/nodes/worker-node-model-fields.spec.ts` assert its keys are real
 * `User` scalar columns, which is the check issue #340 (a `name` column that
 * does not exist) would have failed instantly.
 */
export const CREDENTIAL_OWNER_SELECT = {
  select: { id: true, email: true, displayName: true },
} as const;

/** The show-once shape returned by {@link NodeCredentialService.createCredential}. */
export interface NodeCredentialCreated {
  token: string;
  id: string;
  name: string;
  tokenPrefix: string;
  expiresAt: string | null;
  createdAt: string;
}

@Injectable()
export class NodeCredentialService {
  private readonly logger = new Logger(NodeCredentialService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Hashes a raw token the one way this service ever hashes one.
   *
   * A single private helper rather than an inlined `createHash(...)` at each
   * of the two sites (mint, validate) because those two MUST agree exactly:
   * if minting and validating ever computed a different digest — a different
   * algorithm, a different encoding, a stray `.trim()` on one side — every
   * credential would mint successfully and then fail to authenticate, and the
   * symptom ("the node can't log in") points nowhere near the cause. One
   * function means the two cannot drift.
   *
   * sha256 with no salt and no key stretching, matching `PatService`. That is
   * correct HERE and would not be for a password: the preimage is 32 bytes of
   * `randomBytes` entropy, so there is no dictionary to run and no work
   * factor that would meaningfully slow an attacker who cannot guess 256 bits
   * in the first place. What the hash buys is that a database dump does not
   * hand over working credentials — and it buys that at a cost small enough
   * to run on the authentication path of every worker request.
   */
  private hash(rawToken: string): string {
    return createHash('sha256').update(rawToken).digest('hex');
  }

  /**
   * Mints a credential and returns the raw token — THE ONLY TIME IT EXISTS
   * OUTSIDE THE CALLER'S PROCESS.
   *
   * The row stores {@link hash}'s output and a short display prefix; the
   * plaintext is never written anywhere, never logged (note that the log line
   * below names the credential and its owner and NOT the token), and cannot
   * be recovered. An operator who loses it revokes and mints again — which is
   * the same amount of work as a "show it to me again" endpoint would be, but
   * without a second, permanently-reachable path to a live credential.
   */
  async createCredential(
    userId: string,
    dto: CreateNodeCredentialDto,
  ): Promise<NodeCredentialCreated> {
    // 32 bytes = 256 bits of entropy, hex-encoded to 64 characters. Identical
    // to `PatService.createToken` on purpose: this is the number that makes
    // guessing a token irrelevant as an attack, and there is no reason for
    // the two token families to have different strength.
    const hexPart = randomBytes(32).toString('hex');
    const rawToken = `${NODE_TOKEN_PREFIX}${hexPart}`;

    const tokenHash = this.hash(rawToken);

    // e.g. `nod_1a2b` — enough to tell two credentials apart in a list, far
    // too little to narrow a search of the remaining 240 bits.
    const tokenPrefix = `${NODE_TOKEN_PREFIX}${hexPart.slice(0, DISPLAY_PREFIX_HEX_CHARS)}`;

    // `undefined` → `null` in the row → "never expires". See the block
    // comment above `NodeCredential.expiresAt` in `prisma/schema.prisma`, and
    // `dto/create-node-credential.dto.ts`, for why this is a supported
    // outcome rather than a missing value. Computed from the SERVER's clock,
    // which is the clock `validateToken` later compares against.
    const expiresAt =
      dto.expiresInDays === undefined
        ? null
        : new Date(Date.now() + dto.expiresInDays * MS_PER_DAY);

    const credential = await this.prisma.nodeCredential.create({
      data: {
        userId,
        name: dto.name,
        tokenHash,
        tokenPrefix,
        expiresAt,
      },
    });

    this.logger.log(
      `Created node credential "${credential.name}" (${credential.id}) for user ${userId}` +
        `${expiresAt ? `, expiring ${expiresAt.toISOString()}` : ', no expiry'}`,
    );

    return {
      token: rawToken,
      id: credential.id,
      name: credential.name,
      tokenPrefix: credential.tokenPrefix,
      expiresAt: credential.expiresAt ? credential.expiresAt.toISOString() : null,
      createdAt: credential.createdAt.toISOString(),
    };
  }

  /**
   * Lists the caller's own credentials, masked.
   *
   * The `select` is an ALLOWLIST, not an omission of `tokenHash` from a
   * `where`-only query, and that distinction is the whole point: with an
   * explicit `select`, a column added to this model in a future migration is
   * absent from this response until somebody deliberately adds it here. With
   * a bare `findMany` it would be included the moment the migration lands,
   * silently, in a response an operator may well paste into a bug report. See
   * `NodeCredentialListItemDto` for why `tokenHash` in particular must not
   * appear.
   */
  async listCredentials(userId: string): Promise<NodeCredentialListRow[]> {
    return this.prisma.nodeCredential.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        tokenPrefix: true,
        expiresAt: true,
        lastUsedAt: true,
        createdAt: true,
        revokedAt: true,
      },
    });
  }

  /**
   * Revokes one credential, ownership-checked.
   *
   * OWNERSHIP IS PART OF THE LOOKUP (`findFirst({ where: { id, userId } })`),
   * not a check after a `findUnique`. Written the other way round, the
   * "belongs to someone else" case and the "does not exist" case would take
   * different branches — and a caller who can tell those two apart can
   * enumerate other users' credential IDs by watching which 403s become 404s.
   * Folding the owner into the query makes both cases indistinguishable from
   * outside, because they are literally the same code path.
   *
   * Revoking an already-revoked credential is a 404 rather than a silent
   * success, matching `PatService.revokeToken`: an operator who is racing
   * another admin — or a script running twice — should be told the state
   * changed under them, not handed a 204 that implies they did something.
   * Either way the credential ends up revoked, and `revokedAt` keeps the
   * FIRST revocation's timestamp, which is the one that actually cut the node
   * off.
   */
  async revokeCredential(userId: string, credentialId: string): Promise<void> {
    return this.revokeMatching({ id: credentialId, userId }, `user ${userId}`);
  }

  /**
   * Lists EVERY credential in the deployment with its owner, masked (#270).
   *
   * The admin half of `listCredentials` above, and it exists because a
   * `NodeCredential` has no mandatory expiry (see the model's own comment):
   * the only thing that ever cuts a worker token off is somebody revoking it,
   * and somebody can only revoke what they can see. An administrator who can
   * see their own credentials and not the fleet's has no way to answer "which
   * long-lived tokens can reach this API", which is the question the whole
   * `nod_` design leans on being answerable.
   *
   * The `select` is an ALLOWLIST for exactly the reason `listCredentials`
   * gives — a column added by a future migration must not appear here until
   * somebody adds it deliberately — and `tokenHash` is absent from it. That
   * matters MORE on this surface than on the owner-scoped one: this response
   * carries every credential in the deployment at once, so a hash leaked here
   * is an offline verification oracle for the entire fleet.
   *
   * Not paginated. This is bounded by how many worker machines an operator
   * runs, which is a number they chose and can see; a page cursor over a list
   * an admin is scanning for anomalies would hide the anomaly on page two.
   */
  async listAllCredentials(): Promise<AdminNodeCredentialRow[]> {
    return this.prisma.nodeCredential.findMany({
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        tokenPrefix: true,
        expiresAt: true,
        lastUsedAt: true,
        createdAt: true,
        revokedAt: true,
        user: CREDENTIAL_OWNER_SELECT,
      },
    });
  }

  /**
   * Revokes ANY credential, whoever owns it (#270).
   *
   * The ownership half of the `where` is dropped, and nothing else changes —
   * both paths go through `revokeMatching` so revocation stays ONE piece of
   * code with one definition of "already revoked" and one place that stamps
   * `revokedAt`. A second hand-written revoke for admins is how the two
   * acquire different semantics for the second call.
   *
   * The enumeration argument that shapes the owner-scoped path does NOT apply
   * here: an administrator is allowed to know which credential ids exist, so
   * "not found" being distinguishable from "someone else's" costs nothing.
   * The 404 shape is kept anyway, because the caller cannot tell them apart
   * either way and one message is easier to test than two.
   */
  async revokeAnyCredential(credentialId: string): Promise<void> {
    return this.revokeMatching({ id: credentialId }, 'an administrator');
  }

  /**
   * The one revocation, with the caller's scope folded into the lookup.
   *
   * OWNERSHIP IS PART OF THE `where` rather than a check after a `findUnique`
   * — see `revokeCredential`'s doc comment for the enumeration oracle that
   * prevents. `actor` is only ever a log string; it is never a second place
   * authorization is decided.
   */
  private async revokeMatching(
    where: Prisma.NodeCredentialWhereInput,
    actor: string,
  ): Promise<void> {
    const credential = await this.prisma.nodeCredential.findFirst({ where });

    if (!credential) {
      throw new NotFoundException('Node credential not found');
    }

    if (credential.revokedAt !== null) {
      throw new NotFoundException('Node credential already revoked');
    }

    await this.prisma.nodeCredential.update({
      where: { id: credential.id },
      data: { revokedAt: new Date() },
    });

    this.logger.log(
      `Revoked node credential "${credential.name}" (${credential.id}) for ${actor}`,
    );
  }

  /**
   * Resolves a raw `nod_…` token to its owning user, or `null`.
   *
   * `null` FOR EVERY FAILURE, WITH NO DETAIL. Unknown hash, revoked,
   * expired, inactive owner — all four return the same thing, and the caller
   * (`JwtAuthGuard`) turns all four into the same 401 with the same message.
   * Distinguishing them would tell an attacker holding a stolen token whether
   * it was ever real, which is exactly the fact they are trying to establish.
   *
   * THE ORDER OF THE FOUR CHECKS IS NOT SIGNIFICANT TO SECURITY — they all
   * produce the same answer — but it IS significant that all four exist, so
   * each is written as its own statement with its own reason rather than
   * being collapsed into one clever `where` clause. A compound `where` that
   * returns `null` cannot be debugged, and cannot be unit-tested one
   * condition at a time.
   */
  async validateToken(rawToken: string): Promise<AuthenticatedUser | null> {
    const tokenHash = this.hash(rawToken);

    // Looked up BY HASH, never by prefix or id. `tokenHash` is `@unique`, so
    // this is a single index probe regardless of how many credentials exist —
    // which matters because this runs on every authenticated worker request.
    const credential = await this.prisma.nodeCredential.findUnique({
      where: { tokenHash },
      include: {
        user: {
          include: {
            userRoles: {
              include: {
                role: {
                  include: {
                    rolePermissions: {
                      include: { permission: true },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });

    // Unknown token. Also covers a token from a deleted user: the row went
    // with the account (`onDelete: Cascade`), so there is nothing to find.
    if (!credential) {
      return null;
    }

    // Revoked. This is the PRIMARY control for a node credential — see the
    // `expiresAt` block comment in `prisma/schema.prisma` — and it is
    // deliberately checked against the row on every request rather than
    // cached anywhere, so revocation takes effect on the node's very next
    // call and not at the end of some TTL.
    if (credential.revokedAt !== null) {
      return null;
    }

    // Expired — but ONLY when an expiry was set. `expiresAt === null` means
    // "never expires" and MUST NOT be treated as "expired at the epoch"; that
    // inversion is the single most damaging bug this method could contain,
    // because it would take an entire fleet offline at once while every row
    // still looked perfectly healthy in the database. Comparison is `<=` so a
    // credential is dead at its stated instant, not one millisecond after.
    if (credential.expiresAt !== null && credential.expiresAt <= new Date()) {
      return null;
    }

    // A deactivated human must not keep authenticating through a machine they
    // set up. Checked here — and not left to a downstream guard — for the
    // same reason `PatService` checks it: this method is the point at which a
    // string becomes an identity, and an identity that should not exist must
    // not be minted in the first place.
    if (!credential.user.isActive) {
      return null;
    }

    // FIRE AND FORGET, AND THAT IS THE POINT. `lastUsedAt` is operator
    // telemetry ("is this node still alive, is this credential safe to
    // revoke"), not an authorization input, so it must never be able to fail
    // an authentication that has already succeeded, and must never add its
    // write latency to the worker's request. The `.catch(() => {})` is
    // load-bearing: without it a rejected promise here becomes an
    // unhandled rejection that can take the process down, on the one code
    // path that runs for every single worker request.
    this.prisma.nodeCredential
      .update({ where: { id: credential.id }, data: { lastUsedAt: new Date() } })
      .catch(() => {});

    return credential.user as AuthenticatedUser;
  }
}
