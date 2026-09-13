// =============================================================================
// The restore and rollback wire contract (issue #286, epic #254)
// =============================================================================
//
// ⚠ THIS IS THE ONE PLACE IN THIS APPLICATION WHERE A MIS-FIRED OR RETRIED
// REQUEST IS AN OUTAGE RATHER THAN A DUPLICATE ROW. Every other POST in this
// API, sent twice, costs at worst a wasted row: a second backup is refused by
// the single-active index, a second job is a second job, a second broadcast is
// embarrassing. A second restore replaces the production database. So the
// request body is shaped to be IMPOSSIBLE TO RECONSTRUCT BY ACCIDENT, and that
// is what the two `confirmation` literals below are for.
//
// -----------------------------------------------------------------------------
// WHY A TYPED LITERAL AND NOT `confirm: true`
// -----------------------------------------------------------------------------
//
// ⚠ REJECTED: `{ "confirm": true }`. It is the obvious shape and it is worth
// naming so it is not proposed again. A boolean is reproduced by:
//
//   - a browser or proxy replaying a POST it believes idempotent;
//   - a `curl` line copied out of a runbook, a terminal history or a chat;
//   - a client library retrying on a socket timeout — which is exactly when a
//     restore is in flight and answering slowly;
//   - a double-click on a button whose first response has not arrived.
//
// In all four the body is `{"confirm":true}` and the server cannot tell the
// second request from the first. `{"confirmation":"RESTORE"}` is reproduced by
// none of them ACCIDENTALLY — it can still be replayed deliberately, which is
// the point: a replay of this body is a decision somebody made, and a request
// that carries the wrong word (or no word) is refused with a 400 having started
// NOTHING. Not a 409, not a queued attempt, not a partially-run pre-flight.
//
// The two words differ (`RESTORE` and `ROLLBACK`) so that a body copied from
// one route to the other is refused too. They are UPPERCASE and matched
// exactly: a case-insensitive compare would accept `restore`, which is a word
// somebody types by habit.
//
// -----------------------------------------------------------------------------
// THREE NORMAL OUTCOMES PER ROUTE, KEYED BY `mode` — AND `mode` IS THE ANSWER,
// NOT THE STATUS CODE
// -----------------------------------------------------------------------------
//
// Both routes answer `200` on every one of their three outcomes, and the
// discriminator is the `mode` field. This is the same contract
// `CancelBackupResultDto` states for its `outcome`, and it is forced by the
// same fact: THE HONEST ANSWER HAS MORE THAN ONE SHAPE AND A STATUS CODE CANNOT
// CARRY THE DIFFERENCE.
//
// ⚠ `guided` IS NOT AN ERROR STATUS, and this is the single most important
// decision in this file. A `guided` result means a CAPABILITY gate failed —
// nearly always `CREATEDB`, which managed PostgreSQL routinely denies — and the
// body carries a complete, paste-ready command block plus a runbook link so the
// operator can perform the same restore by hand with a superuser. Answering
// `4xx` would tell them, in the middle of an incident, that their platform is
// unsupported. It is not: it is a platform this design PLANNED for. See
// `docs/specs/database-restore.md` §3.
//
// `blocked` is likewise a 200: the schema gate found a migration mismatch, and
// the caller's next move is to re-send with `overrideSchemaCheck: true`. That
// is an answer, not a failure.
//
// What IS an error is anything that means the request could not be answered at
// all: no such run (404), a run that is not a restorable archive (400), a
// missing or wrong confirmation (400), and another restore already in flight
// (409). See the controller for that mapping and why it lives there.
//
// -----------------------------------------------------------------------------
// ⚠ `overrideSchemaCheck` UNBLOCKS EXACTLY ONE GATE
// -----------------------------------------------------------------------------
//
// It clears the SCHEMA COMPATIBILITY gate and nothing else. It can never
// unblock a capability gate, and the difference is not a policy choice:
//
//   - A schema mismatch is a JUDGEMENT. "This archive predates two migrations;
//     I accept that and will run `prisma migrate deploy` afterwards" is a
//     sentence an operator is entitled to say.
//   - A capability failure is a STATEMENT OF FACT. No amount of accepting makes
//     a role without `CREATEDB` able to create a database. An override that
//     silenced it would not enable a restore; it would start one that fails at
//     `CREATE DATABASE`, having already downloaded the archive.
//
// There is an explicit negative test for that, in both the colocated service
// spec and the integration spec.
//
// -----------------------------------------------------------------------------
// THE FIELD NAME IS PUBLISHED BY THE PRE-FLIGHT, NOT INVENTED HERE
// -----------------------------------------------------------------------------
//
// A `blocked` body carries `block.overrideParameter`, whose whole purpose is to
// tell the client WHICH REQUEST FIELD to set. It must therefore be this DTO's
// field name, so `restore-preflight.service.ts` exports
// {@link RESTORE_SCHEMA_OVERRIDE_FIELD} and this file ties its schema to it —
// once at compile time ({@link RestoreOverrideFieldIsReal}) and once at run time
// in the spec. The two cannot drift into naming different things.
// =============================================================================

import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import {
  RESTORE_GATE_IDS,
  RESTORE_SCHEMA_OVERRIDE_FIELD,
  type RestorePreflightResult,
} from '../restore-preflight.service';
import type { RestoreRollbackResult, StartRestoreResult } from '../database-restore.service';

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

/** The word `POST runs/:id/restore` requires. See this file's header. */
export const RESTORE_CONFIRMATION = 'RESTORE';

/** The word `POST runs/:id/rollback` requires. Deliberately not the same word. */
export const ROLLBACK_CONFIRMATION = 'ROLLBACK';

export const startRestoreRequestSchema = z.object({
  /**
   * The literal string `RESTORE`.
   *
   * ⚠ THE SAFETY FEATURE OF THIS ENDPOINT. A missing, empty, misspelt or
   * lower-case value is a `400` and STARTS NOTHING — not the pre-flight, not a
   * download, not a row. See this file's header for why a boolean was rejected.
   */
  confirmation: z.literal(RESTORE_CONFIRMATION),

  /**
   * Accepts a schema-compatibility mismatch and proceeds anyway.
   *
   * ⚠ IT UNBLOCKS THE SCHEMA GATE AND NOTHING ELSE. It is not a force flag and
   * must never become one — see this file's header. Set it only after reading
   * the `blocked` body that asked for it: that body names the archive's
   * migration and the live one, which is the comparison the decision rests on.
   *
   * Optional, defaulting to `false`, so an ordinary restore body is exactly
   * `{ "confirmation": "RESTORE" }`.
   */
  overrideSchemaCheck: z.boolean().optional().default(false),
});

export class StartRestoreRequestDto extends createZodDto(startRestoreRequestSchema) {}

/** The parsed body, after the global pipe has applied the default. */
export type StartRestoreRequest = z.output<typeof startRestoreRequestSchema>;

/**
 * Compile-time proof that the field the pre-flight NAMES is a field this DTO
 * HAS.
 *
 * Resolves to `never` — and so fails to compile at its use site below — if
 * `RESTORE_SCHEMA_OVERRIDE_FIELD` is ever changed to something
 * {@link startRestoreRequestSchema} does not accept. Without it, a rename on
 * either side would produce a `blocked` response telling the client to set a
 * parameter the API rejects, which is the most frustrating possible failure:
 * the server has told you exactly what to do and refuses when you do it.
 */
export type RestoreOverrideFieldIsReal =
  typeof RESTORE_SCHEMA_OVERRIDE_FIELD extends keyof StartRestoreRequest
    ? true
    : { error: 'The pre-flight names an override parameter this DTO does not accept' };

/**
 * Fails to compile if the tie above is broken. No runtime form, so it costs
 * nothing at import time.
 *
 * The false branch is an OBJECT rather than `never` on purpose: `never extends
 * true` is `true`, so a `never` false-branch would make this assertion pass in
 * exactly the case it exists to catch.
 */
type AssertTrue<T extends true> = T;
export type RestoreOverrideFieldTie = AssertTrue<RestoreOverrideFieldIsReal>;

export const rollbackRestoreRequestSchema = z.object({
  /**
   * The literal string `ROLLBACK`.
   *
   * A DIFFERENT WORD FROM THE RESTORE ROUTE'S, on purpose: a body copied from
   * one route to the other is refused rather than silently accepted. In
   * `pre_restore_dump` mode a rollback IS a multi-hour restore, so confusing
   * the two is not a harmless mistake.
   */
  confirmation: z.literal(ROLLBACK_CONFIRMATION),
});

export class RollbackRestoreRequestDto extends createZodDto(rollbackRestoreRequestSchema) {}

export type RollbackRestoreRequest = z.output<typeof rollbackRestoreRequestSchema>;

// ---------------------------------------------------------------------------
// The pre-flight verdict, on the wire
// ---------------------------------------------------------------------------

/**
 * One gate's finding.
 *
 * ⚠ EVERY GATE APPEARS, INCLUDING THE ONES THAT PASSED. An operator about to
 * replace their production database is entitled to see WHAT WAS CHECKED, not
 * only what failed — a list containing only failures gives no way to tell
 * "checked, fine" from "never ran". #287's dialog renders the whole list.
 */
export const restoreGateSchema = z.object({
  id: z.enum(RESTORE_GATE_IDS),

  /**
   * What kind of problem this gate reports, which is what decides how a failure
   * is handled — and therefore whether `overrideSchemaCheck` can do anything
   * about it. Only `overridable` can.
   */
  kind: z.enum(['capability', 'disk', 'replicas', 'overridable']),

  /** `warning` is a pass that says something; it does not stop a restore. */
  verdict: z.enum(['pass', 'warning', 'block']),

  /** Short label, safe to render as a row heading. */
  title: z.string(),

  /** What was found, in one or two sentences an operator can act on. */
  detail: z.string(),

  /**
   * What to DO about it, or `null` when there is nothing to do.
   *
   * Per-gate rather than one message on the result: a `guided` outcome
   * routinely has two or three findings with different remedies, and flattening
   * them into one string is how an operator fixes the first and is surprised by
   * the second.
   */
  action: z.string().nullable(),
});

/** What the restore's rollback story will be, after pre-flight has had its say. */
export const restoreRollbackPlanSchema = z.object({
  /** What `databaseBackup.restoreRollbackMode` stores. */
  configured: z.enum(['retain_database', 'drop_database']),

  /**
   * What will actually happen, which is what the rollback route's `mode` will
   * report.
   *
   * `pre_restore_dump` is what `drop_database` MEANS once you ask what the way
   * back is. Naming the effective mode after the thing that RECOVERS you rather
   * than the thing that is destroyed is what makes the downgrade message
   * honest.
   */
  effective: z.enum(['retain_database', 'pre_restore_dump']),

  /** `true` when disk pressure changed the answer. */
  downgraded: z.boolean(),

  /** Why it changed, in the operator's terms. `null` when it did not. */
  reason: z.string().nullable(),
});

/**
 * The pre-flight verdict, minus its outcome-specific member.
 *
 * `guidance` and `block` are NOT repeated in here: they are hoisted to the top
 * level of the response next to the `mode` that selects them, so a client
 * narrows once rather than twice and a multi-line command block is never sent
 * twice in one body.
 */
export const restorePreflightSchema = z.object({
  /**
   * What the gates decided, which mirrors the response's own `mode` exactly:
   * `ok`→`running`, `guided`→`guided`, `blocked`→`blocked`.
   *
   * Published even though it is redundant with `mode`, because this object is
   * also the thing a future read-only pre-flight route would return on its own,
   * and a verdict that does not say what it decided is not a verdict.
   */
  outcome: z.enum(['ok', 'guided', 'blocked']),

  /** The backup this verdict is about. */
  runId: z.uuid(),

  /** The application's database — the one a restore would displace. */
  targetDatabase: z.string(),

  /** The database the archive is replayed into, before the swap. */
  scratchDatabase: z.string(),

  /** The name the live database is renamed to during the swap. */
  oldDatabase: z.string(),

  gates: z.array(restoreGateSchema),

  rollback: restoreRollbackPlanSchema,

  /** The migration recorded on the archive, and the one live right now. */
  archiveMigration: z.string().nullable(),
  liveMigration: z.string().nullable(),

  /**
   * The live database's on-disk size, as a DECIMAL STRING.
   *
   * A string for the reason `db-backup-run.dto.ts` gives at length:
   * `pg_database_size` returns `int8`, `JSON.stringify` refuses a `bigint`
   * outright, and `Number()` rounds above 2^53. `null` when the cluster could
   * not be read.
   */
  databaseSizeBytes: z.string().regex(/^\d+$/).nullable(),

  /**
   * Free bytes where the server keeps its data, as a decimal string.
   *
   * `null` IS THE COMMON CASE and not a failure: the database is usually
   * external to this container, so its data directory is on a filesystem this
   * process has never seen. The disk gate turns that into a warning and never
   * into a refusal.
   */
  freeDiskBytes: z.string().regex(/^\d+$/).nullable(),
});

export type RestorePreflightView = z.infer<typeof restorePreflightSchema>;

/** The pre-flight result as the API publishes it. Drops nothing but the union member. */
export function toPreflightView(preflight: RestorePreflightResult): RestorePreflightView {
  return {
    outcome: preflight.outcome,
    runId: preflight.runId,
    targetDatabase: preflight.targetDatabase,
    scratchDatabase: preflight.scratchDatabase,
    oldDatabase: preflight.oldDatabase,
    // Copied element-wise rather than passed through, so a field added to
    // `RestoreGateResult` for internal use cannot reach the wire unreviewed.
    gates: preflight.gates.map((gate) => ({
      id: gate.id,
      kind: gate.kind,
      verdict: gate.verdict,
      title: gate.title,
      detail: gate.detail,
      action: gate.action,
    })),
    rollback: {
      configured: preflight.rollback.configured,
      effective: preflight.rollback.effective,
      downgraded: preflight.rollback.downgraded,
      reason: preflight.rollback.reason,
    },
    archiveMigration: preflight.archiveMigration,
    liveMigration: preflight.liveMigration,
    databaseSizeBytes: preflight.databaseSizeBytes,
    freeDiskBytes: preflight.freeDiskBytes,
  };
}

// ---------------------------------------------------------------------------
// POST runs/:id/restore
// ---------------------------------------------------------------------------

/** The three normal answers. `mode`, not the status code, is the discriminator. */
export const RESTORE_MODES = ['running', 'guided', 'blocked'] as const;

export type RestoreMode = (typeof RESTORE_MODES)[number];

export const startRestoreRunningSchema = z.object({
  /**
   * The gates passed and the restore is UNDER WAY, in the background.
   *
   * ⚠ NOT "FINISHED". The response returns as soon as the cheap pre-flight
   * gates have run, because a restore rebuilds every index in the database
   * from scratch and takes HOURS, while every proxy in front of this API has
   * a response timeout measured in seconds. Poll `GET runs/{id}` and watch
   * `restoreStatus`: `restoring` → `verifying` → `swapping` →
   * `completed`/`failed`.
   */
  mode: z.literal('running'),

  /** The backup being replayed. The same id you poll. */
  runId: z.uuid(),

  /** Where the archive is being replayed. Exists from now until the swap. */
  scratchDatabase: z.string(),

  /**
   * What the live database will be renamed to at the swap.
   *
   * Worth reading before the swap lands: in `retain_database` mode this is
   * the database a rollback renames back, and it is the name a human needs if
   * they ever have to finish a swap by hand.
   */
  oldDatabase: z.string(),

  preflight: restorePreflightSchema,
});

export const startRestoreGuidedSchema = z.object({
  /**
   * A CAPABILITY gate failed. NOTHING WAS STARTED and nothing was created.
   *
   * ⚠ NOT AN ERROR. This is the EXPECTED path on managed PostgreSQL that
   * denies `CREATEDB`, and the body below is the deliverable: the same
   * restore, performed by hand, with a superuser, from the same archive.
   */
  mode: z.literal('guided'),

  runId: z.uuid(),

  guidance: z.object({
    /** Which gate(s) sent the operator here, in one sentence. */
    reason: z.string(),

    /**
     * A COMPLETE shell block — real database names, real user, real host and
     * port, real run id. No placeholders: a command block with a
     * `<your-host>` in it is not a deliverable, it is homework, and it is
     * being read during an incident. Render it in a monospace block and let
     * it be copied whole.
     */
    commands: z.string(),

    /** Repository-relative path to the runbook that explains the block. */
    runbook: z.string(),
  }),

  preflight: restorePreflightSchema,
});

export const startRestoreBlockedSchema = z.object({
  /**
   * The schema-compatibility gate refused. NOTHING WAS STARTED.
   *
   * Re-send with `overrideSchemaCheck: true` to proceed anyway — after
   * comparing `preflight.archiveMigration` against `preflight.liveMigration`,
   * which is the comparison the decision actually rests on.
   */
  mode: z.literal('blocked'),

  runId: z.uuid(),

  block: z.object({
    /** Which gate refused. */
    gateId: z.enum(RESTORE_GATE_IDS),

    /** What it found, in one or two sentences. */
    message: z.string(),

    /**
     * Whether a human may override this block at all.
     *
     * `false` means the answer is no and re-sending will not help — the
     * client/server version pair is the live example. Do not offer an
     * override button for a block that says `false`.
     */
    overridable: z.boolean(),

    /**
     * The REQUEST FIELD that unblocks it, or `null` when nothing does.
     *
     * Published so a client never has to hard-code which flag clears which
     * gate. Today the only value is `overrideSchemaCheck`.
     */
    overrideParameter: z.string().nullable(),
  }),

  preflight: restorePreflightSchema,
});

/**
 * The three variants as one discriminated union — the RUNTIME contract and the
 * TypeScript type.
 *
 * ⚠ `createZodDto` IS APPLIED TO EACH VARIANT, NOT TO THIS UNION, and it is not
 * a stylistic choice: `createZodDto` builds a CLASS whose instance type is the
 * schema's output, and a class cannot have a union instance type — TypeScript
 * rejects it outright ("Base constructor return type is not an object type").
 * So the union stays a schema and a type, and the OpenAPI document composes the
 * three variant classes with `oneOf`. `openapi/data-envelope.ts` still wraps the
 * result correctly because `ApiDataResponse` emits the `{ data: … }` envelope
 * itself rather than relying on the later pass to recognise a composed schema.
 */
export const startRestoreResponseSchema = z.discriminatedUnion('mode', [
  startRestoreRunningSchema,
  startRestoreGuidedSchema,
  startRestoreBlockedSchema,
]);

/** `mode: "running"` on the wire. Registered for `oneOf`; see the union above. */
export class StartRestoreRunningDto extends createZodDto(startRestoreRunningSchema) {}

/** `mode: "guided"` on the wire. NOT an error — see this file's header. */
export class StartRestoreGuidedDto extends createZodDto(startRestoreGuidedSchema) {}

/** `mode: "blocked"` on the wire. Re-send with `overrideSchemaCheck: true`. */
export class StartRestoreBlockedDto extends createZodDto(startRestoreBlockedSchema) {}

/** The three, in the order the controller publishes them. */
export const START_RESTORE_RESPONSE_DTOS = [
  StartRestoreRunningDto,
  StartRestoreGuidedDto,
  StartRestoreBlockedDto,
] as const;

export type StartRestoreResponse = z.infer<typeof startRestoreResponseSchema>;

/**
 * {@link StartRestoreResult} as the API publishes it.
 *
 * `already_running` is DELIBERATELY NOT REPRESENTED HERE. It is not a mode; it
 * is a 409, because unlike the three above it means the request could not be
 * answered at all. The controller maps it — see there for why the mapping is
 * not in the service.
 */
export function toStartRestoreResponse(
  result: Extract<StartRestoreResult, { outcome: 'started' | 'refused' }>
): StartRestoreResponse {
  if (result.outcome === 'started') {
    return {
      mode: 'running',
      runId: result.runId,
      scratchDatabase: result.scratchDatabase,
      oldDatabase: result.oldDatabase,
      preflight: toPreflightView(result.preflight),
    };
  }

  const { preflight } = result;

  if (preflight.outcome === 'guided') {
    return {
      mode: 'guided',
      runId: preflight.runId,
      guidance: {
        reason: preflight.guidance.reason,
        commands: preflight.guidance.commands,
        runbook: preflight.guidance.runbook,
      },
      preflight: toPreflightView(preflight),
    };
  }

  if (preflight.outcome === 'blocked') {
    return {
      mode: 'blocked',
      runId: preflight.runId,
      block: {
        gateId: preflight.block.gateId,
        message: preflight.block.message,
        overridable: preflight.block.overridable,
        overrideParameter: preflight.block.overrideParameter,
      },
      preflight: toPreflightView(preflight),
    };
  }

  // ⚠ UNREACHABLE BY CONSTRUCTION, and thrown rather than defaulted. `refused`
  // exists only because the pre-flight was not `ok`, so an `ok` verdict here
  // means the restore service returned "refused" about a verdict that permits
  // the restore. Quietly answering `blocked` would hide a contradiction between
  // two files in the one subsystem where a wrong answer is destructive.
  throw new Error(
    `A restore of backup run ${preflight.runId} was refused with an "ok" pre-flight, which ` +
      'is a contradiction. Nothing was started.'
  );
}

// ---------------------------------------------------------------------------
// POST runs/:id/rollback
// ---------------------------------------------------------------------------

/**
 * The three normal answers.
 *
 * Mirrors `RestoreRollbackResult` in `database-restore.service.ts` one-for-one
 * and on purpose: this is that type on the wire, not a summary of it — the same
 * discipline `CANCEL_OUTCOMES` follows.
 */
export const ROLLBACK_MODES = ['renamed', 'restore_started', 'unavailable'] as const;

export type RollbackMode = (typeof ROLLBACK_MODES)[number];

export const rollbackRenamedSchema = z.object({
  /**
   * `retain_database` mode: the retained pre-swap database was renamed back
   * into place and the process is exiting. SECONDS.
   *
   * This is the entire justification for paying roughly double the PostgreSQL
   * volume for `databaseBackup.oldDatabaseRetentionHours`.
   *
   * ⚠ THE PROCESS EXITS moments after this response is flushed, because its
   * connection pool is bound to a database that has just been renamed out
   * from under it. Expect the very next request to fail until the supervisor
   * restarts the process.
   */
  mode: z.literal('renamed'),

  runId: z.uuid(),

  /** The database that is now live — the one the restore had displaced. */
  promoted: z.string(),

  /** Where the restored database was parked. Dropped by the retention sweep. */
  parked: z.string(),

  /** One sentence an operator can act on, matched to `mode`. */
  detail: z.string(),
});

export const rollbackRestoreStartedSchema = z.object({
  /**
   * `pre_restore_dump` mode: there was no database to rename, so this
   * delegated into the RESTORE path against the safety archive taken
   * immediately before the swap. HOURS, not seconds.
   *
   * ⚠ THE DELEGATED RESTORE RUNS WITH THE SCHEMA CHECK OVERRIDDEN, and it has
   * to. That dump came from the schema this code was running moments before
   * the restore, so the migration it would be compared against is the
   * ARCHIVE's — the gate would block on a mismatch that exists only because
   * the thing being undone happened. A spurious block, fired at the exact
   * moment an operator needs the way back.
   *
   * Poll `GET runs/{preRestoreRunId}` — NOT `runId` — for progress: the
   * restore's state lives on the row of the backup being replayed.
   */
  mode: z.literal('restore_started'),

  runId: z.uuid(),

  /** The `pre_restore` backup now being restored. The row to poll. */
  preRestoreRunId: z.uuid(),

  detail: z.string(),
});

export const rollbackUnavailableSchema = z.object({
  /**
   * There is nothing left to roll back to.
   *
   * ⚠ REPORTED HONESTLY RATHER THAN AS A FAILURE, and it is a `200` for that
   * reason. Nothing went wrong just now: the retained database passed its
   * retention window and was dropped, or the deployment never had one and no
   * completed pre-restore backup exists. An operator needs that as a FACT,
   * not as an error to retry — retrying changes nothing, and restoring some
   * other archive is a new restore, not a rollback.
   */
  mode: z.literal('unavailable'),

  runId: z.uuid(),

  /**
   * Why, in the operator's terms — verbatim from the service, which is the
   * only thing that knows which of the two ways in it arrived by.
   */
  detail: z.string(),
});

/** The three variants as one discriminated union. Split into classes for the same reason. */
export const rollbackRestoreResponseSchema = z.discriminatedUnion('mode', [
  rollbackRenamedSchema,
  rollbackRestoreStartedSchema,
  rollbackUnavailableSchema,
]);

/** `mode: "renamed"` on the wire. Seconds. */
export class RollbackRenamedDto extends createZodDto(rollbackRenamedSchema) {}

/** `mode: "restore_started"` on the wire. Hours. */
export class RollbackRestoreStartedDto extends createZodDto(rollbackRestoreStartedSchema) {}

/** `mode: "unavailable"` on the wire. A `200`, and honest. */
export class RollbackUnavailableDto extends createZodDto(rollbackUnavailableSchema) {}

/** The three, in the order the controller publishes them. */
export const ROLLBACK_RESPONSE_DTOS = [
  RollbackRenamedDto,
  RollbackRestoreStartedDto,
  RollbackUnavailableDto,
] as const;

export type RollbackRestoreResponse = z.infer<typeof rollbackRestoreResponseSchema>;

/** {@link RestoreRollbackResult} as the API publishes it. */
export function toRollbackResponse(result: RestoreRollbackResult): RollbackRestoreResponse {
  switch (result.outcome) {
    case 'renamed':
      return {
        mode: 'renamed',
        runId: result.runId,
        promoted: result.promoted,
        parked: result.parked,
        detail:
          `The database displaced by this restore ("${result.promoted}") has been renamed ` +
          `back into place and the restored one parked as "${result.parked}". This process ` +
          'is exiting so its connection pool can be rebuilt; the service returns on its own ' +
          'once the supervisor restarts it.',
      };

    case 'restore_started':
      return {
        mode: 'restore_started',
        runId: result.runId,
        preRestoreRunId: result.preRestoreRunId,
        detail:
          'There was no retained database to rename, so the safety backup taken immediately ' +
          `before the restore (run ${result.preRestoreRunId}) is being restored instead, ` +
          'with the schema check overridden. This takes as long as the original restore ' +
          `did — poll GET runs/${result.preRestoreRunId} for progress, not this run.`,
      };

    case 'unavailable':
      // The service's own sentence, unedited. It is the only thing that knows
      // whether the retained database expired or never existed, and rewriting
      // it here would put a second, vaguer explanation on the wire.
      return { mode: 'unavailable', runId: result.runId, detail: result.reason };
  }
}
