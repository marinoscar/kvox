// =============================================================================
// Real-Postgres test: the legacy AI settings and models migration
// (issue #474, epic #472; keys retired by issue #477)
// =============================================================================
//
// `runAiLegacyMigration` / `runAiLegacyRestore` against a migrated database.
//
// It does NOT boot `AppModule`: the command takes a Prisma client and a logger.
// That keeps the spec independent of the rest of the AI slice wiring, and fast.
//
// KEYS. Issue #477 dropped `user_ai_credentials`, so this build migrates no key.
// The cases that used to import keys are gone with the table; what is left pins
// the contract that replaced them: with the table absent the command says there
// is nothing to migrate for keys, and a deployment that still holds legacy key
// rows (the table created ad hoc below) is refused, because the upgrade drops
// them. Those key rows were imported by the build before #477.
//
// Runs through `npm run test:db`; skipped when no Postgres is reachable.
// Everything it writes is removed again, and the `global` settings row and the
// `openai` rows of `ai_models` are put back exactly as they were.
// =============================================================================

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { systemAiProviderSchema } from '@marinoscar/platform-contract/ai';

import { buildDatabaseUrl } from '../../src/common/database-url';
import {
  formatReport,
  runAiLegacyMigration,
  runAiLegacyRestore,
  type MigrateDeps,
} from '../../src/ai-port/migrate/ai-legacy-migrate';

function isPostgresReachable(host: string, port: number, timeoutMs = 2000): boolean {
  try {
    const probe = `
      const net = require('net');
      const socket = net.createConnection({ host: process.argv[1], port: Number(process.argv[2]) });
      const done = (ok) => { try { socket.destroy(); } catch (_e) {} process.exit(ok ? 0 : 1); };
      socket.setTimeout(${timeoutMs});
      socket.on('connect', () => done(true));
      socket.on('timeout', () => done(false));
      socket.on('error', () => done(false));
    `;
    execFileSync(process.execPath, ['-e', probe, host, String(port)], { stdio: 'ignore', timeout: timeoutMs + 1000 });
    return true;
  } catch {
    return false;
  }
}

const postgresHost = process.env.POSTGRES_HOST;
const postgresPort = Number(process.env.POSTGRES_PORT) || 5432;
const dbReachable = Boolean(postgresHost) && isPostgresReachable(postgresHost as string, postgresPort);

if (!dbReachable) {
  // eslint-disable-next-line no-console
  console.warn(
    `\n[ai-legacy-migrate.db.spec] SKIPPED: no Postgres reachable at ${postgresHost ?? '(POSTGRES_HOST unset)'}:${postgresPort}. ` +
      'Point POSTGRES_HOST/POSTGRES_PORT at a migrated database and re-run `npm run test:db`.\n',
  );
}

const describeWithDb = dbReachable ? describe : describe.skip;

const SETTINGS_KEY = 'global';

/** Stands in for ciphertext in the ad hoc legacy table: it must never reach a log, report or snapshot. */
const LEGACY_SECRET_MARKER = 'legacy-ciphertext-marker-0000000000001111';

/** The pre-upgrade `ai` value: kvox's stored shape, mixed allowedModels entries. */
function legacyAiValue() {
  return {
    enabled: true,
    provider: 'openai',
    providers: {
      openai: {
        baseUrl: 'https://api.openai.com/v1',
        allowedModels: [
          'gpt-4o-mini',
          { id: 'gpt-5.4', label: 'GPT-5.4 (team)' },
          { id: 'acme-private-1', label: 'Acme private', contextWindowTokens: 64_000, maxOutputTokens: 4_096 },
        ],
        defaultModel: 'gpt-4o-mini',
      },
    },
    maxInputTokens: null,
    maxOutputTokens: 8_000,
    requestTimeoutMs: 600_000,
    reasoningEffort: 'medium',
    maxDocumentBytes: 26_214_400,
    taskModels: {
      'graph.extract': { model: 'gpt-4.1', reasoningEffort: 'low' },
      'graph.agent': { model: 'gpt-5.4' },
    },
    graphEnabled: true,
  };
}

describeWithDb('legacy AI migration (real Postgres)', () => {
  let prisma: PrismaClient;
  let workDir: string;
  let logs: string[];

  let savedSettings: { value: unknown; version: number } | null;
  let savedModels: Array<Record<string, unknown>>;

  beforeAll(async () => {
    const { DATABASE_URL: _ignored, ...envWithoutDatabaseUrl } = process.env;
    prisma = new PrismaClient({ adapter: new PrismaPg(buildDatabaseUrl(envWithoutDatabaseUrl)) });
    await prisma.$connect();
    workDir = mkdtempSync(join(tmpdir(), 'ai-legacy-migrate-'));
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  });

  async function wipeOwnRows(): Promise<void> {
    await prisma.auditEvent.deleteMany({ where: { action: { startsWith: 'system_settings:ai-legacy-' } } });
  }

  beforeEach(async () => {
    await wipeOwnRows();

    // Remember what the shared tables held, to put it back afterwards.
    const row = await prisma.systemSettings.findUnique({ where: { key: SETTINGS_KEY } });
    savedSettings = row ? { value: row.value, version: row.version } : null;
    savedModels = (await prisma.aiModel.findMany({ where: { provider: 'openai' } })) as unknown as Array<Record<string, unknown>>;
    await prisma.aiModel.deleteMany({ where: { provider: 'openai' } });

    const base = (row?.value && typeof row.value === 'object' && !Array.isArray(row.value) ? row.value : {}) as Record<string, unknown>;
    await prisma.systemSettings.upsert({
      where: { key: SETTINGS_KEY },
      create: { key: SETTINGS_KEY, value: { ...base, ai: legacyAiValue() } as unknown as Prisma.InputJsonValue },
      update: { value: { ...base, ai: legacyAiValue() } as unknown as Prisma.InputJsonValue },
    });

    logs = [];
  });

  afterEach(async () => {
    await wipeOwnRows();
    await prisma.aiModel.deleteMany({ where: { provider: 'openai' } });
    for (const model of savedModels) {
      const { id: _id, updatedAt: _updated, ...rest } = model as Record<string, unknown> & { id: string; updatedAt: Date };
      await prisma.aiModel.create({ data: rest as unknown as Prisma.AiModelUncheckedCreateInput });
    }
    if (savedSettings) {
      await prisma.systemSettings.update({
        where: { key: SETTINGS_KEY },
        data: { value: savedSettings.value as Prisma.InputJsonValue, version: savedSettings.version },
      });
    } else {
      await prisma.systemSettings.deleteMany({ where: { key: SETTINGS_KEY } });
    }
  });

  function deps(overrides: Partial<MigrateDeps> = {}): MigrateDeps {
    const sink = (message: string) => void logs.push(message);
    return {
      prisma,
      logger: { log: sink, warn: sink, error: sink },
      ...overrides,
    };
  }

  let counter = 0;
  const snapshotFile = () => join(workDir, `snapshot-${Date.now()}-${counter++}.json`);

  async function globalRow() {
    return prisma.systemSettings.findUniqueOrThrow({ where: { key: SETTINGS_KEY } });
  }
  async function rawAi() {
    return ((await globalRow()).value as Record<string, unknown>).ai as Record<string, unknown>;
  }

  /** True when the retired key table exists (a database that has not run the #477 migration). */
  async function legacyTableExists(): Promise<boolean> {
    const rows = await prisma.$queryRaw<Array<{ present: boolean }>>`
      SELECT to_regclass('public.user_ai_credentials') IS NOT NULL AS present`;
    return rows[0]?.present === true;
  }

  // ===========================================================================
  // keys: not migrated by this build
  // ===========================================================================

  describe('keys', () => {
    it('says there is nothing to migrate for keys when the legacy table is absent', async () => {
      if (await legacyTableExists()) return; // a database that predates the #477 migration

      const result = await runAiLegacyMigration(deps(), { apply: false, snapshotPath: snapshotFile() });

      expect(result.report.keys).toEqual({ skipped: true, legacyTablePresent: false, legacyRows: 0 });
      expect(result.exitCode).toBe(0);
      expect(result.problems).toEqual([]);
      expect(logs.some((line) => line.includes('keys: nothing to migrate'))).toBe(true);
      expect(formatReport(result.report)).toContain('keys: nothing to migrate');
    });

    describe('with the legacy table still holding rows (created ad hoc here)', () => {
      let created = false;

      beforeEach(async () => {
        if (await legacyTableExists()) return;
        // Only the columns the command reads (existence and a row count).
        await prisma.$executeRawUnsafe(
          'CREATE TABLE user_ai_credentials (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, provider text NOT NULL)',
        );
        created = true;
      });

      afterEach(async () => {
        if (created) await prisma.$executeRawUnsafe('DROP TABLE IF EXISTS user_ai_credentials');
        created = false;
      });

      it('a dry run fails with a problem naming the previous build, writing nothing', async () => {
        if (!created) return;
        await prisma.$executeRawUnsafe(
          `INSERT INTO user_ai_credentials (user_id, provider) VALUES (gen_random_uuid(), 'openai')`,
        );
        const before = await globalRow();

        const result = await runAiLegacyMigration(deps(), { apply: false, snapshotPath: snapshotFile() });

        expect(result.report.keys).toEqual({ skipped: true, legacyTablePresent: true, legacyRows: 1 });
        expect(result.exitCode).toBe(1);
        expect(result.problems.join(' ')).toMatch(/PREVIOUS build/);
        expect((await globalRow()).version).toBe(before.version);
      });

      it('--apply refuses, before the snapshot and before any write', async () => {
        if (!created) return;
        await prisma.$executeRawUnsafe(
          `INSERT INTO user_ai_credentials (user_id, provider) VALUES (gen_random_uuid(), 'openai')`,
        );
        const before = await globalRow();
        const file = snapshotFile();

        await expect(runAiLegacyMigration(deps(), { apply: true, snapshotPath: file })).rejects.toThrow(/Refusing to --apply/);

        expect(existsSync(file)).toBe(false);
        expect(await prisma.aiModel.count({ where: { provider: 'openai' } })).toBe(0);
        expect((await globalRow()).version).toBe(before.version);
      });

      it('an EMPTY legacy table is not a problem', async () => {
        if (!created) return;

        const result = await runAiLegacyMigration(deps(), { apply: false, snapshotPath: snapshotFile() });

        expect(result.report.keys).toEqual({ skipped: true, legacyTablePresent: true, legacyRows: 0 });
        expect(result.exitCode).toBe(0);
      });
    });
  });

  // ===========================================================================
  // --dry-run
  // ===========================================================================

  it('--dry-run reports the plan and writes nothing', async () => {
    if (await legacyTableExists()) return;
    const before = await globalRow();
    const auditBefore = await prisma.auditEvent.count();
    const file = snapshotFile();

    const result = await runAiLegacyMigration(deps(), { apply: false, snapshotPath: file });

    expect(result.report).toMatchObject({
      dryRun: true,
      models: { allowed: 3, upserted: 4, enabled: 4 },
      settings: { enabled: true, providerEnabled: true, defaultModel: 'gpt-4o-mini', taskModels: ['graph.agent', 'graph.extract'] },
    });
    expect(result.exitCode).toBe(0);

    expect(await prisma.aiModel.count({ where: { provider: 'openai' } })).toBe(0);
    const after = await globalRow();
    expect(after.version).toBe(before.version);
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
    expect(after.value).toEqual(before.value);
    expect(await prisma.auditEvent.count()).toBe(auditBefore);
    expect(existsSync(file)).toBe(false);
  });

  // ===========================================================================
  // --apply
  // ===========================================================================

  describe('--apply', () => {
    it('upserts one enabled admin_override row per allowedModels entry, with overrides in the columns', async () => {
      await runAiLegacyMigration(deps(), { apply: true, snapshotPath: snapshotFile() });

      const rows = await prisma.aiModel.findMany({ where: { provider: 'openai' }, orderBy: { modelId: 'asc' } });
      expect(rows.map((r) => r.modelId)).toEqual(['acme-private-1', 'gpt-4o-mini', 'gpt-5.4', 'text-embedding-3-small']);
      for (const row of rows) expect(row).toMatchObject({ enabled: true, capabilitySource: 'admin_override' });

      const acme = rows.find((r) => r.modelId === 'acme-private-1')!;
      expect(acme).toMatchObject({ displayName: 'Acme private', contextWindow: 64_000, maxOutputTokens: 4_096 });
      const five = rows.find((r) => r.modelId === 'gpt-5.4')!;
      expect(five).toMatchObject({ displayName: 'GPT-5.4 (team)', contextWindow: 1_050_000, maxOutputTokens: 128_000 });
      expect((five.capabilities as { capabilities: string[] }).capabilities).toEqual(
        expect.arrayContaining(['responses', 'streaming', 'tools', 'structured_output', 'reasoning']),
      );

      const embedding = rows.find((r) => r.modelId === 'text-embedding-3-small')!;
      expect(embedding.enabled).toBe(true);
      expect(embedding.capabilities).toMatchObject({ capabilities: ['embeddings'], outputModalities: ['embedding'] });
    });

    it('rewrites the ai value: no provider, no allowedModels, taskModels byte-identical, other namespaces intact', async () => {
      const before = await globalRow();
      const beforeAi = before.value as Record<string, unknown>;
      const taskModelsBefore = JSON.stringify((beforeAi.ai as Record<string, unknown>).taskModels);

      const result = await runAiLegacyMigration(deps(), { apply: true, snapshotPath: snapshotFile() });
      const after = await globalRow();
      const ai = (after.value as Record<string, unknown>).ai as Record<string, unknown>;

      expect(ai).not.toHaveProperty('provider');
      const slot = (ai.providers as Record<string, Record<string, unknown>>).openai;
      expect(slot).toEqual({ enabled: true });
      expect(ai).toMatchObject({ enabled: true, keyPolicy: 'byok', defaultModel: 'gpt-4o-mini', graphEnabled: true });
      expect(JSON.stringify(ai.taskModels)).toBe(taskModelsBefore);
      expect(systemAiProviderSchema.safeParse(slot).success).toBe(true);

      // Every other namespace of the row is exactly what it was.
      const { ai: _a, ...restBefore } = beforeAi;
      const { ai: _b, ...restAfter } = after.value as Record<string, unknown>;
      expect(restAfter).toEqual(restBefore);

      expect(after.version).toBe(before.version + 1);
      expect(result.report.settings).toEqual({
        enabled: true,
        providerEnabled: true,
        defaultModel: 'gpt-4o-mini',
        taskModels: ['graph.agent', 'graph.extract'],
      });
      const audit = await prisma.auditEvent.findFirst({ where: { action: 'system_settings:ai-legacy-migrate' } });
      expect(audit).not.toBeNull();
    });

    it('writes the snapshot first, owner-only, with the ai value and the model rows', async () => {
      const file = snapshotFile();
      await runAiLegacyMigration(deps(), { apply: true, snapshotPath: file });

      expect(statSync(file).mode & 0o077).toBe(0); // owner only
      const snapshot = JSON.parse(readFileSync(file, 'utf8'));
      expect(snapshot.version).toBe(2);
      expect(snapshot.aiValue).toEqual(legacyAiValue());
      expect(snapshot).not.toHaveProperty('credentials');
      expect(snapshot).not.toHaveProperty('userAiKeys');
    });

    it('refuses to continue, and changes nothing, when the snapshot cannot be written', async () => {
      const before = await globalRow();
      const blocker = join(workDir, `blocker-${Date.now()}`);
      writeFileSync(blocker, 'a file where a directory is needed');

      await expect(
        runAiLegacyMigration(deps(), { apply: true, snapshotPath: join(blocker, 'snapshot.json') }),
      ).rejects.toThrow(/Refusing to --apply/);

      expect(await prisma.aiModel.count({ where: { provider: 'openai' } })).toBe(0);
      expect((await globalRow()).version).toBe(before.version);
    });

    it('never overwrites an existing snapshot', async () => {
      const file = snapshotFile();
      writeFileSync(file, 'precious');

      await expect(runAiLegacyMigration(deps(), { apply: true, snapshotPath: file })).rejects.toThrow(/Refusing to --apply/);
      expect(readFileSync(file, 'utf8')).toBe('precious');
    });
  });

  // ===========================================================================
  // idempotence
  // ===========================================================================

  describe('a second --apply', () => {
    it('touches neither settings nor models', async () => {
      await runAiLegacyMigration(deps(), { apply: true, snapshotPath: snapshotFile() });

      // An administrator adjusts a migrated model in between.
      await prisma.aiModel.update({
        where: { provider_modelId: { provider: 'openai', modelId: 'gpt-5.4' } },
        data: { enabled: false, displayName: 'Renamed by an admin' },
      });
      const settingsBefore = await globalRow();

      const second = await runAiLegacyMigration(deps(), { apply: true, snapshotPath: snapshotFile() });

      expect(second.exitCode).toBe(0);
      expect(second.report.models.upserted).toBe(0);

      const settingsAfter = await globalRow();
      expect(settingsAfter.version).toBe(settingsBefore.version);
      expect(settingsAfter.value).toEqual(settingsBefore.value);

      const five = await prisma.aiModel.findUniqueOrThrow({ where: { provider_modelId: { provider: 'openai', modelId: 'gpt-5.4' } } });
      expect(five).toMatchObject({ enabled: false, displayName: 'Renamed by an admin' });
      expect(await prisma.aiModel.count({ where: { provider: 'openai' } })).toBe(4);
    });

    it('does not reset a key policy an administrator changed after the first run', async () => {
      await runAiLegacyMigration(deps(), { apply: true, snapshotPath: snapshotFile() });
      const row = await globalRow();
      const value = row.value as Record<string, Record<string, unknown>>;
      await prisma.systemSettings.update({
        where: { key: SETTINGS_KEY },
        data: { value: { ...value, ai: { ...value.ai, keyPolicy: 'byok_with_org_fallback' } } as unknown as Prisma.InputJsonValue },
      });

      await runAiLegacyMigration(deps(), { apply: true, snapshotPath: snapshotFile() });

      expect((await rawAi()).keyPolicy).toBe('byok_with_org_fallback');
    });
  });

  // ===========================================================================
  // --restore
  // ===========================================================================

  describe('--restore', () => {
    it('brings back the pre-migration ai value and disables the model rows the snapshot did not list', async () => {
      const file = snapshotFile();
      const settingsBefore = await globalRow();
      await runAiLegacyMigration(deps(), { apply: true, snapshotPath: file });

      const restored = await runAiLegacyRestore({ prisma, logger: deps().logger }, file);

      expect(restored).toMatchObject({ settingsRestored: true, modelsDisabled: 4 });
      expect(restored).not.toHaveProperty('keysDeleted');
      expect(await rawAi()).toEqual(legacyAiValue());
      expect((await globalRow()).value).toEqual(settingsBefore.value);

      // The rows the snapshot did not list are disabled, not deleted.
      const rows = await prisma.aiModel.findMany({ where: { provider: 'openai' } });
      expect(rows).toHaveLength(4);
      expect(rows.every((r) => r.enabled === false)).toBe(true);
    });

    it('restores the earlier state of a model row the snapshot listed', async () => {
      await prisma.aiModel.create({
        data: {
          provider: 'openai',
          modelId: 'gpt-4o-mini',
          displayName: 'Before',
          enabled: false,
          capabilitySource: 'catalog',
          capabilities: { capabilities: ['responses'], inputModalities: ['text'], outputModalities: ['text'] },
          contextWindow: 1_000,
          maxOutputTokens: 100,
        },
      });
      const file = snapshotFile();
      await runAiLegacyMigration(deps(), { apply: true, snapshotPath: file });
      expect(
        await prisma.aiModel.findUniqueOrThrow({ where: { provider_modelId: { provider: 'openai', modelId: 'gpt-4o-mini' } } }),
      ).toMatchObject({ enabled: true, capabilitySource: 'admin_override' });

      await runAiLegacyRestore({ prisma, logger: deps().logger }, file);

      expect(
        await prisma.aiModel.findUniqueOrThrow({ where: { provider_modelId: { provider: 'openai', modelId: 'gpt-4o-mini' } } }),
      ).toMatchObject({ enabled: false, displayName: 'Before', capabilitySource: 'catalog', contextWindow: 1_000, maxOutputTokens: 100 });
    });

    it('accepts a version 1 snapshot (written before keys left the command) and leaves imported keys in place', async () => {
      const file = snapshotFile();
      const settingsBefore = await globalRow();
      await runAiLegacyMigration(deps(), { apply: true, snapshotPath: file });
      const snapshot = JSON.parse(readFileSync(file, 'utf8'));
      writeFileSync(
        file,
        JSON.stringify({ ...snapshot, version: 1, credentials: [], userAiKeys: [{ userId: 'x', provider: 'openai', hint: null }] }),
      );

      const restored = await runAiLegacyRestore({ prisma, logger: deps().logger }, file);

      expect(restored.settingsRestored).toBe(true);
      expect((await globalRow()).value).toEqual(settingsBefore.value);
      expect(logs.some((line) => line.includes('imported keys are left in place'))).toBe(true);
    });

    it('--restore --dry-run changes nothing', async () => {
      const file = snapshotFile();
      await runAiLegacyMigration(deps(), { apply: true, snapshotPath: file });
      const migrated = await globalRow();

      await runAiLegacyRestore({ prisma, logger: deps().logger }, file, true);

      expect((await globalRow()).value).toEqual(migrated.value);
    });

    it('refuses a file that is not a snapshot', async () => {
      const file = snapshotFile();
      writeFileSync(file, JSON.stringify({ hello: 'world' }));
      await expect(runAiLegacyRestore({ prisma, logger: deps().logger }, file)).rejects.toThrow(/not an AI legacy migration snapshot/);
    });
  });
});
