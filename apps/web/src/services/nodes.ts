/**
 * The worker fleet's API, as the web app sees it (issue #271, epic #254).
 *
 * ONE MODULE FOR SIX ROUTES ACROSS TWO CONTROLLERS, shaped exactly like
 * `services/jobs.ts` (#266): `services/api.ts` stays the transport — the
 * `ApiService` instance, the refresh dance, the maintenance recogniser — and
 * an epic's own surface gets a module where its calls sit next to the types
 * they produce. Everything below still goes through the shared `api` client,
 * so a fleet request inherits the token refresh, the 401 retry and the
 * maintenance interception like every other call in the app.
 *
 * =============================================================================
 * THE ROUTES ARE ON TWO DIFFERENT PREFIXES, AND THAT IS NOT AN ACCIDENT
 * =============================================================================
 *
 * Five of them are under `/api/admin/nodes`; creating a credential is under
 * `/api/node-credentials`. It would be tidier to pretend otherwise and wrap a
 * single `nodes/…` path family, and it would be wrong:
 *
 *   `JwtAuthGuard` admits a `nod_` worker credential on `/api/nodes` and
 *   nothing else (#267). `admin/nodes` is deliberately OUTSIDE that allowlist
 *   because those routes publish other operators' email addresses and delete
 *   other people's nodes; `node-credentials` is deliberately outside it too,
 *   because a worker token that could reach its own minting endpoint could
 *   grow a replacement for the one you just revoked.
 *
 * So the prefixes below are copied from `nodes-admin.controller.ts` and
 * `node-credential.controller.ts` verbatim. A path "corrected" here to look
 * consistent is a path that either 404s or — worse, if `/api/nodes/...` were
 * ever the guess — moves an admin action inside the worker-token blast radius.
 *
 * =============================================================================
 * THE TYPES ARE MIRRORS OF `apps/api/src/nodes/dto/`, NOT AN INVENTION
 * =============================================================================
 *
 *   `NodeOwner`             → `NodeOwnerDto`                       (node-admin.dto.ts)
 *   `NodeJobCounts`         → `NodeJobCountsDto`                   (node-admin.dto.ts)
 *   `WorkerNode`            → `AdminNodeDto`                       (node-admin.dto.ts)
 *   `NodeCredential`        → `AdminNodeCredentialDto`             (node-admin.dto.ts)
 *   `NodeCredentialCreated` → `NodeCredentialCreatedResponseDto`   (node-credential-response.dto.ts)
 *   `CreateNodeCredentialInput` → `createNodeCredentialSchema`     (create-node-credential.dto.ts)
 *
 * Two of those mirrorings are load-bearing rather than clerical:
 *
 *  1. `NodeCredential` HAS NO `token` FIELD, and not even an optional one. The
 *     API's own DTO pair makes the show-once contract a matter of types rather
 *     than of everyone remembering it — the raw token exists on the create
 *     response and nowhere else — and a `token?: string` here would hand that
 *     guarantee back, because the first component to write
 *     `credential.token ?? '—'` compiles fine and quietly asks for a value the
 *     server can never produce.
 *
 *  2. `expiresAt` IS `string | null` AND `null` IS A REAL ANSWER, not a
 *     missing value. A worker runs unattended for months, so "never expires,
 *     until revoked" is the intended default (`prisma/schema.prisma` above
 *     `NodeCredential.expiresAt` writes out why). A UI that renders `null` as
 *     "unknown" or defaults it to a date would misreport the single most
 *     important property of a long-lived credential.
 *
 * =============================================================================
 * `health` IS SERVER-DERIVED. THERE IS NO CLIENT-SIDE RECOMPUTE HERE.
 * =============================================================================
 *
 * `deriveNodeHealth` (`node-lifecycle.service.ts`) compares `lastHeartbeatAt`
 * against the `nodes.staleHeartbeatSeconds` SYSTEM SETTING, which this app
 * does not read and must not guess. A helper in this module that turned a
 * timestamp into `healthy | stale` would be a second policy: it would use a
 * constant somebody picked here, it would disagree with the API the moment an
 * administrator changed the setting, and it would disagree with the fleet
 * sweep that actually marks nodes offline. So `WorkerNode.health` is
 * transported, and `pages/Admin/workersTable.tsx` only ever chooses a colour
 * for the word it was handed. Deliberately no `deriveHealth()` export below.
 */

import { api } from './api';

// =============================================================================
// Enumerations — the API's own, restated so a bad value cannot compile
// =============================================================================

/**
 * `AdminNodeDto.status` — OPERATOR state, not liveness.
 *
 *   `online`   — registered and accepting claims.
 *   `draining` — finishing what it holds, claiming nothing new.
 *   `offline`  — deregistered gracefully, or swept there after it went quiet.
 *   `disabled` — administratively refused; its claims are rejected.
 */
export const NODE_STATUSES = ['online', 'draining', 'offline', 'disabled'] as const;
export type NodeStatus = (typeof NODE_STATUSES)[number];

/**
 * `AdminNodeDto.health` — DERIVED liveness, computed at read time and never
 * stored.
 *
 * Read ALONGSIDE `status`, never instead of it. The two answer different
 * questions and routinely disagree on purpose: a `disabled` node that is still
 * heartbeating is both disabled and `healthy`, and a node whose process was
 * killed reads `online`/`stale` until the sweep moves it to `offline`.
 */
export const NODE_HEALTHS = ['healthy', 'stale', 'offline'] as const;
export type NodeHealth = (typeof NODE_HEALTHS)[number];

/** Upper bound on `expiresInDays`, from `MAX_NODE_CREDENTIAL_DAYS`. */
export const MAX_NODE_CREDENTIAL_DAYS = 3650;

/** `name` length ceiling, from `createNodeCredentialSchema`. */
export const MAX_NODE_CREDENTIAL_NAME_LENGTH = 100;

// =============================================================================
// Response shapes
// =============================================================================

/** Who registered a node or minted a credential (`NodeOwnerDto`). */
export interface NodeOwner {
  id: string;
  email: string;
  /** The account's display name, when it has one. */
  name: string | null;
}

/**
 * How many jobs a node holds in each state (`NodeJobCountsDto`).
 *
 * Every key is always present and always a number, zero included — the API
 * guarantees it precisely so no call site writes `counts.running ?? 0`, whose
 * first omission renders an empty cell for a node with no running jobs,
 * indistinguishable from a count that failed to load.
 *
 * `pending` is the API's name for what an operator calls CLAIMED: assigned to
 * this node and not yet started.
 */
export interface NodeJobCounts {
  running: number;
  pending: number;
  succeeded: number;
  failed: number;
  total: number;
}

/** One node as `GET /api/admin/nodes` returns it (`AdminNodeDto`). */
export interface WorkerNode {
  id: string;
  /** Operator-chosen, unique per owner. */
  name: string;
  hostname: string;
  /** Self-reported, e.g. `linux-x64`. */
  platform: string;
  cliVersion: string;
  /** The job types this node declared it can run. May be empty. */
  eligibleTypes: string[];
  concurrency: number;
  status: NodeStatus;
  /** Server-derived — see the module header on why nothing here recomputes it. */
  health: NodeHealth;
  /** The node's last self-reported capability summary. Opaque to this app. */
  capabilities: unknown;
  registeredAt: string;
  /** `null` when the node has never sent one — which reads as `stale`. */
  lastHeartbeatAt: string | null;
  owner: NodeOwner;
  jobCounts: NodeJobCounts;
}

/**
 * One credential as `GET /api/admin/nodes/credentials` returns it
 * (`AdminNodeCredentialDto`).
 *
 * NO `token`, and no `tokenHash` either — see the module header for why the
 * absence is the type doing work rather than a field somebody forgot.
 * Revoked credentials ARE included, carrying `revokedAt`: a revoked token is
 * part of the audit trail, which is the whole reason this list exists.
 */
export interface NodeCredential {
  id: string;
  name: string;
  /** Non-secret display prefix, e.g. `nod_1a2b`. */
  tokenPrefix: string;
  /** `null` means NEVER EXPIRES — a supported, expected answer. */
  expiresAt: string | null;
  /** `null` means it has never authenticated. */
  lastUsedAt: string | null;
  createdAt: string;
  /** `null` while the credential is still live. */
  revokedAt: string | null;
  owner: NodeOwner;
}

/**
 * The response to `POST /api/node-credentials` — THE ONLY SHAPE IN THIS APP
 * THAT CARRIES `token`.
 *
 * The server stores a sha256 hash and cannot produce the raw value again, so
 * whatever renders this is the last chance the operator has to copy it. That
 * is a UI obligation (`NodeCredentialRevealDialog`), and it starts here: this
 * is deliberately a DIFFERENT type from `NodeCredential` rather than the same
 * one with an optional field.
 */
export interface NodeCredentialCreated {
  token: string;
  id: string;
  name: string;
  tokenPrefix: string;
  expiresAt: string | null;
  createdAt: string;
}

// =============================================================================
// Requests
// =============================================================================

/**
 * The body `POST /api/node-credentials` accepts (`createNodeCredentialSchema`).
 *
 * `expiresInDays` is OPTIONAL, and omitting it is a real choice meaning "never
 * expires" — not an unset value for something else to fill in. It is also a
 * RELATIVE duration rather than an absolute timestamp, because the server
 * interprets it against the same clock `validateToken` later compares against;
 * a caller-supplied `expiresAt` would silently encode this browser's idea of
 * "now", and a machine with a skewed clock could mint a credential that is
 * already expired.
 */
export interface CreateNodeCredentialInput {
  name: string;
  expiresInDays?: number;
}

// =============================================================================
// The fleet — `/api/admin/nodes`
// =============================================================================

/**
 * The whole fleet, with derived health and per-node job counts.
 *
 * UNPAGINATED, because the endpoint is: it returns every node in one response,
 * ordered by name, with the counts coming from a single grouped query whatever
 * the fleet size — which is what makes it safe to poll. There is therefore no
 * page to ask for and no `sortBy` to send, and `workersTable.tsx` declares no
 * `sortable` or server-`filterable` column to match.
 */
export async function getWorkerNodes(): Promise<WorkerNode[]> {
  return api.get<WorkerNode[]>('/admin/nodes');
}

/**
 * One node, in the same shape the list returns.
 *
 * Health is computed by the same function against the same policy as the list,
 * so this read and that one can never disagree about whether a node is stale.
 */
export async function getWorkerNode(id: string): Promise<WorkerNode> {
  return api.get<WorkerNode>(`/admin/nodes/${id}`);
}

/**
 * Forget a node.
 *
 * JOBS ARE NOT DELETED. The API clears `claimedByNodeId` and leaves every job
 * row exactly as it was, so work this node was running is picked up by the
 * lease reaper and requeued (or failed on its normal attempt budget) rather
 * than lost. That sentence is not decoration: it is the difference between an
 * operator deleting a dead node and an operator believing they are about to
 * destroy in-flight work, so `WorkersPage` puts it in the confirmation.
 *
 * Deleting a node does NOT revoke its credential — the same token can register
 * a new node — which is why the credentials section sits on the same page.
 */
export async function deleteWorkerNode(id: string): Promise<void> {
  await api.delete<void>(`/admin/nodes/${id}`);
}

// =============================================================================
// Credentials — a read on `/api/admin/nodes`, a write on `/api/node-credentials`
// =============================================================================

/**
 * Every `nod_` credential in the deployment, with its owner, newest first.
 *
 * The admin AUDIT view, and a different route from the one that creates a
 * credential (see the module header). Masked: no raw token, no stored hash.
 */
export async function getNodeCredentials(): Promise<NodeCredential[]> {
  return api.get<NodeCredential[]>('/admin/nodes/credentials');
}

/**
 * Mint a credential, and receive the raw token EXACTLY ONCE.
 *
 * `expiresInDays` is omitted from the body when absent rather than sent as
 * `undefined` or `null`: the schema's field is optional, and its ABSENCE is
 * what the server reads as "no expiry". Sending an explicit null would be a
 * different request — a validation failure — expressing the same intent.
 */
export async function createNodeCredential(
  input: CreateNodeCredentialInput,
): Promise<NodeCredentialCreated> {
  const body: CreateNodeCredentialInput = { name: input.name };
  if (input.expiresInDays !== undefined) body.expiresInDays = input.expiresInDays;
  return api.post<NodeCredentialCreated>('/node-credentials', body);
}

/**
 * Revoke any credential, whoever owns it.
 *
 * TAKES EFFECT ON THE NODE'S NEXT REQUEST — the guard re-reads `revokedAt` on
 * every authentication, so there is no cache and no TTL to wait out. This is
 * the incident-response action the whole section exists for, which is why it
 * is one click from the fleet table rather than a page away.
 *
 * One-way: `revokedAt` is stamped once and never cleared, and revoking an
 * already-revoked credential answers 404 rather than succeeding silently, so
 * two administrators racing each other are told the state moved under them.
 */
export async function revokeNodeCredential(id: string): Promise<void> {
  await api.delete<void>(`/admin/nodes/credentials/${id}`);
}

// =============================================================================
// Shared predicates
// =============================================================================

/**
 * Whether a credential can still authenticate a node right now.
 *
 * A MIRROR of `validateToken`'s two checks (`node-credential.service.ts`), not
 * an independent policy, and it exists so the list, the row action and the
 * status chip agree: revoked wins, then expiry, and a `null` expiry is not an
 * expiry at all. Exported from the service module rather than the table module
 * because it is about what the API will accept, exactly as `isJobActionable`
 * is in `services/jobs.ts`.
 */
export type NodeCredentialStatus = 'active' | 'expired' | 'revoked';

export function nodeCredentialStatus(
  credential: Pick<NodeCredential, 'expiresAt' | 'revokedAt'>,
  now: Date = new Date(),
): NodeCredentialStatus {
  if (credential.revokedAt) return 'revoked';
  // `null` is "never expires", so it must be checked BEFORE the comparison:
  // `new Date(null)` is the epoch, which would read as expired in 1970 and
  // mark every unattended worker credential dead.
  if (credential.expiresAt && new Date(credential.expiresAt).getTime() <= now.getTime()) {
    return 'expired';
  }
  return 'active';
}
