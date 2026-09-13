// =============================================================================
// What `GET admin/db-backup/node-credential-preflight` answers with
// (issue #350, epic #345)
// =============================================================================
//
// ONE QUESTION: can this deployment hand a worker node a short-lived,
// SELECT-only credential to its own database, so that a `db.backup.run` job can
// be executed somewhere other than the API process?
//
// -----------------------------------------------------------------------------
// ⚠ `guided` IS A 200, AND INVENTING A STATUS CODE FOR IT WOULD BE THE BUG
// -----------------------------------------------------------------------------
//
// This is the third place in this subsystem to make the same argument, and it
// is the same argument every time (`db-backup.controller.ts`'s header for the
// restore pair; `docs/specs/database-restore.md` for the `CREATEDB` gate):
// managed PostgreSQL withholding `CREATEROLE` from an application role is the
// ORDINARY configuration, not a fault. A 4xx here would tell an administrator
// their platform is unsupported when it is not, and a 5xx would tell them
// something is broken when nothing is. What is true is smaller and more useful:
// node offload needs two lines of SQL they have not run, and if they choose not
// to run them the API keeps taking its own backups exactly as before.
//
// So the STATUS is always 200 and the ANSWER is `outcome`, with the SQL in
// `guidance.commands` — real role names, ready to paste. A block with a
// placeholder in it is not a deliverable, it is homework.
//
// -----------------------------------------------------------------------------
// WHY `brokerEnabled` IS A SEPARATE FIELD FROM `outcome`
// -----------------------------------------------------------------------------
//
// They are different facts and conflating them would be actively misleading.
// `outcome` is a CAPABILITY — whether this deployment's database role CAN mint.
// `brokerEnabled` is a POLICY — whether an administrator has decided its fleet
// is inside the trust boundary (`nodes.jobSecretBrokerEnabled`, default OFF).
//
// An operator can face any combination, and each needs a different next step: a
// capable deployment with the policy off is one toggle away; an enabled policy
// on a role without `CREATEROLE` needs the `GRANT` below and nothing else; both
// off need both. Folding them into one verdict would send half of those people
// to the wrong screen.
// =============================================================================

import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/** The two normal answers. There is deliberately no third, and no error one. */
export const NODE_CREDENTIAL_PREFLIGHT_OUTCOMES = ['ok', 'guided'] as const;

export const guidedJobRoleInstructionsSchema = z.object({
  /** What sent the operator here, in one sentence. Matches `detail`. */
  reason: z.string(),

  /**
   * A complete SQL block with this deployment's real role name in it.
   *
   * Two options rather than one, because they are different trades and not a
   * preference: `ALTER ROLE ... CREATEROLE` is one statement, and a dedicated
   * `NOINHERIT CREATEROLE` minter role is the least-privilege answer. See
   * `buildCreateRoleGrantCommands` in `pg-job-role.broker.ts`.
   */
  commands: z.string(),

  /** Repository-relative path to the runbook that explains the block. */
  runbook: z.string(),
});

export const nodeCredentialPreflightSchema = z.object({
  /**
   * `ok` — a credential can be minted right now.
   * `guided` — it cannot, and `guidance.commands` is what fixes that.
   *
   * ⚠ NEITHER IS AN ERROR. See this file's header.
   */
  outcome: z.enum(NODE_CREDENTIAL_PREFLIGHT_OUTCOMES),

  /**
   * The credential kind this deployment would issue, e.g. `postgres.readonly`.
   *
   * The same string recorded on every `job_node_secrets` row, so an operator
   * reading a grant and an operator reading this page are looking at one name.
   */
  kind: z.string(),

  /** The role this API connects to PostgreSQL as — the one that would mint. */
  databaseRole: z.string(),

  /** The database a node would be given read access to. */
  targetDatabase: z.string(),

  /**
   * Whether an administrator has switched brokering on
   * (`nodes.jobSecretBrokerEnabled`).
   *
   * A POLICY, not a capability — see this file's header for why it is not
   * folded into `outcome`. `false` is the shipped default and means no node is
   * offered a job of a type that needs a credential, whatever this deployment
   * is capable of.
   */
  brokerEnabled: z.boolean(),

  /** One or two sentences an operator can act on, matched to `outcome`. */
  detail: z.string(),

  /** Present exactly when `outcome` is `guided`. */
  guidance: guidedJobRoleInstructionsSchema.nullable(),
});

export class NodeCredentialPreflightDto extends createZodDto(nodeCredentialPreflightSchema) {}

export type NodeCredentialPreflight = z.infer<typeof nodeCredentialPreflightSchema>;
