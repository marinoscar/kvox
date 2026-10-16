// =============================================================================
// Real-Postgres test: the legacy AI key and settings migration (issue #474)
// =============================================================================
//
// `runAiLegacyMigration` / `runAiLegacyRestore` against a migrated database,
// with the platform's own `UserAiKeysService.importKey` doing the key writes.
//
// It does NOT boot `AppModule`: the command takes its collaborators as
// arguments, and `importKey` needs only the Prisma client (plus an optional job
// queue, replaced here by a recording stub). That keeps the spec independent of
// the rest of the AI slice wiring, and fast.
//
// Runs through `npm run test:db`; skipped when no Postgres is reachable.
// Everything it writes is removed again, and the `global` settings row and the
// `openai` rows of `ai_models` are put back exactly as they were.
// =============================================================================

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { UserAiKeysService } from '@marinoscar/platform-api/ai';
import { deriveHint } from '@marinoscar/platform-api/credentials';
import { encryptSecret } from '@marinoscar/platform-api/core';
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

const EMAIL_PREFIX = 'ai-legacy-migrate-test';
const SETTINGS_KEY = 'global';

const PLAINTEXT = {
  a: 'sk-test-AAAA-legacy-migrate-0000000000001111',
  b: 'sk-test-BBBB-legacy-migrate-0000000000002222',
  d: 'sk-test-DDDD-legacy-migrate-0000000000004444',
  existing: 'sk-test-EEEE-platform-already-here-0009999',
};

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
  let userIds: { a: string; b: string; c: string; d: string };
  let ciphertexts: string[];
  let jobsEnqueue: jest.Mock;
  let keys: UserAiKeysService;
  let logs: string[];

  let savedSettings: { value: unknown; version: number } | null;
  let savedModels: Array<Record<string, unknown>>;

  const previousKey = process.env.SECRETS_ENCRYPTION_KEY;

  beforeAll(async () => {
    process.env.SECRETS_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');
    const { DATABASE_URL: _ignored, ...envWithoutDatabaseUrl } = process.env;
    prisma = new PrismaClient({ adapter: new PrismaPg(buildDatabaseUrl(envWithoutDatabaseUrl)) });
    await prisma.$connect();
    workDir = mkdtempSync(join(tmpdir(), 'ai-legacy-migrate-'));
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    if (workDir) rmSync(workDir, { recursive: true, force: true });
    if (previousKey === undefined) delete process.env.SECRETS_ENCRYPTION_KEY;
    else process.env.SECRETS_ENCRYPTION_KEY = previousKey;
  });

  async function wipeOwnRows(): Promise<void> {
    const users = await prisma.user.findMany({ where: { email: { startsWith: EMAIL_PREFIX } }, select: { id: true } });
    const ids = users.map((u) => u.id);
    await prisma.auditEvent.deleteMany({ where: { actorUserId: { in: ids } } });
    await prisma.auditEvent.deleteMany({ where: { action: { startsWith: 'system_settings:ai-legacy-' } } });
    await prisma.userAiKey.deleteMany({ where: { userId: { in: ids } } });
    await prisma.userAiCredential.deleteMany({ where: { userId: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  }

  beforeEach(async () => {
    await wipeOwnRows();

    // Remember what the shared tables held, to put it back afterwards.
    const row = await prisma.systemSettings.findUnique({ where: { key: SETTINGS_KEY } });
    savedSettings = row ? { value: row.value, version: row.version } : null;
    savedModels = (await prisma.aiModel.findMany({ where: { provider: 'openai' } })) as unknown as Array<Record<string, unknown>>;
    await prisma.aiModel.deleteMany({ where: { provider: 'openai' } });

    // Four users; `c` holds a credential encrypted under another purpose, which
    // the legacy cipher cannot open.
    const make = async (suffix: string) =>
      (await prisma.user.create({ data: { email: `${EMAIL_PREFIX}-${suffix}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test` } })).id;
    userIds = { a: await make('a'), b: await make('b'), c: await make('c'), d: await make('d') };

    const sealed = {
      a: encryptSecret(PLAINTEXT.a, 'ai-key'),
      b: encryptSecret(PLAINTEXT.b, 'ai-key'),
      c: encryptSecret('sk-test-CCCC-not-readable-0003333', 'smtp'),
    };
    ciphertexts = Object.values(sealed);
    await prisma.userAiCredential.createMany({
      data: [
        { userId: userIds.a, provider: 'openai', secret: sealed.a, hint: deriveHint(PLAINTEXT.a), label: 'work' },
        { userId: userIds.b, provider: 'openai', secret: sealed.b, hint: deriveHint(PLAINTEXT.b) },
        { userId: userIds.c, provider: 'openai', secret: sealed.c, hint: '••••3333' },
      ],
    });

    const base = (row?.value && typeof row.value === 'object' && !Array.isArray(row.value) ? row.value : {}) as Record<string, unknown>;
    await prisma.systemSettings.upsert({
      where: { key: SETTINGS_KEY },
      create: { key: SETTINGS_KEY, value: { ...base, ai: legacyAiValue() } as unknown as Prisma.InputJsonValue },
      update: { value: { ...base, ai: legacyAiValue() } as unknown as Prisma.InputJsonValue },
    });

    jobsEnqueue = jest.fn().mockResolvedValue({ id: 'job' });
    keys = new UserAiKeysService(prisma as never, {} as never, {} as never, { enqueue: jobsEnqueue } as never);
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
      userAiKeys: keys,
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
  const ownKeys = () => prisma.userAiKey.findMany({ where: { userId: { in: Object.values(userIds) } }, orderBy: { userId: 'asc' } });

  // ===========================================================================
  // --dry-run
  // ===========================================================================

  it('--dry-run reports the plan and writes nothing', async () => {
    const before = await globalRow();
    const auditBefore = await prisma.auditEvent.count();
    const file = snapshotFile();

    const result = await runAiLegacyMigration(deps(), { apply: false, snapshotPath: file, allowUndecryptable: false });

    expect(result.report).toMatchObject({
      dryRun: true,
      keys: { source: 3, imported: 2, alreadyImported: 0, undecryptable: 1, failed: 0, target: 0 },
      models: { allowed: 3, upserted: 4, enabled: 4 },
      settings: { enabled: true, providerEnabled: true, defaultModel: 'gpt-4o-mini', taskModels: ['graph.agent', 'graph.extract'] },
    });
    expect(result.exitCode).toBe(1); // one undecryptable key

    expect(await ownKeys()).toHaveLength(0);
    expect(await prisma.aiModel.count({ where: { provider: 'openai' } })).toBe(0);
    const after = await globalRow();
    expect(after.version).toBe(before.version);
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
    expect(after.value).toEqual(before.value);
    expect(await prisma.auditEvent.count()).toBe(auditBefore);
    expect(jobsEnqueue).not.toHaveBeenCalled();
    expect(existsSync(file)).toBe(false);
  });

  it('exits 0 on a dry run when undecryptable keys are accepted', async () => {
    const result = await runAiLegacyMigration(deps(), { apply: false, snapshotPath: snapshotFile(), allowUndecryptable: true });
    expect(result.exitCode).toBe(0);
    expect(result.problems).toEqual([]);
  });

  // ===========================================================================
  // --apply
  // ===========================================================================

  describe('--apply', () => {
    it('imports every decryptable key through importKey, audited with source kvox', async () => {
      const result = await runAiLegacyMigration(deps(), { apply: true, snapshotPath: snapshotFile(), allowUndecryptable: true });

      expect(result.report.keys).toEqual({ source: 3, imported: 2, alreadyImported: 0, undecryptable: 1, failed: 0, target: 2 });
      expect(result.exitCode).toBe(0);

      const stored = await ownKeys();
      expect(stored.map((k) => k.userId).sort()).toEqual([userIds.a, userIds.b].sort());
      expect(stored.find((k) => k.userId === userIds.a)).toMatchObject({
        provider: 'openai',
        hint: deriveHint(PLAINTEXT.a),
        verifiedAt: null,
      });
      // The platform can open what was imported, under its own purpose.
      expect(await keys.getDecrypted(userIds.a, 'openai')).toBe(PLAINTEXT.a);
      expect(await keys.getDecrypted(userIds.b, 'openai')).toBe(PLAINTEXT.b);

      const audits = await prisma.auditEvent.findMany({ where: { action: 'ai:user-key:import', actorUserId: { in: [userIds.a, userIds.b] } } });
      expect(audits).toHaveLength(2);
      for (const audit of audits) expect(audit.meta).toMatchObject({ provider: 'openai', source: 'kvox' });

      expect(jobsEnqueue).toHaveBeenCalledTimes(2);
      expect(jobsEnqueue).toHaveBeenCalledWith(expect.objectContaining({ type: 'ai.keys.recheck' }));
    });

    it('reports the undecryptable credential by id and provider and exits non-zero without --allow-undecryptable', async () => {
      const result = await runAiLegacyMigration(deps(), { apply: true, snapshotPath: snapshotFile(), allowUndecryptable: false });

      expect(result.exitCode).toBe(1);
      expect(result.problems.join(' ')).toMatch(/could not be decrypted/);
      const credential = await prisma.userAiCredential.findFirstOrThrow({ where: { userId: userIds.c } });
      expect(logs.some((line) => line.includes(`id=${credential.id}`) && line.includes(`userId=${userIds.c}`) && line.includes('provider=openai'))).toBe(true);
    });

    it('upserts one enabled admin_override row per allowedModels entry, with overrides in the columns', async () => {
      await runAiLegacyMigration(deps(), { apply: true, snapshotPath: snapshotFile(), allowUndecryptable: true });

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

      const result = await runAiLegacyMigration(deps(), { apply: true, snapshotPath: snapshotFile(), allowUndecryptable: true });
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

    it('writes the snapshot first, with hints and ids but no key and no ciphertext', async () => {
      const file = snapshotFile();
      await runAiLegacyMigration(deps(), { apply: true, snapshotPath: file, allowUndecryptable: true });

      expect(statSync(file).mode & 0o077).toBe(0); // owner only
      const snapshot = JSON.parse(readFileSync(file, 'utf8'));
      expect(snapshot.version).toBe(1);
      expect(snapshot.aiValue).toEqual(legacyAiValue());
      expect(snapshot.credentials).toHaveLength(3);
      expect(snapshot.credentials[0]).toEqual(expect.objectContaining({ id: expect.any(String), userId: expect.any(String), provider: 'openai' }));
      for (const credential of snapshot.credentials) expect(credential).not.toHaveProperty('secret');
    });

    it('leaks no plaintext key and no ciphertext into a log line, the report, the snapshot or the report file', async () => {
      const file = snapshotFile();
      const result = await runAiLegacyMigration(deps(), { apply: true, snapshotPath: file, allowUndecryptable: true });

      const everything = [
        logs.join('\n'),
        formatReport(result.report),
        JSON.stringify(result),
        readFileSync(file, 'utf8'),
        readFileSync(file.replace(/\.json$/, '') + '.report.json', 'utf8'),
      ].join('\n');

      for (const secret of [...Object.values(PLAINTEXT), ...ciphertexts]) {
        expect(everything).not.toContain(secret);
      }
      // Not even the distinctive middle of a key.
      expect(everything).not.toMatch(/legacy-migrate-0000/);
    });

    it('refuses to continue, and changes nothing, when the snapshot cannot be written', async () => {
      const before = await globalRow();
      const blocker = join(workDir, `blocker-${Date.now()}`);
      writeFileSync(blocker, 'a file where a directory is needed');

      await expect(
        runAiLegacyMigration(deps(), { apply: true, snapshotPath: join(blocker, 'snapshot.json'), allowUndecryptable: true }),
      ).rejects.toThrow(/Refusing to --apply/);

      expect(await ownKeys()).toHaveLength(0);
      expect(await prisma.aiModel.count({ where: { provider: 'openai' } })).toBe(0);
      expect((await globalRow()).version).toBe(before.version);
      expect(jobsEnqueue).not.toHaveBeenCalled();
    });

    it('never overwrites an existing snapshot', async () => {
      const file = snapshotFile();
      writeFileSync(file, 'precious');

      await expect(
        runAiLegacyMigration(deps(), { apply: true, snapshotPath: file, allowUndecryptable: true }),
      ).rejects.toThrow(/Refusing to --apply/);
      expect(readFileSync(file, 'utf8')).toBe('precious');
      expect(await ownKeys()).toHaveLength(0);
    });

    it('counts a key importKey rejects as failed, keeps going, and exits non-zero', async () => {
      const real = keys;
      const flaky = {
        importKey: jest.fn(async (userId: string, provider: string, plaintext: string, opts: { source: string }) => {
          if (userId === userIds.a) throw Object.assign(new Error(`boom ${plaintext}`), { code: 'AI_INVALID_REQUEST' });
          return real.importKey(userId, provider, plaintext, opts);
        }),
      };

      const result = await runAiLegacyMigration(deps({ userAiKeys: flaky }), {
        apply: true,
        snapshotPath: snapshotFile(),
        allowUndecryptable: true,
      });

      expect(result.report.keys).toMatchObject({ imported: 1, failed: 1, undecryptable: 1 });
      expect(result.exitCode).toBe(1);
      expect((await ownKeys()).map((k) => k.userId)).toEqual([userIds.b]);
      // The error's message embedded the key; the log carries only the class and code.
      expect(logs.join('\n')).not.toContain(PLAINTEXT.a);
      expect(logs.join('\n')).toContain('Error (AI_INVALID_REQUEST)');
    });

    it('replaces a platform key whose hint differs, and warns', async () => {
      await prisma.userAiCredential.create({
        data: { userId: userIds.d, provider: 'openai', secret: encryptSecret(PLAINTEXT.d, 'ai-key'), hint: deriveHint(PLAINTEXT.d) },
      });
      await keys.importKey(userIds.d, 'openai', PLAINTEXT.existing, { source: 'user' });
      jobsEnqueue.mockClear();

      const result = await runAiLegacyMigration(deps(), { apply: true, snapshotPath: snapshotFile(), allowUndecryptable: true });

      expect(result.report.keys.imported).toBe(3);
      expect(await keys.getDecrypted(userIds.d, 'openai')).toBe(PLAINTEXT.d);
      expect(logs.some((line) => line.includes('replacing the platform key') && line.includes(userIds.d))).toBe(true);
    });
  });

  // ===========================================================================
  // idempotence
  // ===========================================================================

  describe('a second --apply', () => {
    it('imports zero, reports the keys as alreadyImported, and touches neither settings nor models', async () => {
      await runAiLegacyMigration(deps(), { apply: true, snapshotPath: snapshotFile(), allowUndecryptable: true });

      // An administrator adjusts a migrated model in between.
      await prisma.aiModel.update({
        where: { provider_modelId: { provider: 'openai', modelId: 'gpt-5.4' } },
        data: { enabled: false, displayName: 'Renamed by an admin' },
      });
      const settingsBefore = await globalRow();
      const keysBefore = await ownKeys();
      jobsEnqueue.mockClear();

      const second = await runAiLegacyMigration(deps(), { apply: true, snapshotPath: snapshotFile(), allowUndecryptable: true });

      expect(second.report.keys).toEqual({ source: 3, imported: 0, alreadyImported: 2, undecryptable: 1, failed: 0, target: 2 });
      expect(second.exitCode).toBe(0);
      expect(second.report.models.upserted).toBe(0);
      expect(jobsEnqueue).not.toHaveBeenCalled();

      const keysAfter = await ownKeys();
      expect(keysAfter.map((k) => k.updatedAt.getTime())).toEqual(keysBefore.map((k) => k.updatedAt.getTime()));

      const settingsAfter = await globalRow();
      expect(settingsAfter.version).toBe(settingsBefore.version);
      expect(settingsAfter.value).toEqual(settingsBefore.value);

      const five = await prisma.aiModel.findUniqueOrThrow({ where: { provider_modelId: { provider: 'openai', modelId: 'gpt-5.4' } } });
      expect(five).toMatchObject({ enabled: false, displayName: 'Renamed by an admin' });
      expect(await prisma.aiModel.count({ where: { provider: 'openai' } })).toBe(4);
    });

    it('does not reset a key policy an administrator changed after the first run', async () => {
      await runAiLegacyMigration(deps(), { apply: true, snapshotPath: snapshotFile(), allowUndecryptable: true });
      const row = await globalRow();
      const value = row.value as Record<string, Record<string, unknown>>;
      await prisma.systemSettings.update({
        where: { key: SETTINGS_KEY },
        data: { value: { ...value, ai: { ...value.ai, keyPolicy: 'byok_with_org_fallback' } } as unknown as Prisma.InputJsonValue },
      });

      await runAiLegacyMigration(deps(), { apply: true, snapshotPath: snapshotFile(), allowUndecryptable: true });

      expect((await rawAi()).keyPolicy).toBe('byok_with_org_fallback');
    });
  });

  // ===========================================================================
  // --restore
  // ===========================================================================

  describe('--restore', () => {
    it('brings back the pre-migration ai value and removes the imported keys, leaving user_ai_credentials alone', async () => {
      const file = snapshotFile();
      const settingsBefore = await globalRow();
      await runAiLegacyMigration(deps(), { apply: true, snapshotPath: file, allowUndecryptable: true });
      expect(await ownKeys()).toHaveLength(2);

      const restored = await runAiLegacyRestore({ prisma, logger: deps().logger }, file);

      expect(restored).toMatchObject({ settingsRestored: true, keysDeleted: 2, modelsDisabled: 4 });
      expect(await rawAi()).toEqual(legacyAiValue());
      expect((await globalRow()).value).toEqual(settingsBefore.value);
      expect(await ownKeys()).toHaveLength(0);
      expect(await prisma.userAiCredential.count({ where: { userId: { in: Object.values(userIds) } } })).toBe(3);

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
      await runAiLegacyMigration(deps(), { apply: true, snapshotPath: file, allowUndecryptable: true });
      expect(
        await prisma.aiModel.findUniqueOrThrow({ where: { provider_modelId: { provider: 'openai', modelId: 'gpt-4o-mini' } } }),
      ).toMatchObject({ enabled: true, capabilitySource: 'admin_override' });

      await runAiLegacyRestore({ prisma, logger: deps().logger }, file);

      expect(
        await prisma.aiModel.findUniqueOrThrow({ where: { provider_modelId: { provider: 'openai', modelId: 'gpt-4o-mini' } } }),
      ).toMatchObject({ enabled: false, displayName: 'Before', capabilitySource: 'catalog', contextWindow: 1_000, maxOutputTokens: 100 });
    });

    it('leaves a key imported before the snapshot alone', async () => {
      await keys.importKey(userIds.a, 'openai', PLAINTEXT.a, { source: 'kvox' });
      await new Promise((resolve) => setTimeout(resolve, 20));
      const file = snapshotFile();
      const result = await runAiLegacyMigration(deps(), { apply: true, snapshotPath: file, allowUndecryptable: true });
      expect(result.report.keys).toMatchObject({ imported: 1, alreadyImported: 1 });

      const restored = await runAiLegacyRestore({ prisma, logger: deps().logger }, file);

      expect(restored.keysDeleted).toBe(1);
      expect((await ownKeys()).map((k) => k.userId)).toEqual([userIds.a]);
    });

    it('--restore --dry-run changes nothing', async () => {
      const file = snapshotFile();
      await runAiLegacyMigration(deps(), { apply: true, snapshotPath: file, allowUndecryptable: true });
      const migrated = await globalRow();

      await runAiLegacyRestore({ prisma, logger: deps().logger }, file, true);

      expect((await globalRow()).value).toEqual(migrated.value);
      expect(await ownKeys()).toHaveLength(2);
    });

    it('refuses a file that is not a snapshot', async () => {
      const file = snapshotFile();
      writeFileSync(file, JSON.stringify({ hello: 'world' }));
      await expect(runAiLegacyRestore({ prisma, logger: deps().logger }, file)).rejects.toThrow(/not an AI legacy migration snapshot/);
    });
  });
});
