import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { PrismaService } from '../prisma/prisma.service';
import { AboutService, stripSecretLikeKeys } from './about.service';
import { aboutResponseSchema } from './about.dto';
import {
  DEFAULT_DEPLOY_INFO_PATH,
  resolveDeployInfoPath,
} from './deploy-info.schema';
import fixture from './__fixtures__/deploy-info.json';

// =============================================================================
// AboutService — tests (issue #124, epic #118)
// =============================================================================
//
// The file half runs against a REAL temporary file, not a mocked `fs`: the
// contract under test is "read this path on every request and classify what
// you find", and a mocked `readFile` would be testing the mock's idea of
// ENOENT rather than Node's. The database half is a bare `$queryRaw` stub —
// there is no database here, and the service must degrade to `database: null`
// when there is none in production either.
// =============================================================================

interface QueryRawStub {
  $queryRaw: jest.Mock;
}

/** Answers `SELECT version()` and the migrations query by inspecting the SQL. */
function stubDatabase(
  prisma: QueryRawStub,
  options: {
    version?: string;
    migrations?: Array<{ name: string; finishedAt: Date; applied: number }>;
  } = {},
): void {
  const {
    version = 'PostgreSQL 16.4 on x86_64-pc-linux-gnu',
    migrations = [
      {
        name: '20260901120000_add_note_exports',
        finishedAt: new Date('2026-09-14T22:41:12.000Z'),
        applied: 42,
      },
    ],
  } = options;

  prisma.$queryRaw.mockImplementation(async (strings: TemplateStringsArray) => {
    const sql = strings.join('?');
    if (sql.includes('version()')) return [{ version }];
    if (sql.includes('_prisma_migrations')) return migrations;
    throw new Error(`Unexpected query: ${sql}`);
  });
}

describe('AboutService', () => {
  let dir: string;
  let filePath: string;
  let prisma: QueryRawStub;
  let service: AboutService;
  const originalPath = process.env.DEPLOY_INFO_PATH;
  const originalEnv = process.env.NODE_ENV;

  const writeInfo = (value: unknown): void => {
    writeFileSync(
      filePath,
      typeof value === 'string' ? value : JSON.stringify(value),
      'utf8',
    );
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'about-service-'));
    filePath = join(dir, 'info.json');
    process.env.DEPLOY_INFO_PATH = filePath;

    prisma = { $queryRaw: jest.fn() };
    stubDatabase(prisma);
    service = new AboutService(prisma as unknown as PrismaService);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (originalPath === undefined) delete process.env.DEPLOY_INFO_PATH;
    else process.env.DEPLOY_INFO_PATH = originalPath;
    process.env.NODE_ENV = originalEnv;
  });

  // ===========================================================================
  // The four deploy-info states
  // ===========================================================================

  describe('deployInfo', () => {
    it("answers 'absent' with nulls when the file does not exist — the dev-stack case", async () => {
      // Nothing written to `filePath`.
      const about = await service.get();

      expect(about.deployInfo).toBeNull();
      expect(about.deployInfoStatus).toBe('absent');
      expect(about.detail).toBeNull();
      expect(about.updateAvailable).toBeNull();
      expect(about.checkedAt).toBeNull();
      // Absent is not an error — the rest of the page still answers.
      expect(about.runtime.apiVersion).toEqual(expect.any(String));
    });

    it("answers 'absent' when a path component is not a directory (ENOTDIR)", async () => {
      // `filePath` is a file; pretend it is a directory containing the target.
      writeInfo(fixture);
      process.env.DEPLOY_INFO_PATH = join(filePath, 'info.json');

      const about = await service.get();

      expect(about.deployInfoStatus).toBe('absent');
    });

    it("answers 'unreadable' with the parse message when the file is not JSON", async () => {
      writeInfo('{ "schema": 1, "app": { "name": ');

      const about = await service.get();

      expect(about.deployInfo).toBeNull();
      expect(about.deployInfoStatus).toBe('unreadable');
      expect(about.detail).toMatch(/Not valid JSON/);
    });

    it("answers 'invalid' with a detail when the JSON does not match the schema", async () => {
      writeInfo({ ...fixture, schema: 2 });

      const about = await service.get();

      expect(about.deployInfo).toBeNull();
      expect(about.deployInfoStatus).toBe('invalid');
      expect(about.detail).toMatch(/schema/);
    });

    it("answers 'invalid' for a field of the wrong type, not just a wrong schema number", async () => {
      writeInfo({ ...fixture, bindPort: 'three-five-three-five' });

      const about = await service.get();

      expect(about.deployInfoStatus).toBe('invalid');
      expect(about.detail).toMatch(/bindPort/);
    });

    it("answers 'ok' with the parsed fixture, unknown fields preserved", async () => {
      writeInfo(fixture);

      const about = await service.get();

      expect(about.deployInfoStatus).toBe('ok');
      expect(about.detail).toBeNull();
      expect(about.deployInfo).toMatchObject({
        schema: 1,
        app: { name: 'example-app', commitSha: fixture.app.commitSha, ref: 'main' },
        installedAt: fixture.installedAt,
        updatedAt: fixture.updatedAt,
        domain: 'app.example.com',
        bindPort: 3535,
        host: { hostname: 'vps-01', cpus: 4, memoryBytes: 8323072000 },
        remote: { commitsBehind: 2, checkedAt: fixture.remote.checkedAt },
      });
      // `.passthrough()`: a newer CLI adding a field rides through untouched.
      expect((about.deployInfo as Record<string, unknown>).unknownFutureField).toBe(
        fixture.unknownFutureField,
      );
    });

    it('tolerates a sparse file — every field but `schema` is optional', async () => {
      writeInfo({ schema: 1, remote: null, host: null });

      const about = await service.get();

      expect(about.deployInfoStatus).toBe('ok');
      expect(about.deployInfo).toEqual({ schema: 1, remote: null, host: null });
      expect(about.updateAvailable).toBeNull();
    });

    it('reads the file on every request, so a rewrite is visible without a restart', async () => {
      writeInfo({ ...fixture, app: { ...fixture.app, version: '1.4.0' } });
      const first = await service.get();
      expect(first.deployInfo?.app?.version).toBe('1.4.0');

      writeInfo({ ...fixture, app: { ...fixture.app, version: '1.5.0' } });
      const second = await service.get();
      expect(second.deployInfo?.app?.version).toBe('1.5.0');
    });

    it('strips any key that looks like a secret, at every depth', async () => {
      writeInfo({
        ...fixture,
        deployToken: 'ghp_should_never_be_relayed',
        host: { ...fixture.host, ApiKey: 'nope', nested: { password: 'x', ok: 1 } },
        deployedBy: { ...fixture.deployedBy, SECRET_THING: 'no' },
      });

      const about = await service.get();
      const serialised = JSON.stringify(about);

      expect(about.deployInfoStatus).toBe('ok');
      expect(serialised).not.toMatch(/password|secret|key|token/i);
      expect(serialised).not.toContain('ghp_should_never_be_relayed');
      // The non-secret sibling survives the strip.
      expect(
        ((about.deployInfo as Record<string, unknown>).host as Record<string, unknown>)
          .nested,
      ).toEqual({ ok: 1 });
    });
  });

  // ===========================================================================
  // updateAvailable — derived once, here
  // ===========================================================================

  describe('updateAvailable', () => {
    it('is true when the CLI recorded commits behind', async () => {
      writeInfo({ ...fixture, remote: { ...fixture.remote, commitsBehind: 3 } });
      const about = await service.get();
      expect(about.updateAvailable).toBe(true);
      expect(about.checkedAt).toBe(fixture.remote.checkedAt);
    });

    it('is false when the CLI recorded zero commits behind', async () => {
      writeInfo({ ...fixture, remote: { ...fixture.remote, commitsBehind: 0 } });
      const about = await service.get();
      expect(about.updateAvailable).toBe(false);
      expect(about.checkedAt).toBe(fixture.remote.checkedAt);
    });

    it('is null — unknown, not "no" — when the CLI has never checked', async () => {
      writeInfo({ ...fixture, remote: null });
      const about = await service.get();
      expect(about.updateAvailable).toBeNull();
      expect(about.checkedAt).toBeNull();
    });

    it('is null when `remote` exists but carries no usable count', async () => {
      writeInfo({ ...fixture, remote: { sha: 'abc', commitsBehind: null, checkedAt: null } });
      const about = await service.get();
      expect(about.updateAvailable).toBeNull();
      expect(about.checkedAt).toBeNull();
    });
  });

  // ===========================================================================
  // deployRunComplete — the second thing derived here (issue #283)
  // ===========================================================================
  //
  // The reported failure was About telling an administrator "this instance was
  // not deployed with the deploy CLI" about a server the CLI had cloned,
  // built, migrated, seeded, started and certificated — because the install's
  // very last action failed and the CLI withheld the record. The CLI now
  // writes it from `health` onward, carrying whether the run finished; these
  // are the reader's half of that contract.
  //
  // The three fields are ADDITIONAL to `deployInfoStatus`, never a fifth value
  // of it: an incomplete run's record parsed perfectly, so it is `ok`.

  describe('deployRunComplete', () => {
    it('reports an incomplete run and the step that stopped it', async () => {
      writeInfo({
        ...fixture,
        run: {
          completed: false,
          failedStep: 'publish',
          attemptedAt: '2026-09-17T09:12:00.000Z',
        },
      });

      const about = await service.get();

      // Still `ok`: the file was read and it matched. The deployment facts
      // are all there, because the CLI wrote them after the API had answered.
      expect(about.deployInfoStatus).toBe('ok');
      expect(about.deployInfo?.app?.commitSha).toBe(fixture.app.commitSha);
      expect(about.deployRunComplete).toBe(false);
      expect(about.deployFailedStep).toBe('publish');
      expect(about.deployAttemptedAt).toBe('2026-09-17T09:12:00.000Z');
    });

    it('reports a completed run, with no failure details to render', async () => {
      writeInfo(fixture);

      const about = await service.get();

      expect(about.deployRunComplete).toBe(true);
      expect(about.deployFailedStep).toBeNull();
      expect(about.deployAttemptedAt).toBeNull();
    });

    it('treats a file with NO `run` as a completed run — an older CLI wrote it', async () => {
      // THE COMPATIBILITY THAT MATTERS. Every info.json already on every live
      // server has no `run`, and each was written only after a pipeline
      // finished. It must still parse as `ok` — an `invalid` here would be
      // strictly worse than the missing field — and it must read as complete.
      // A derivation testing `!== true` would report every one of them as a
      // failed deploy, which is the same class of wrongness as the bug.
      const { run: _run, ...older } = fixture;
      expect(_run).toBeDefined();
      writeInfo(older);

      const about = await service.get();

      expect(about.deployInfoStatus).toBe('ok');
      expect(about.detail).toBeNull();
      expect(about.deployRunComplete).toBe(true);
      expect(about.deployFailedStep).toBeNull();
    });

    it('stays `ok` for a `run` carrying fields this build does not know', async () => {
      // The other direction: a NEWER CLI. Every object in the schema is
      // `.passthrough()`ed, so an added member rides through rather than
      // downgrading the page.
      writeInfo({ ...fixture, run: { completed: false, failedStep: 'verify', reasonCode: 'x' } });

      const about = await service.get();

      expect(about.deployInfoStatus).toBe('ok');
      expect(about.deployRunComplete).toBe(false);
      expect(
        (about.deployInfo?.run as Record<string, unknown> | undefined)?.reasonCode,
      ).toBe('x');
    });

    it('is null — not false — when there is no record at all', async () => {
      // Nothing written. "No record" is not "a failed run": the page has
      // nothing to warn about, only nothing to show.
      const about = await service.get();

      expect(about.deployInfoStatus).toBe('absent');
      expect(about.deployRunComplete).toBeNull();
      expect(about.deployFailedStep).toBeNull();
      expect(about.deployAttemptedAt).toBeNull();
    });
  });

  // ===========================================================================
  // runtime
  // ===========================================================================

  describe('runtime', () => {
    it('reports this process, with UTC timestamps that carry a Z', async () => {
      process.env.NODE_ENV = 'test';
      const before = Date.now();
      const about = await service.get();
      const after = Date.now();

      expect(about.runtime.nodeVersion).toBe(process.version);
      expect(about.runtime.environment).toBe('test');
      expect(about.runtime.serverTimeUtc).toMatch(/Z$/);
      expect(about.runtime.processStartedAt).toMatch(/Z$/);
      expect(Number.isInteger(about.runtime.uptimeSeconds)).toBe(true);
      expect(about.runtime.uptimeSeconds).toBeGreaterThanOrEqual(0);

      const serverTime = Date.parse(about.runtime.serverTimeUtc);
      expect(serverTime).toBeGreaterThanOrEqual(before);
      expect(serverTime).toBeLessThanOrEqual(after);
      // Started before it answered, by roughly its uptime.
      expect(Date.parse(about.runtime.processStartedAt)).toBeLessThanOrEqual(
        serverTime,
      );
    });
  });

  // ===========================================================================
  // database
  // ===========================================================================

  describe('database', () => {
    it('maps the two queries into the documented facts', async () => {
      const about = await service.get();

      expect(about.databaseError).toBeNull();
      expect(about.database).toEqual({
        serverVersion: 'PostgreSQL 16.4 on x86_64-pc-linux-gnu',
        appliedMigrations: 42,
        lastMigrationName: '20260901120000_add_note_exports',
        lastMigrationAt: '2026-09-14T22:41:12.000Z',
      });
    });

    it('reports zero migrations, not an error, when none has finished', async () => {
      stubDatabase(prisma, { migrations: [] });

      const about = await service.get();

      expect(about.database).toEqual({
        serverVersion: 'PostgreSQL 16.4 on x86_64-pc-linux-gnu',
        appliedMigrations: 0,
        lastMigrationName: null,
        lastMigrationAt: null,
      });
    });

    it('degrades to `database: null` with the error when a query throws, and still resolves', async () => {
      prisma.$queryRaw.mockRejectedValue(new Error("Can't reach database server"));
      writeInfo(fixture);

      const about = await service.get();

      expect(about.database).toBeNull();
      expect(about.databaseError).toBe("Can't reach database server");
      // Independence: the file half is unaffected by the database half.
      expect(about.deployInfoStatus).toBe('ok');
      expect(about.runtime.apiVersion).toEqual(expect.any(String));
    });
  });

  // ===========================================================================
  // The whole answer matches the published contract
  // ===========================================================================

  it('produces a body that parses through the OpenAPI response schema', async () => {
    writeInfo(fixture);
    const about = await service.get();
    expect(() => aboutResponseSchema.parse(about)).not.toThrow();
  });

  it('produces a schema-valid body in the degraded state too', async () => {
    prisma.$queryRaw.mockRejectedValue(new Error('down'));
    const about = await service.get();
    expect(() => aboutResponseSchema.parse(about)).not.toThrow();
  });
});

describe('resolveDeployInfoPath', () => {
  const original = process.env.DEPLOY_INFO_PATH;
  afterEach(() => {
    if (original === undefined) delete process.env.DEPLOY_INFO_PATH;
    else process.env.DEPLOY_INFO_PATH = original;
  });

  it('defaults to the mount point the CLI uses', () => {
    delete process.env.DEPLOY_INFO_PATH;
    expect(resolveDeployInfoPath()).toBe(DEFAULT_DEPLOY_INFO_PATH);
    expect(DEFAULT_DEPLOY_INFO_PATH).toBe('/app/deploy-info/info.json');
  });

  it('treats a blank override as unset', () => {
    process.env.DEPLOY_INFO_PATH = '   ';
    expect(resolveDeployInfoPath()).toBe(DEFAULT_DEPLOY_INFO_PATH);
  });

  it('honours an override', () => {
    process.env.DEPLOY_INFO_PATH = '/tmp/elsewhere.json';
    expect(resolveDeployInfoPath()).toBe('/tmp/elsewhere.json');
  });
});

describe('stripSecretLikeKeys', () => {
  it('removes matching keys case-insensitively and walks arrays', () => {
    expect(
      stripSecretLikeKeys({
        keep: 1,
        Password: 'x',
        list: [{ token: 'y', fine: true }, 'plain', 3],
        nested: { apiKey: 'z', secretSauce: 'w', ok: null },
      }),
    ).toEqual({ keep: 1, list: [{ fine: true }, 'plain', 3], nested: { ok: null } });
  });

  it('passes primitives and null through', () => {
    expect(stripSecretLikeKeys(null)).toBeNull();
    expect(stripSecretLikeKeys('token')).toBe('token');
    expect(stripSecretLikeKeys(7)).toBe(7);
  });
});
