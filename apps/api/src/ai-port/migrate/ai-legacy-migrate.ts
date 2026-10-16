// Registers the settings namespaces and the role, permission and ownership
// registries the application module composes from. Must stay the first imports
// (see `main.ts` and `kvox.manifest.ts`); both are idempotent module side effects.
import '../../kvox.manifest';
import '../../app-registrations/registrations';

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { APP_SLUG } from '@app/shared';
import { Logger } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

import { buildDatabaseUrl } from '../../common/database-url';
import {
  LEGACY_PROVIDER_ID,
  planAiSettings,
  type AiLegacyReport,
  type AiModelUpsert,
  type LegacyAiValue,
} from './ai-legacy-plan';

// =============================================================================
// AI legacy migration: AI settings and models to the platform
// (issue #474, epic #472; keys retired by issue #477)
// =============================================================================
//
// An OPERATOR COMMAND, run once per deployment, like `prisma:seed`:
//
//     node dist/ai-port/migrate/ai-legacy-migrate.js [--dry-run] [--apply]
//          [--snapshot <file>] [--restore <file>]
//
// WHY NOT A QUEUE JOB. No HTTP request and no cron starts it, so the "every
// long-running activity is a queue job" rule does not apply, and a permanent job
// type for a one-off would pin a type string forever. It lives under `src/` so
// `nest build` compiles it into `dist/` and the production image runs it without
// `ts-node`. Runbook: docs/runbooks/ai-platform-migration.md.
//
// WHAT IT DOES
//   1. Keys. NOT MIGRATED BY THIS BUILD. The keys moved in the build before
//      issue #477; that release dropped `user_ai_credentials` together with the
//      cipher that read it. This step only LOOKS: when the table is gone (the
//      normal case) it prints that there is nothing to migrate for keys; when the
//      table is still there and holds rows (this build was started before
//      `prisma:migrate` ran) it REFUSES, because running the migration drops the
//      table and those keys would be lost. Run the previous build's command first.
//   2. Models. One enabled `ai_models` row per `allowedModels` entry, plus the
//      embedding model, marked `admin_override` so a later catalogue sync never
//      rewrites them (BYOK has no deployment key, so no sync can create them).
//   3. Settings. The stored `ai` value is rewritten into the platform shape and
//      the legacy-only keys (`provider`, `providers.openai.allowedModels`,
//      `providers.openai.defaultModel`) leave it. Written with ONE guarded row
//      update (see `writeSettings` for why this is not a `SystemSettingsService`
//      PUT).
//
// PLATFORM-ADOPTION (issue #477): the model knowledge the planner resolves
// against is a frozen copy (`legacy-model-knowledge.ts`); the retired
// `apps/api/src/ai/` directory it came from is deleted. A deployment that has not
// migrated its `ai` settings yet still needs this command, so it stays until the
// local-exceptions register says every deployment has run it.
//
// SAFETY
//   - `--dry-run` is the default and writes nothing: no row, no file, no job.
//   - `--apply` writes the pre-migration snapshot FIRST and refuses to continue
//     when it cannot be written. The snapshot holds no key and no ciphertext.
//   - Idempotent: a settings value that no longer holds a legacy key is not
//     rewritten, and an `ai_models` row an administrator changed since is not
//     touched.
//   - `--restore` puts the old `ai` value and the model rows back.
//
// A BARE PRISMA CLIENT IS ENOUGH. It reads and writes `system_settings`,
// `audit_events` and `ai_models`, all outside row-level security (checked against
// the migrations), so no application context and no `migration-tooling` access
// reason is needed, and no encryption key either.
// =============================================================================

/** The `system_settings` row the `ai` namespace lives in (`SettingsModule.forRoot({ systemRowKey })`). */
export const SYSTEM_SETTINGS_ROW_KEY = 'global';

/** The `source` recorded on the audit rows this command writes: the app slug (`APP_SLUG`, identity.json). */
export const AUDIT_SOURCE: string = APP_SLUG;

/** Written by this build. Version 1 (the build before #477) is still accepted by `--restore`. */
const SNAPSHOT_VERSION = 2;
const ACCEPTED_SNAPSHOT_VERSIONS: readonly number[] = [1, 2];


/** The Prisma surface the command uses; the real `PrismaClient` satisfies it. */
export type MigratePrisma = Pick<
  PrismaClient,
  | '$queryRaw'
  | '$transaction'
  | 'aiModel'
  | 'systemSettings'
  | 'auditEvent'
>;

export interface MigrateLogger {
  log(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface MigrateDeps {
  prisma: MigratePrisma;
  logger: MigrateLogger;
}

export interface MigrateOptions {
  apply: boolean;
  /** Where the pre-migration snapshot goes (apply only). */
  snapshotPath: string;
}

export interface MigrateResult {
  report: AiLegacyReport;
  exitCode: 0 | 1;
  /** Why the exit code is 1, one line each. */
  problems: string[];
  snapshotPath: string | null;
}

/**
 * The pre-migration state, for `--restore`. Holds no secret and no ciphertext.
 * A version 1 file (written before #477) also lists key hints under `credentials`
 * and `userAiKeys`; they are ignored.
 */
export interface AiLegacySnapshot {
  version: number;
  /** Database clock at the moment the snapshot was taken. */
  takenAt: string;
  /** The raw `ai` value of the `global` row, or null when the row or the key was absent. */
  aiValue: unknown;
  settingsRowExisted: boolean;
  aiModels: Array<{
    provider: string;
    modelId: string;
    displayName: string | null;
    enabled: boolean;
    capabilitySource: string;
    capabilities: unknown;
    contextWindow: number | null;
    maxOutputTokens: number | null;
  }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A failure description that can never carry a key: our own errors, never a payload. */
function describeError(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? `${error.name} (${code})` : error.name;
  }
  return 'unknown error';
}

/** How many rows the retired key table still holds; `null` when the table does not exist. */
async function legacyKeyRows(prisma: MigratePrisma): Promise<number | null> {
  const present = await prisma.$queryRaw<Array<{ present: boolean }>>`
    SELECT to_regclass('public.user_ai_credentials') IS NOT NULL AS present`;
  if (!present[0]?.present) return null;
  const rows = await prisma.$queryRaw<Array<{ count: bigint }>>`
    SELECT count(*)::bigint AS count FROM user_ai_credentials`;
  return Number(rows[0]?.count ?? 0);
}

async function databaseNow(prisma: MigratePrisma): Promise<Date> {
  const rows = await prisma.$queryRaw<Array<{ now: Date }>>`SELECT now() AS now`;
  return rows[0].now;
}

// ---------------------------------------------------------------------------
// Migrate
// ---------------------------------------------------------------------------

export async function runAiLegacyMigration(deps: MigrateDeps, options: MigrateOptions): Promise<MigrateResult> {
  const { prisma, logger } = deps;
  const problems: string[] = [];

  // ---- keys: look only (see the header) -----------------------------------------
  const legacyRows = await legacyKeyRows(prisma);
  const keys: AiLegacyReport['keys'] = {
    skipped: true,
    legacyTablePresent: legacyRows !== null,
    legacyRows: legacyRows ?? 0,
  };
  if (legacyRows === null) {
    logger.log('keys: nothing to migrate (this build has no user_ai_credentials table; keys live in user_ai_keys)');
  } else if (legacyRows === 0) {
    logger.log('keys: nothing to migrate (user_ai_credentials is empty)');
  } else {
    const message =
      `${legacyRows} row(s) remain in user_ai_credentials and this build cannot import them; the upgrade drops that ` +
      "table. Run this command from the PREVIOUS build first (docs/runbooks/ai-platform-migration.md).";
    if (options.apply) {
      throw new Error(`Refusing to --apply: ${message} Nothing was changed.`);
    }
    problems.push(message);
  }

  // ---- read everything the plan depends on --------------------------------
  const existingModels = await prisma.aiModel.findMany({ where: { provider: LEGACY_PROVIDER_ID } });
  const settingsRow = await prisma.systemSettings.findUnique({ where: { key: SYSTEM_SETTINGS_ROW_KEY } });

  const rowValue = settingsRow && isRecord(settingsRow.value) ? settingsRow.value : null;
  const rawAi = rowValue && isRecord(rowValue.ai) ? rowValue.ai : null;
  const plan = rawAi ? planAiSettings(rawAi as unknown as LegacyAiValue) : null;
  logger.log(
    `read: openaiModels=${existingModels.length} ` +
      `aiValue=${rawAi ? (plan?.alreadyMigrated ? 'already-migrated' : 'legacy') : 'absent'}`,
  );

  // ---- snapshot first -------------------------------------------------------
  let snapshotPath: string | null = null;
  let takenAt: Date | null = null;
  if (options.apply) {
    takenAt = await databaseNow(prisma);
    const snapshot: AiLegacySnapshot = {
      version: SNAPSHOT_VERSION,
      takenAt: takenAt.toISOString(),
      aiValue: rawAi,
      settingsRowExisted: settingsRow !== null,
      aiModels: existingModels.map((row) => ({
        provider: row.provider,
        modelId: row.modelId,
        displayName: row.displayName,
        enabled: row.enabled,
        capabilitySource: row.capabilitySource,
        capabilities: row.capabilities,
        contextWindow: row.contextWindow,
        maxOutputTokens: row.maxOutputTokens,
      })),
    };
    snapshotPath = resolve(options.snapshotPath);
    try {
      mkdirSync(dirname(snapshotPath), { recursive: true });
      // `wx`: never overwrite an earlier snapshot, which may be the only way back.
      writeFileSync(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    } catch (error) {
      throw new Error(
        `Refusing to --apply: the snapshot ${snapshotPath} could not be written (${describeError(error)}). ` +
          'Nothing was changed.',
      );
    }
    logger.log(`snapshot: written to ${snapshotPath}`);
  }

  // ---- models and settings: one transaction ----------------------------------
  const models = plan?.models ?? [];
  const createOnly = plan === null || plan.alreadyMigrated;
  const migratedAi = plan && !plan.alreadyMigrated ? plan.migrated : rawAi;

  // Rows the plan writes (create-only mode writes only the ones that are missing).
  let modelsWritten = models.length;
  if (!options.apply && createOnly) {
    const known = new Set(existingModels.map((m) => m.modelId));
    modelsWritten = models.filter((m) => !known.has(m.modelId)).length;
  }

  if (options.apply) {
    modelsWritten = 0;
    await prisma.$transaction(async (tx) => {
      for (const model of models) {
        if (await upsertModel(tx, model, createOnly)) modelsWritten += 1;
      }
      if (plan && !plan.alreadyMigrated && settingsRow && rowValue) {
        await writeSettings(tx, settingsRow.id, settingsRow.version, rowValue, plan.migrated, {
          modelsUpserted: modelsWritten,
          removed: ['provider', 'providers.openai.allowedModels', 'providers.openai.defaultModel'],
        });
      }
    });
    logger.log(
      `models: upserted=${modelsWritten}${createOnly ? ' (create-only: settings already migrated)' : ''}; ` +
        `settings: ${plan && !plan.alreadyMigrated ? 'rewritten' : 'left as stored'}`,
    );
  }

  // ---- verification report ------------------------------------------------------
  let enabledModels: number;
  if (options.apply) {
    enabledModels = await prisma.aiModel.count({ where: { provider: LEGACY_PROVIDER_ID, enabled: true } });
  } else {
    // Projected: what is enabled now, plus what the plan would add or re-enable.
    const enabledIds = new Set(existingModels.filter((m) => m.enabled).map((m) => m.modelId));
    const known = new Set(existingModels.map((m) => m.modelId));
    for (const model of models) {
      if (!createOnly || !known.has(model.modelId)) enabledIds.add(model.modelId);
    }
    enabledModels = enabledIds.size;
  }

  const openaiSlot = migratedAi && isRecord(migratedAi.providers) ? migratedAi.providers.openai : undefined;
  const report: AiLegacyReport = {
    keys,
    models: { allowed: plan?.allowed ?? 0, upserted: modelsWritten, enabled: enabledModels },
    settings: {
      enabled: migratedAi?.enabled === true,
      providerEnabled: isRecord(openaiSlot) && openaiSlot.enabled === true,
      defaultModel: typeof migratedAi?.defaultModel === 'string' ? migratedAi.defaultModel : null,
      taskModels: migratedAi && isRecord(migratedAi.taskModels) ? Object.keys(migratedAi.taskModels).sort() : [],
    },
    dryRun: !options.apply,
  };

  // ---- verdict ---------------------------------------------------------------------
  if (plan && plan.skippedEntries.length > 0) {
    logger.warn(`models: ${plan.skippedEntries.length} allowedModels entr(y/ies) were not valid and were skipped (positions ${plan.skippedEntries.join(',')})`);
  }
  if (!rawAi) {
    logger.warn('settings: the global row holds no `ai` value; nothing to migrate on the settings side');
  }

  if (options.apply && snapshotPath) {
    const reportPath = snapshotPath.replace(/\.json$/i, '') + '.report.json';
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { flag: 'w', mode: 0o600 });
    logger.log(`report: written to ${reportPath}`);
  }

  return { report, exitCode: problems.length === 0 ? 0 : 1, problems, snapshotPath };
}

type Tx = Prisma.TransactionClient;

/**
 * Upsert one `ai_models` row on `(provider, modelId)`.
 *
 * `createOnly` is the rerun case: the settings were migrated before, so an
 * existing row is whatever an administrator made of it since, and is not touched.
 * Otherwise an existing row takes the legacy values, except that a model without a
 * label keeps the name it already had.
 */
async function upsertModel(tx: Tx, model: AiModelUpsert, createOnly: boolean): Promise<boolean> {
  const data = {
    displayName: model.displayName,
    contextWindow: model.contextWindow,
    maxOutputTokens: model.maxOutputTokens,
    capabilities: model.capabilities as unknown as Prisma.InputJsonValue,
    capabilitySource: model.capabilitySource,
    enabled: model.enabled,
  };
  const where = { provider_modelId: { provider: model.provider, modelId: model.modelId } };

  if (createOnly) {
    const existing = await tx.aiModel.findUnique({ where, select: { id: true } });
    if (existing) return false;
    await tx.aiModel.create({ data: { provider: model.provider, modelId: model.modelId, ...data } });
    return true;
  }
  await tx.aiModel.upsert({
    where,
    create: { provider: model.provider, modelId: model.modelId, ...data },
    update: { ...data, displayName: model.displayName ?? undefined, deprecatedAt: null },
  });
  return true;
}

/**
 * Replace the `ai` key of the `global` row and bump its version, guarded on the
 * version that was read.
 *
 * WHY NOT `SystemSettingsService.replaceSettings`. A PUT through the service
 * validates once, which is what the issue wants, but it also lays every top-level
 * and nested key the schema does not model back underneath the validated value
 * (`mergePreservingUnknown`, #130). `provider` is exactly such a key once the
 * platform owns the namespace, so a PUT would write it back and the migration
 * could never remove it. This update stores the planned value as is, and the
 * platform's own `read` is the validator afterwards (the spec reads it back).
 */
async function writeSettings(
  tx: Tx,
  rowId: string,
  version: number,
  rowValue: Record<string, unknown>,
  migratedAi: Record<string, unknown>,
  audit: { modelsUpserted: number; removed: string[] },
): Promise<void> {
  const nextValue = { ...rowValue, ai: migratedAi } as unknown as Prisma.InputJsonValue;
  const updated = await tx.systemSettings.updateMany({
    where: { key: SYSTEM_SETTINGS_ROW_KEY, version },
    data: { value: nextValue, version: { increment: 1 }, updatedByUserId: null },
  });
  if (updated.count !== 1) {
    throw new Error('The system settings row changed while the migration ran (version mismatch). Nothing was written; run it again.');
  }
  await tx.auditEvent.create({
    data: {
      actorUserId: null,
      action: 'system_settings:ai-legacy-migrate',
      targetType: 'system_settings',
      targetId: rowId,
      meta: { namespace: 'ai', removedKeys: audit.removed, modelsUpserted: audit.modelsUpserted, source: AUDIT_SOURCE },
    },
  });
}

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------

export interface RestoreResult {
  settingsRestored: boolean;
  modelsRestored: number;
  modelsDisabled: number;
}

/**
 * Undo `--apply` from its snapshot: write the old `ai` value back, restore the
 * `ai_models` rows the snapshot listed and disable the ones it did not.
 *
 * KEYS ARE NOT TOUCHED (issue #477). A key imported by the previous build is a
 * real platform key now: the user may have replaced or tested it since, and the
 * snapshot holds hints, never secrets, so deleting it could not be undone. A
 * version 1 snapshot lists those keys; this build reports that it leaves them.
 */
export async function runAiLegacyRestore(
  deps: Pick<MigrateDeps, 'prisma' | 'logger'>,
  snapshotPath: string,
  dryRun = false,
): Promise<RestoreResult> {
  const { prisma, logger } = deps;
  const snapshot = parseSnapshot(readFileSync(resolve(snapshotPath), 'utf8'));

  if (snapshot.version === 1) {
    logger.warn('restore: this snapshot was written before keys left this command; imported keys are left in place');
  }

  const snapshotIds = new Set(snapshot.aiModels.map((m) => m.modelId));
  const currentModels = await prisma.aiModel.findMany({ where: { provider: LEGACY_PROVIDER_ID }, select: { modelId: true, enabled: true } });
  const toDisable = currentModels.filter((m) => !snapshotIds.has(m.modelId) && m.enabled);

  const result: RestoreResult = {
    settingsRestored: false,
    modelsRestored: snapshot.aiModels.length,
    modelsDisabled: toDisable.length,
  };

  if (dryRun) {
    result.settingsRestored = snapshot.settingsRowExisted;
    logger.log(`restore (dry run): would restore the ai value, restore ${result.modelsRestored} model row(s), disable ${result.modelsDisabled}`);
    return result;
  }

  await prisma.$transaction(async (tx) => {
    const row = await tx.systemSettings.findUnique({ where: { key: SYSTEM_SETTINGS_ROW_KEY } });
    if (row && isRecord(row.value) && snapshot.settingsRowExisted) {
      const next: Record<string, unknown> = { ...row.value };
      if (snapshot.aiValue === null || snapshot.aiValue === undefined) delete next.ai;
      else next.ai = snapshot.aiValue;
      await tx.systemSettings.update({
        where: { key: SYSTEM_SETTINGS_ROW_KEY },
        data: { value: next as unknown as Prisma.InputJsonValue, version: { increment: 1 }, updatedByUserId: null },
      });
      await tx.auditEvent.create({
        data: {
          actorUserId: null,
          action: 'system_settings:ai-legacy-restore',
          targetType: 'system_settings',
          targetId: row.id,
          meta: { namespace: 'ai', snapshotTakenAt: snapshot.takenAt },
        },
      });
      result.settingsRestored = true;
    }

    for (const model of snapshot.aiModels) {
      const data = {
        displayName: model.displayName,
        enabled: model.enabled,
        capabilitySource: model.capabilitySource,
        capabilities: model.capabilities as Prisma.InputJsonValue,
        contextWindow: model.contextWindow,
        maxOutputTokens: model.maxOutputTokens,
      };
      await tx.aiModel.upsert({
        where: { provider_modelId: { provider: model.provider, modelId: model.modelId } },
        create: { provider: model.provider, modelId: model.modelId, ...data },
        update: data,
      });
    }
    for (const model of toDisable) {
      await tx.aiModel.update({
        where: { provider_modelId: { provider: LEGACY_PROVIDER_ID, modelId: model.modelId } },
        data: { enabled: false },
      });
    }
  });

  logger.log(
    `restore: aiValue=${result.settingsRestored ? 'restored' : 'untouched'} ` +
      `modelsRestored=${result.modelsRestored} modelsDisabled=${result.modelsDisabled}`,
  );
  return result;
}

function parseSnapshot(text: string): AiLegacySnapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('The snapshot file is not valid JSON.');
  }
  if (!isRecord(parsed) || typeof parsed.version !== 'number' || !ACCEPTED_SNAPSHOT_VERSIONS.includes(parsed.version) || typeof parsed.takenAt !== 'string' || Number.isNaN(Date.parse(parsed.takenAt)) || !Array.isArray(parsed.aiModels)) {
    throw new Error('The file is not an AI legacy migration snapshot (version or shape mismatch).');
  }
  return parsed as unknown as AiLegacySnapshot;
}

// ---------------------------------------------------------------------------
// Report text
// ---------------------------------------------------------------------------

export function formatReport(report: AiLegacyReport): string {
  const { keys, models, settings } = report;
  return [
    `${report.dryRun ? 'DRY RUN (nothing was written; upserted is a planned number)' : 'APPLIED'}`,
    keys.legacyTablePresent
      ? `keys: not migrated by this build; user_ai_credentials still holds ${keys.legacyRows} row(s)`
      : 'keys: nothing to migrate (they live in user_ai_keys)',
    `models: allowed=${models.allowed} upserted=${models.upserted} enabled=${models.enabled}`,
    `settings: enabled=${settings.enabled} providerEnabled=${settings.providerEnabled} ` +
      `defaultModel=${settings.defaultModel ?? '(none)'} taskModels=${settings.taskModels.join(',') || '(none)'}`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const USAGE = `Usage: node dist/ai-port/migrate/ai-legacy-migrate.js [options]

  --dry-run               Report what would change; write nothing (default).
  --apply                 Upsert ai_models and rewrite the ai settings.
  --snapshot <file>       Where --apply writes the pre-migration snapshot
                          (default ./ai-legacy-snapshot-<timestamp>.json).
  --restore <file>        Undo a previous --apply from its snapshot.
`;

function cliLogger(): MigrateLogger {
  const logger = new Logger('ai-legacy-migrate');
  return {
    log: (message) => logger.log(message),
    warn: (message) => logger.warn(message),
    error: (message) => logger.error(message),
  };
}

function parseCli(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      'dry-run': { type: 'boolean', default: false },
      apply: { type: 'boolean', default: false },
      snapshot: { type: 'string' },
      restore: { type: 'string' },
      help: { type: 'boolean', default: false },
    },
    strict: true,
  });
  return values;
}

/** The compiled entry point. Returns the process exit code. */
export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const logger = cliLogger();
  let args: ReturnType<typeof parseCli>;
  try {
    args = parseCli(argv);
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n${USAGE}`);
    return 2;
  }
  if (args.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (args.apply && args['dry-run']) {
    process.stderr.write(`--apply and --dry-run are mutually exclusive.\n${USAGE}`);
    return 2;
  }
  if (args.restore && args.apply) {
    process.stderr.write(`--restore cannot be combined with --apply.\n${USAGE}`);
    return 2;
  }

  const snapshotPath =
    args.snapshot ?? `./ai-legacy-snapshot-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;

  if (args.restore && !existsSync(resolve(args.restore))) {
    process.stderr.write(`Snapshot file not found: ${args.restore}\n`);
    return 2;
  }

  // Every mode needs only the database, not the application graph.
  const prisma = new PrismaClient({ adapter: new PrismaPg(buildDatabaseUrl()) });
  try {
    await prisma.$connect();
    if (args.restore) {
      await runAiLegacyRestore({ prisma, logger }, args.restore, args['dry-run'] === true);
      return 0;
    }
    const result = await runAiLegacyMigration({ prisma, logger }, { apply: args.apply === true, snapshotPath });
    process.stdout.write(`${formatReport(result.report)}\n`);
    for (const problem of result.problems) process.stderr.write(`PROBLEM: ${problem}\n`);
    return result.exitCode;
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    },
  );
}
