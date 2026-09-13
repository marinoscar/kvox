// =============================================================================
// The per-job secret broker contract (issue #349, epic #345)
// =============================================================================
//
// THE CONSTRAINT THIS FILE EXISTS TO BEND WITHOUT BREAKING: a worker node has
// no database access and no storage credentials (`docs/specs/worker-nodes.md`
// §8). Every fact it needs arrives in an HTTP response, which is why it has so
// far only been able to run PURE COMPUTE over bytes it fetched through a
// presigned URL. Epic #345 requires more than that — a `pg_dump` needs a
// database connection, and no amount of presigning produces one.
//
// The three obvious ways to give a node a credential were all rejected before
// this interface was written, and each one is worth naming because each one is
// what somebody will reach for when this seems like too much machinery:
//
//   * PUT THE PASSWORD IN THE NODE'S ENVIRONMENT (`APPCTL_*`). The node then
//     PERSISTS a durable credential to this deployment's database, on hardware
//     the deployment may not own, for as long as that machine exists. It does
//     not expire when the job ends, it is not scoped to one job, and it cannot
//     be revoked without rotating it for every other node. This is the exact
//     shape `node-data-plane.dto.ts` already rejected for storage credentials,
//     one blast radius worse.
//   * WIDEN WHAT A `nod_` TOKEN MAY REACH. A leaked worker token would then be
//     a leaked database. The whole point of the `nod_` family (§1) is that its
//     blast radius is `/api/nodes/*` and nothing else.
//   * FOLD THE CREDENTIAL INTO THE CLAIM RESPONSE. Rejected for the identical
//     reason presigned URLs are minted on demand (§18): a node claiming its
//     whole `concurrency` in one call queues that work internally, so the LAST
//     job's credential has been ageing since before the FIRST job started —
//     and the fix, a longer validity, widens exactly the window short validity
//     exists to close.
//
// So: the credential is obtained PER JOB, from the server, over an
// authenticated route, bounded by the job's own lease, held in memory only,
// and revoked on settlement. A node that is switched off holds nothing.
//
// -----------------------------------------------------------------------------
// PRESENCE IS THE DECLARATION — THE SAME RULE NODE ELIGIBILITY ALREADY USES
// -----------------------------------------------------------------------------
//
// A handler that needs a credential carries a `nodeSecretBroker`; one that does
// not carries nothing. There is no `requiresSecret` string and no flag.
//
// REJECTED: `readonly requiresSecret?: 'postgres'` on `JobHandler`, plus a
// switch in the nodes module mapping that string to a minting implementation.
// That is precisely the CENTRAL DISPATCH TABLE `job-handler.interface.ts`
// exists to abolish — its header's entire argument is that the worker's
// knowledge of a job type is "ask the registry, call the method", so a second
// table keyed on type strings reintroduces the thing a fork was promised it
// would never have to edit. Worse, it makes an inconsistent state
// representable: `requiresSecret: 'postgres'` with no `postgres` arm in the
// switch is a type that NAMES A SECRET NOBODY CAN MINT, and the failure
// surfaces on a remote machine at runtime rather than in review. Hanging the
// implementation itself off the handler makes that unrepresentable, exactly as
// deriving node eligibility from `nodeResultSchema` + `persistNodeResult`
// makes a half-eligible handler unrepresentable.
//
// -----------------------------------------------------------------------------
// ⚠ THE HANDLE IS PERSISTED. THE MATERIAL NEVER IS.
// -----------------------------------------------------------------------------
//
// `IssuedJobSecret` is split into two deliberately unequal halves. `handle` is
// an identifier for the grant (a role name, a token id) and it is the ONLY
// thing that reaches the database — `job_node_secrets` has no column capable
// of holding secret material, not plaintext and not ciphertext. `material` is
// the credential itself; it is serialised into exactly one HTTP response and
// then dropped.
//
// REJECTED: encrypting `material` and storing it, reusing
// `SECRETS_ENCRYPTION_KEY` the way the `credentials` table does. A credential
// that can be re-read is a credential that can be stolen twice, and NOTHING
// NEEDS TO RE-READ IT: the node got it once, and revocation is by handle, not
// by presenting the secret back. The `credentials` table stores material
// because an SMTP password must be replayed on every send; a job credential
// must not be replayed at all. Storing it would buy nothing and would put a
// live database password in a table, a backup, and every dump of that backup.
//
// -----------------------------------------------------------------------------
// ONE CREDENTIAL PER JOB, EVER — WHICH MAKES `issue` AN UPSERT, NOT A MINT
// -----------------------------------------------------------------------------
//
// A node asks for its secret more than once as a matter of course: a process
// restarted while holding the lease, a response lost on the way back, a retry
// of the same job by the same node. Every one of those calls must land on THE
// SAME GRANT, extended — never on a second one. `@@unique([jobId, kind])` on
// `job_node_secrets` makes "two credentials for one job" unrepresentable from
// the server's side; this interface makes the broker responsible for the other
// side, and `deriveOutputKey`'s idempotence requirement is the same rule for
// the same reason (see `job-handler.interface.ts`).
//
// A broker that minted a fresh role on every call would leak one role per
// restart into the database it is protecting, and the revocation path — which
// knows exactly ONE handle per job — would clean up exactly one of them.
// =============================================================================

import { Job } from '@prisma/client';

/**
 * Whether a broker could mint anything right now, and what to do if not.
 *
 * ASKED BEFORE MINTING, NEVER INSTEAD OF ERROR HANDLING. Its job is to turn
 * "the deployment's database user lacks CREATEROLE" — the ordinary case on
 * managed PostgreSQL — into a sentence an operator can act on, rather than
 * into whatever the driver throws three layers down at 3am on a machine the
 * operator cannot see.
 *
 * `remedy` is a separate field from `reason` on purpose: the reason goes in
 * the log and the API response, and the remedy is the part a person pastes
 * into a terminal. The same split `docs/specs/database-restore.md` makes for a
 * failed capability gate, for the same reason — a refusal that names no fix is
 * a refusal somebody works around.
 */
export type JobSecretUsability =
  | { ok: true }
  | { ok: false; reason: string; remedy: string };

/**
 * A credential minted for one job, handed over exactly once.
 *
 * ⚠ THE TWO HALVES ARE NOT EQUAL. See the file header: `handle` is persisted,
 * `material` never is, and there is no column it could go in if somebody tried.
 */
export interface IssuedJobSecret {
  /**
   * The grant's identifier — a role name, a token id, whatever `revoke` takes.
   *
   * THE ONLY PART EVER PERSISTED, and it must not be, or contain, the secret.
   * A broker that returned `"appuser:hunter2"` here would be writing a password
   * into `job_node_secrets.handle`, into every backup of it, and into every
   * log line that names a grant. If a broker's underlying system has no
   * non-secret identifier for a grant, it is not a broker this contract can
   * carry.
   */
  readonly handle: string;

  /**
   * When the credential stops working — the broker's OWN backstop.
   *
   * The server asks for a grant lasting until the job's lease expires (see
   * `until` on `issue`), and this is what the broker actually managed to set.
   * It is the last line of defence under both revocation paths: if the settle
   * event never fires AND the sweeper is switched off AND the process holding
   * the row dies, this is still what makes the credential worthless.
   */
  readonly expiresAt: Date;

  /**
   * The credential itself — whatever the node needs to connect.
   *
   * ⚠ RETURNED ONCE. NEVER STORED. NEVER LOGGED. Not at `debug`, not on an
   * error path, not "temporarily". `test/nodes/node-job-secret.integration.spec.ts`
   * asserts that across a real request, exactly as the data-plane spec does for
   * presigned URLs, because "nothing logs it" is a property of the whole
   * pipeline — interceptor, transform, filter — and not of any one service.
   *
   * `Record<string, unknown>` rather than a typed shape because the shape is
   * the BROKER's business and the node's: a PostgreSQL broker returns a DSN,
   * something else returns a token and an endpoint, and the server in between
   * has no reason to understand either. It is passed through, never inspected.
   */
  readonly material: Record<string, unknown>;
}

/**
 * Mints, and un-mints, the one credential a job type's remote executor needs.
 *
 * IMPLEMENTED BY THE FEATURE THAT OWNS THE JOB TYPE, and hung off that type's
 * `JobHandler` — see the file header for why this is not a string plus a
 * central switch. #349 ships this contract with NO BROKER REGISTERED anywhere
 * in the template, deliberately: the mechanism is reviewable on its own, and
 * until a broker exists nothing can issue anything, whatever the settings say.
 */
export interface JobSecretBroker {
  /**
   * What KIND of credential this broker mints, e.g. `'postgres.readonly'`.
   *
   * Dotted, lowercase and product-neutral like a `Job.type`, and PERMANENT
   * once grants of that kind exist: it is half of `job_node_secrets`'
   * `@@unique([jobId, kind])` and it is how the revocation paths find their way
   * back to the broker that minted a row. Renaming it strands every live grant
   * — the sweeper would find rows whose kind matches no registered broker and
   * could only log about them.
   */
  readonly kind: string;

  /**
   * Can this broker mint at all, in this deployment, right now?
   *
   * Called before every issue. Cheap by contract — a privilege check, a
   * reachability probe — because it is on the request path of a node that is
   * waiting to start work.
   *
   * ⚠ IT MUST NOT CREATE, DROP OR RENAME ANYTHING. This is the same rule
   * `docs/specs/database-restore.md` states for a restore pre-flight, and it
   * matters here for the same reason: asking "could you mint one?" is not
   * asking for one, and a probe with side effects turns every refused request
   * into a half-made grant nobody recorded.
   */
  usable(): Promise<JobSecretUsability>;

  /**
   * Mint the credential for `job`, valid no later than `until`.
   *
   * ⚠ IDEMPOTENT PER JOB — the file header's "one credential per job, ever".
   * Called again for a job that already has a live grant, this must EXTEND
   * that grant and return the SAME `handle`, never mint a second one. A broker
   * that cannot extend should return the existing grant's handle with fresh
   * material rather than creating a sibling.
   *
   * `until` is the JOB'S LEASE EXPIRY, not a duration of the broker's
   * choosing: the node is already renewing that lease (#347), so the
   * credential rides a clock that is being maintained for other reasons and
   * that stops the instant the node stops. There is deliberately no second
   * clock to disagree with it. A broker may grant LESS (its own backend may
   * cap a grant's life) and reports what it managed in `expiresAt`; it must
   * not grant more.
   *
   * Throwing fails the request — the node gets no credential and cannot start
   * the work, which is the correct outcome for a credential that could not be
   * made. It does not settle the job.
   */
  issue(job: Job, until: Date): Promise<IssuedJobSecret>;

  /**
   * Destroy the grant named by `handle`.
   *
   * ⚠ MUST BE IDEMPOTENT AND MUST TOLERATE A HANDLE THAT IS ALREADY GONE.
   * Two independent paths call it (`@OnEvent(JOB_SETTLED_EVENT)` and the
   * sweeper — see `node-secret-broker.service.ts` for why they are not
   * redundant), they can race, and the sweeper will meet handles whose backing
   * grant expired on its own hours ago. "Already revoked" is a SUCCESS, not an
   * error: a broker that throws on it turns the fast path's normal outcome
   * into a logged failure and teaches everyone to ignore that log.
   *
   * Throwing is still permitted for a real failure (the backend is
   * unreachable). The caller never lets it escape — both revocation paths
   * swallow and log — and the row stays unrevoked so the next sweep retries.
   */
  revoke(handle: string): Promise<void>;
}
