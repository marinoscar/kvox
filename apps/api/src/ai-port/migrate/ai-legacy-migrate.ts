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
import { assertEncryptionKeyConfigured } from '@marinoscar/platform-api/core';
import { deriveHint } from '@marinoscar/platform-api/credentials';
import type { UserAiKeysService } from '@marinoscar/platform-api/ai';

import { buildDatabaseUrl } from '../../common/database-url';
import { AI_CREDENTIAL_PURPOSE } from '../../ai/ai-credential.constants';
import { decryptSecret } from './legacy-cipher';
import {
  LEGACY_PROVIDER_ID,
  planAiSettings,
  type AiLegacyReport,
  type AiModelUpsert,
  type LegacyAiValue,
} from './ai-legacy-plan';

// =============================================================================
// AI legacy migration: user AI keys and AI settings to the platform
// (issue #474, epic #472)
// =============================================================================
//
// An OPERATOR COMMAND, run once per deployment, like `prisma:seed`:
//
//     node dist/ai-port/migrate/ai-legacy-migrate.js [--dry-run] [--apply]
//          [--snapshot <file>] [--restore <file>] [--allow-undecryptable]
//
// WHY NOT A QUEUE JOB. No HTTP request and no cron starts it, so the "every
// long-running activity is a queue job" rule does not apply, and a permanent job
// type for a one-off would pin a type string forever. It lives under `src/` so
// `nest build` compiles it into `dist/` and the production image runs it without
// `ts-node`. Runbook: docs/runbooks/ai-platform-migration.md.
//
// WHAT IT DOES
//   1. Keys. Every `user_ai_credentials` row is decrypted with this application's
//      own cipher (`legacy-cipher.ts`, purpose `'ai-key'`) and handed to the
//      platform's `UserAiKeysService.importKey`, which re-encrypts it under the
//      platform's purpose, stores it unverified, audits `ai:user-key:import` with
//      the app slug as `source` and queues `ai.keys.recheck`. A ciphertext is NEVER given
//      to the platform.
//   2. Models. One enabled `ai_models` row per `allowedModels` entry, plus the
//      embedding model, marked `admin_override` so a later catalogue sync never
//      rewrites them (BYOK has no deployment key, so no sync can create them).
//   3. Settings. The stored `ai` value is rewritten into the platform shape and
//      the legacy-only keys (`provider`, `providers.openai.allowedModels`,
//      `providers.openai.defaultModel`) leave it. Written with ONE guarded row
//      update (see `writeSettings` for why this is not a `SystemSettingsService`
//      PUT).
//
// SAFETY
//   - `--dry-run` is the default and writes nothing: no row, no file, no job.
//   - `--apply` writes the pre-migration snapshot FIRST and refuses to continue
//     when it cannot be written. The snapshot never holds a key or a ciphertext.
//   - A plaintext key exists only between `decryptSecret` and `importKey`; it is
//     never logged, returned, audited or written to a file.
//   - Idempotent: a key whose platform copy already carries the same hint is
//     counted `alreadyImported` and not touched; a settings value that no longer
//     holds a legacy key is not rewritten.
//   - `--restore` undoes it; `user_ai_credentials` is never modified, so the old
//     code path keeps working on a reverted build.
//
// NO BYPASS CLIENT. Every table this command touches (`system_settings`,
// `audit_events`, `ai_models`, `user_ai_keys`, `user_ai_credentials`) is outside
// row-level security (checked against the migrations), so the ordinary client is
// enough and no `migration-tooling` access reason is needed.
// =============================================================================

/** The `system_settings` row the `ai` namespace lives in (`SettingsModule.forRoot({ systemRowKey })`). */
export const SYSTEM_SETTINGS_ROW_KEY = 'global';

/** Audit action the platform writes for an imported key. */
export const KEY_IMPORT_AUDIT_ACTION = 'ai:user-key:import';

/** The `source` recorded on every import audit row: the app slug (`APP_SLUG`, identity.json). */
export const KEY_IMPORT_SOURCE: string = APP_SLUG;

const SNAPSHOT_VERSION = 1;

/** The Prisma surface the command uses; the real `PrismaClient` satisfies it. */
export type MigratePrisma = Pick<
  PrismaClient,
  | '$queryRaw'
  | '$transaction'
  | 'userAiCredential'
  | 'userAiKey'
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
  /** Required for `apply`; unused by a dry run and a restore. */
  userAiKeys?: Pick<UserAiKeysService, 'importKey'>;
  logger: MigrateLogger;
  /** Replaceable for a spec; defaults to the copied legacy cipher. */
  decrypt?: (payload: string, purpose: string) => string;
}

export interface MigrateOptions {
  apply: boolean;
  /** Where the pre-migration snapshot goes (apply only). */
  snapshotPath: string;
  allowUndecryptable: boolean;
}

export interface MigrateResult {
  report: AiLegacyReport;
  exitCode: 0 | 1;
  /** Why the exit code is 1, one line each. */
  problems: string[];
  snapshotPath: string | null;
}

/** The pre-migration state, for `--restore`. Holds no secret and no ciphertext. */
export interface AiLegacySnapshot {
  version: typeof SNAPSHOT_VERSION;
  /** Database clock at the moment the snapshot was taken. */
  takenAt: string;
  /** The raw `ai` value of the `global` row, or null when the row or the key was absent. */
  aiValue: unknown;
  settingsRowExisted: boolean;
  credentials: Array<{ id: string; userId: string; provider: string; hint: string | null; label: string | null }>;
  userAiKeys: Array<{ userId: string; provider: string; hint: string | null }>;
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

async function databaseNow(prisma: MigratePrisma): Promise<Date> {
  const rows = await prisma.$queryRaw<Array<{ now: Date }>>`SELECT now() AS now`;
  return rows[0].now;
}

// ---------------------------------------------------------------------------
// Migrate
// ---------------------------------------------------------------------------

export async function runAiLegacyMigration(deps: MigrateDeps, options: MigrateOptions): Promise<MigrateResult> {
  const { prisma, logger } = deps;
  const decrypt = deps.decrypt ?? decryptSecret;
  const problems: string[] = [];

  if (options.apply && !deps.userAiKeys) {
    throw new Error('--apply needs the platform UserAiKeysService; it was not provided.');
  }

  // ---- read everything the plan depends on --------------------------------
  const credentials = await prisma.userAiCredential.findMany({
    orderBy: { id: 'asc' },
    select: { id: true, userId: true, provider: true, secret: true, hint: true, label: true },
  });
  const existingKeys = await prisma.userAiKey.findMany({ select: { userId: true, provider: true, hint: true } });
  const existingModels = await prisma.aiModel.findMany({ where: { provider: LEGACY_PROVIDER_ID } });
  const settingsRow = await prisma.systemSettings.findUnique({ where: { key: SYSTEM_SETTINGS_ROW_KEY } });

  const rowValue = settingsRow && isRecord(settingsRow.value) ? settingsRow.value : null;
  const rawAi = rowValue && isRecord(rowValue.ai) ? rowValue.ai : null;
  const plan = rawAi ? planAiSettings(rawAi as unknown as LegacyAiValue) : null;
  logger.log(
    `read: credentials=${credentials.length} platformKeys=${existingKeys.length} openaiModels=${existingModels.length} ` +
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
      credentials: credentials.map(({ id, userId, provider, hint, label }) => ({ id, userId, provider, hint, label })),
      userAiKeys: existingKeys.map(({ userId, provider, hint }) => ({ userId, provider, hint })),
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

  // ---- keys -------------------------------------------------------------------
  const keys: AiLegacyReport['keys'] = {
    source: credentials.length,
    imported: 0,
    alreadyImported: 0,
    undecryptable: 0,
    failed: 0,
    target: 0,
  };
  const targetByPair = new Map(existingKeys.map((row) => [`${row.userId}\u0000${row.provider}`, row.hint]));

  for (const row of credentials) {
    let plaintext: string | null;
    try {
      plaintext = decrypt(row.secret, AI_CREDENTIAL_PURPOSE);
    } catch {
      plaintext = null;
    }
    if (plaintext === null || plaintext.trim() === '') {
      keys.undecryptable += 1;
      // The ciphertext is never printed. `userId` and `provider` are enough to find the row.
      logger.warn(`keys: undecryptable credential id=${row.id} userId=${row.userId} provider=${row.provider}`);
      continue;
    }

    const pair = `${row.userId}\u0000${row.provider}`;
    const hasTarget = targetByPair.has(pair);
    const targetHint = targetByPair.get(pair) ?? null;
    // The platform derives its hint from the trimmed key; the stored one came
    // from the key as typed. Either match means this key is already there.
    const expectedHint = deriveHint(plaintext.trim());
    const sameHint = hasTarget && (targetHint === (row.hint ?? null) || targetHint === (expectedHint ?? null));

    if (sameHint) {
      plaintext = null;
      keys.alreadyImported += 1;
      continue;
    }
    if (hasTarget) {
      logger.warn(
        `keys: replacing the platform key of userId=${row.userId} provider=${row.provider} ` +
          '(its hint differs from the legacy key)',
      );
    }

    if (!options.apply) {
      plaintext = null;
      keys.imported += 1; // planned
      continue;
    }
    try {
      await deps.userAiKeys!.importKey(row.userId, row.provider, plaintext, { source: KEY_IMPORT_SOURCE });
      keys.imported += 1;
      targetByPair.set(pair, expectedHint ?? null);
    } catch (error) {
      keys.failed += 1;
      logger.error(`keys: import failed for credential id=${row.id} provider=${row.provider}: ${describeError(error)}`);
    } finally {
      plaintext = null;
    }
  }
  logger.log(
    `keys: source=${keys.source} ${options.apply ? 'imported' : 'wouldImport'}=${keys.imported} ` +
      `alreadyImported=${keys.alreadyImported} undecryptable=${keys.undecryptable} failed=${keys.failed}`,
  );

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
  keys.target = await countImportedTargets(prisma);

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
  if (keys.source !== keys.imported + keys.alreadyImported + keys.undecryptable) {
    problems.push(
      `keys do not add up: source=${keys.source} but imported+alreadyImported+undecryptable=` +
        `${keys.imported + keys.alreadyImported + keys.undecryptable} (failed=${keys.failed})`,
    );
  }
  if (keys.undecryptable > 0 && !options.allowUndecryptable) {
    problems.push(`${keys.undecryptable} credential(s) could not be decrypted (pass --allow-undecryptable to accept)`);
  }
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
      meta: { namespace: 'ai', removedKeys: audit.removed, modelsUpserted: audit.modelsUpserted, source: KEY_IMPORT_SOURCE },
    },
  });
}

/** `user_ai_keys` rows that carry an import audit row from this migration (`source` is the app slug). */
async function countImportedTargets(prisma: MigratePrisma): Promise<number> {
  const rows = await prisma.$queryRaw<Array<{ count: bigint }>>`
    SELECT count(*)::bigint AS count
    FROM user_ai_keys k
    WHERE EXISTS (
      SELECT 1 FROM audit_events a
      WHERE a.action = ${KEY_IMPORT_AUDIT_ACTION}
        AND a.actor_user_id = k.user_id
        AND a.target_id = k.provider
        AND a.meta ->> 'source' = ${KEY_IMPORT_SOURCE}
    )`;
  return Number(rows[0]?.count ?? 0);
}

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------

export interface RestoreResult {
  settingsRestored: boolean;
  keysDeleted: number;
  modelsRestored: number;
  modelsDisabled: number;
}

/**
 * Undo `--apply` from its snapshot: write the old `ai` value back, delete the
 * `user_ai_keys` rows imported after the snapshot, restore the `ai_models` rows
 * the snapshot listed and disable the ones it did not. `user_ai_credentials` is
 * never touched.
 *
 * A platform key that existed before the migration and was REPLACED by an import
 * is deleted too: the snapshot holds hints, never secrets, so it cannot bring
 * that key back and the user enters it again.
 */
export async function runAiLegacyRestore(
  deps: Pick<MigrateDeps, 'prisma' | 'logger'>,
  snapshotPath: string,
  dryRun = false,
): Promise<RestoreResult> {
  const { prisma, logger } = deps;
  const snapshot = parseSnapshot(readFileSync(resolve(snapshotPath), 'utf8'));
  const takenAt = new Date(snapshot.takenAt);

  const imports = await prisma.auditEvent.findMany({
    where: { action: KEY_IMPORT_AUDIT_ACTION, createdAt: { gt: takenAt } },
    select: { actorUserId: true, targetId: true, meta: true },
  });
  const pairs = imports
    .filter((row) => row.actorUserId !== null && isRecord(row.meta) && row.meta.source === KEY_IMPORT_SOURCE)
    .map((row) => ({ userId: row.actorUserId as string, provider: row.targetId }));

  const snapshotIds = new Set(snapshot.aiModels.map((m) => m.modelId));
  const currentModels = await prisma.aiModel.findMany({ where: { provider: LEGACY_PROVIDER_ID }, select: { modelId: true, enabled: true } });
  const toDisable = currentModels.filter((m) => !snapshotIds.has(m.modelId) && m.enabled);

  const result: RestoreResult = {
    settingsRestored: false,
    keysDeleted: 0,
    modelsRestored: snapshot.aiModels.length,
    modelsDisabled: toDisable.length,
  };

  if (dryRun) {
    result.keysDeleted = pairs.length;
    result.settingsRestored = snapshot.settingsRowExisted;
    logger.log(`restore (dry run): would restore the ai value, delete up to ${pairs.length} imported key(s), restore ${result.modelsRestored} model row(s), disable ${result.modelsDisabled}`);
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

    for (const pair of pairs) {
      const deleted = await tx.userAiKey.deleteMany({ where: { userId: pair.userId, provider: pair.provider } });
      result.keysDeleted += deleted.count;
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
    `restore: aiValue=${result.settingsRestored ? 'restored' : 'untouched'} importedKeysDeleted=${result.keysDeleted} ` +
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
  if (!isRecord(parsed) || parsed.version !== SNAPSHOT_VERSION || typeof parsed.takenAt !== 'string' || Number.isNaN(Date.parse(parsed.takenAt)) || !Array.isArray(parsed.aiModels)) {
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
    `${report.dryRun ? 'DRY RUN (nothing was written; imported/upserted are planned numbers)' : 'APPLIED'}`,
    `keys: source=${keys.source} imported=${keys.imported} alreadyImported=${keys.alreadyImported} ` +
      `undecryptable=${keys.undecryptable} failed=${keys.failed} target=${keys.target}`,
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
  --apply                 Import the keys, upsert ai_models, rewrite the ai settings.
  --snapshot <file>       Where --apply writes the pre-migration snapshot
                          (default ./ai-legacy-snapshot-<timestamp>.json).
  --restore <file>        Undo a previous --apply from its snapshot.
  --allow-undecryptable   Exit 0 although some stored keys cannot be decrypted.
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
      'allow-undecryptable': { type: 'boolean', default: false },
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

  // Fail early, with the message that names the variable, before a connection opens.
  assertEncryptionKeyConfigured();

  const snapshotPath =
    args.snapshot ?? `./ai-legacy-snapshot-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;

  if (args.restore && !existsSync(resolve(args.restore))) {
    process.stderr.write(`Snapshot file not found: ${args.restore}\n`);
    return 2;
  }

  if (args.apply) {
    return runApplyInApplication(logger, snapshotPath, args['allow-undecryptable'] === true);
  }

  // Dry run and restore need only the database, not the application graph.
  const prisma = new PrismaClient({ adapter: new PrismaPg(buildDatabaseUrl()) });
  try {
    await prisma.$connect();
    if (args.restore) {
      await runAiLegacyRestore({ prisma, logger }, args.restore, args['dry-run'] === true);
      return 0;
    }
    const result = await runAiLegacyMigration(
      { prisma, logger },
      { apply: false, snapshotPath, allowUndecryptable: args['allow-undecryptable'] === true },
    );
    process.stdout.write(`${formatReport(result.report)}\n`);
    for (const problem of result.problems) process.stderr.write(`PROBLEM: ${problem}\n`);
    return result.exitCode;
  } finally {
    await prisma.$disconnect();
  }
}

/**
 * `--apply` boots the application context: `importKey` needs the platform AI
 * slice wired as in the server (its settings, registry and job queue), which is
 * the one thing a bare Prisma client cannot give it. Background work is switched
 * off first so this process claims no job and runs no sweep while it works.
 */
async function runApplyInApplication(logger: MigrateLogger, snapshotPath: string, allowUndecryptable: boolean): Promise<number> {
  process.env.JOBS_WORKER_MODE = 'off';
  process.env.JOBS_REAPER_ENABLED = 'false';
  process.env.DB_BACKUP_SCHEDULE_ENABLED = 'false';
  process.env.KG_MIGRATE_SCHEDULE_ENABLED = 'false';

  // `require`, not `import()`: under NodeNext a dynamic import of a relative path
  // is resolved as ESM and wants an extension. These loads must also happen AFTER
  // the environment above is set, because the job and schedule modules read it
  // while they are constructed.
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { NestFactory } = require('@nestjs/core') as typeof import('@nestjs/core');
  const { AppModule } = require('../../app.module') as typeof import('../../app.module');
  const { PrismaService } = require('../../prisma/prisma.service') as typeof import('../../prisma/prisma.service');
  const { UserAiKeysService: UserAiKeysServiceToken } =
    require('@marinoscar/platform-api/ai') as typeof import('@marinoscar/platform-api/ai');
  /* eslint-enable @typescript-eslint/no-require-imports */

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn', 'log'] });
  try {
    const prisma = app.get(PrismaService);
    let userAiKeys: UserAiKeysService;
    try {
      userAiKeys = app.get(UserAiKeysServiceToken, { strict: false });
    } catch {
      throw new Error(
        'The platform UserAiKeysService is not part of this build\'s application graph. --apply needs the ' +
          'platform AI slice mounted (AiModule.forRoot, issue #473). Nothing was changed.',
      );
    }
    const result = await runAiLegacyMigration(
      { prisma, userAiKeys, logger },
      { apply: true, snapshotPath, allowUndecryptable },
    );
    process.stdout.write(`${formatReport(result.report)}\n`);
    for (const problem of result.problems) process.stderr.write(`PROBLEM: ${problem}\n`);
    return result.exitCode;
  } finally {
    await app.close();
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
