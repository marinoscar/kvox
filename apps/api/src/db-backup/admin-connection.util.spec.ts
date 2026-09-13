// =============================================================================
// The cluster admin connection (issue #284, epic #254)
// =============================================================================
//
// Three properties, and each of them is a production failure this file exists
// to make impossible:
//
//   1. THE CONNECTION IS ALWAYS CLOSED — on the success path, on the throw
//      path, and when the callback never settles. A leaked session to the
//      cluster is what makes `ALTER DATABASE ... RENAME` fail, at the worst
//      possible moment: after the archive has been replayed and the
//      application has been stopped.
//   2. IDENTIFIERS ARE REJECTED, NOT ESCAPED. DDL cannot use bind parameters,
//      so `quoteIdentifier` is the only thing between a stored string and
//      arbitrary SQL.
//   3. THE DISAMBIGUATING SUFFIX SURVIVES A MAXIMALLY LONG DATABASE NAME.
//      Postgres truncates over-long identifiers silently, so a builder that
//      let the server trim the tail would give two restores of a
//      near-63-character database the SAME physical scratch name.
//
// Everything runs against a fake client. A suite that needs a live PostgreSQL
// is a suite CI skips, and a skipped test guards nothing.
// =============================================================================

import {
  AdminConnectionTimeoutError,
  DEFAULT_MAINTENANCE_DATABASE,
  FALLBACK_MAINTENANCE_DATABASE,
  InvalidDatabaseIdentifierError,
  InvalidSqlLiteralError,
  MAX_IDENTIFIER_BYTES,
  buildOldDatabaseName,
  buildScratchDatabaseName,
  countDistinctClientAddresses,
  createDatabase,
  databaseExists,
  dropDatabase,
  probeCreateDatabasePrivilege,
  probeCreateRolePrivilege,
  probePgExtensionAvailable,
  quoteIdentifier,
  quoteLiteral,
  quoteTimestampLiteral,
  readDataDirectory,
  readDatabaseSizeBytes,
  renameDatabase,
  resolveAdminConnection,
  terminateConnections,
  withAdminConnection,
  type AdminConnection,
  type AdminQueryClient,
} from './admin-connection.util';

// ---------------------------------------------------------------------------
// Doubles
// ---------------------------------------------------------------------------

interface FakeClient extends AdminQueryClient {
  queries: Array<{ text: string; values: unknown[] | undefined }>;
  connect: jest.Mock;
  query: jest.Mock;
  end: jest.Mock;
}

type QueryHandler = (
  text: string,
  values: unknown[] | undefined
) => Array<Record<string, unknown>> | Error;

function fakeClient(handler: QueryHandler = () => []): FakeClient {
  const queries: Array<{ text: string; values: unknown[] | undefined }> = [];

  const client = {
    queries,
    connect: jest.fn(async () => undefined),
    query: jest.fn(async (text: string, values?: unknown[]) => {
      queries.push({ text, values });
      const result = handler(text, values);
      if (result instanceof Error) throw result;

      return { rows: result, rowCount: result.length };
    }),
    end: jest.fn(async () => undefined),
  };

  return client as unknown as FakeClient;
}

const CONNECTION: AdminConnection = {
  host: '127.0.0.1',
  port: '5432',
  user: 'appuser',
  password: 'secret',
  database: 'postgres',
  sslMode: null,
  liveDatabase: 'appdb',
};

const AT = new Date('2026-09-07T12:00:00.000Z');

// ---------------------------------------------------------------------------

describe('resolveAdminConnection', () => {
  it('attaches to the maintenance database and remembers the live one', () => {
    const connection = resolveAdminConnection({
      POSTGRES_HOST: 'db.internal',
      POSTGRES_PORT: '6432',
      POSTGRES_USER: 'app',
      POSTGRES_PASSWORD: 'p/w+ord',
      POSTGRES_DB: 'production',
    });

    expect(connection.database).toBe(DEFAULT_MAINTENANCE_DATABASE);
    expect(connection.liveDatabase).toBe('production');
    expect(connection.host).toBe('db.internal');
    expect(connection.port).toBe('6432');
    // Decoded, not the percent-encoded form `buildDatabaseUrl` put in the URL:
    // handing `p%2Fw%2Bord` to the driver is how #172's class of bug returns.
    expect(connection.password).toBe('p/w+ord');
  });

  it('falls back to template1 when the application database IS "postgres"', () => {
    // Otherwise the admin session would be attached to the very database a
    // swap has to rename, which Postgres refuses.
    const connection = resolveAdminConnection({ POSTGRES_DB: 'postgres' });

    expect(connection.database).toBe(FALLBACK_MAINTENANCE_DATABASE);
    expect(connection.liveDatabase).toBe('postgres');
  });

  it('honours a DATABASE_URL override, because that is the documented escape hatch', () => {
    const connection = resolveAdminConnection({
      DATABASE_URL: 'postgresql://someone:pass@example.test:15432/otherdb?sslmode=verify-full',
      POSTGRES_HOST: 'ignored.example',
    });

    expect(connection.host).toBe('example.test');
    expect(connection.port).toBe('15432');
    expect(connection.liveDatabase).toBe('otherdb');
    expect(connection.sslMode).toBe('verify-full');
  });

  it('accepts an explicit maintenance database', () => {
    const connection = resolveAdminConnection({ POSTGRES_DB: 'appdb' }, 'defaultdb');

    expect(connection.database).toBe('defaultdb');
  });
});

describe('withAdminConnection', () => {
  it('sets statement_timeout to 0 on every session', async () => {
    // Explicitly zero so that no server-side default (a managed provider's, an
    // ALTER ROLE) can abandon a CREATE DATABASE half way and leave the cluster
    // in a state nothing can interpret.
    const client = fakeClient();

    await withAdminConnection(CONNECTION, async () => 'done', {
      clientFactory: () => client,
    });

    expect(client.queries[0].text).toBe('SET statement_timeout = 0');
  });

  it('closes the connection on the success path', async () => {
    const client = fakeClient();

    await expect(
      withAdminConnection(CONNECTION, async () => 42, { clientFactory: () => client })
    ).resolves.toBe(42);

    expect(client.end).toHaveBeenCalledTimes(1);
  });

  it('closes the connection on the throw path, and preserves the original error', async () => {
    const client = fakeClient();
    const boom = new Error('probe failed');

    await expect(
      withAdminConnection(
        CONNECTION,
        async () => {
          throw boom;
        },
        { clientFactory: () => client }
      )
    ).rejects.toBe(boom);

    expect(client.end).toHaveBeenCalledTimes(1);
  });

  it('closes the connection when the callback never resolves', async () => {
    // The case a plain try/finally cannot reach: without the bound, the
    // `finally` never runs and the session stays open against a cluster whose
    // live database has to be free of sessions before a rename can succeed.
    const client = fakeClient();

    await expect(
      withAdminConnection(CONNECTION, () => new Promise<never>(() => undefined), {
        clientFactory: () => client,
        timeoutMs: 20,
      })
    ).rejects.toBeInstanceOf(AdminConnectionTimeoutError);

    expect(client.end).toHaveBeenCalledTimes(1);
  });

  it('does not let a failing end() mask the failure that caused it', async () => {
    // A close error on top of a refused password would send an operator to
    // entirely the wrong runbook.
    const client = fakeClient();
    client.end.mockRejectedValue(new Error('socket already gone'));
    const boom = new Error('password authentication failed');

    await expect(
      withAdminConnection(
        CONNECTION,
        async () => {
          throw boom;
        },
        { clientFactory: () => client }
      )
    ).rejects.toBe(boom);
  });

  it('closes the connection when connect() itself fails', async () => {
    const client = fakeClient();
    client.connect.mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(
      withAdminConnection(CONNECTION, async () => 'unreachable', {
        clientFactory: () => client,
      })
    ).rejects.toThrow('ECONNREFUSED');

    expect(client.end).toHaveBeenCalledTimes(1);
  });

  it('is unbounded by default', async () => {
    const client = fakeClient();

    await expect(
      withAdminConnection(
        CONNECTION,
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 30));

          return 'slow but fine';
        },
        { clientFactory: () => client }
      )
    ).resolves.toBe('slow but fine');
  });
});

describe('quoteIdentifier', () => {
  it('quotes a legal identifier', () => {
    expect(quoteIdentifier('appdb')).toBe('"appdb"');
    expect(quoteIdentifier('App_DB$1')).toBe('"App_DB$1"');
  });

  it.each([
    ['an embedded double quote', 'app"db'],
    ['a statement terminator', 'appdb; DROP DATABASE appdb'],
    ['a space', 'app db'],
    ['a hyphen', 'app-db'],
    ['a leading digit', '1appdb'],
    ['an empty string', ''],
    ['a backslash', 'app\\db'],
    ['a newline', 'appdb\nDROP DATABASE x'],
    ['a NUL', 'app\u0000db'],
    ['non-ASCII', 'ápp'],
  ])('rejects %s rather than escaping it', (_label, identifier) => {
    // REJECTS, not escapes. Doubling an embedded quote accepts every name and
    // then depends on this implementation being right about every case
    // forever; an allowlist's worst failure is refusing a legal name, loudly.
    expect(() => quoteIdentifier(identifier)).toThrow(InvalidDatabaseIdentifierError);
  });

  it('rejects a name longer than the server would keep', () => {
    // Postgres would TRUNCATE it, not refuse it — which is how two different
    // names become one physical database.
    expect(() => quoteIdentifier('a'.repeat(MAX_IDENTIFIER_BYTES + 1))).toThrow(
      InvalidDatabaseIdentifierError
    );
    expect(() => quoteIdentifier('a'.repeat(MAX_IDENTIFIER_BYTES))).not.toThrow();
  });
});

describe('quoteLiteral', () => {
  it('quotes a value drawn from the generated alphabet', () => {
    expect(quoteLiteral('aB9')).toBe("'aB9'");
    expect(quoteLiteral('A'.repeat(43))).toBe(`'${'A'.repeat(43)}'`);
  });

  it.each([
    ['a single quote', "pa'ss"],
    ['a doubled quote', "pa''ss"],
    ['a statement terminator', "pass'; DROP ROLE appuser; --"],
    ['a backslash', 'pa\\ss'],
    ['a dollar quote', 'pa$$ss'],
    ['a space', 'pa ss'],
    ['a hyphen', 'pa-ss'],
    ['a plus (base64)', 'pa+ss'],
    ['a slash (base64)', 'pa/ss'],
    ['an equals (base64 padding)', 'pass='],
    ['a newline', 'pa\nss'],
    ['a carriage return', 'pa\rss'],
    ['a NUL', 'pa\u0000ss'],
    ['a tab', 'pa\tss'],
    ['non-ASCII', 'pásswörd'],
    ['a combining mark', 'pass\u0301'],
    ['an empty string', ''],
  ])('THROWS on %s rather than escaping it', (_label, value) => {
    // ⚠ THE POINT OF THE WHOLE FUNCTION. The standard escape (doubling `'`) is
    // correct and accepts every string, which leaves every reader auditing an
    // escape function forever. The only caller GENERATES its input over
    // `[A-Za-z0-9]`, so a value that fails this did not come from the
    // generator, and running it is never the right answer.
    expect(() => quoteLiteral(value)).toThrow(InvalidSqlLiteralError);
  });

  it('never names the rejected value, because the only literal here is a password', () => {
    const secret = "hunter2'; DROP ROLE appuser; --";

    try {
      quoteLiteral(secret, 'role password');
      throw new Error('expected a throw');
    } catch (error) {
      const message = (error as Error).message;

      // The KIND is named so the log is useful; the material is not, so the
      // log is not a credential store. See InvalidSqlLiteralError's header.
      expect(message).toContain('role password');
      expect(message).not.toContain('hunter2');
      expect(message).not.toContain(secret);
    }
  });

  it('rejects a non-string, so a stray null cannot become the literal "null"', () => {
    expect(() => quoteLiteral(undefined as unknown as string)).toThrow(InvalidSqlLiteralError);
    expect(() => quoteLiteral(null as unknown as string)).toThrow(InvalidSqlLiteralError);
  });
});

describe('quoteTimestampLiteral', () => {
  it('emits an ISO-8601 instant PostgreSQL parses as timestamptz', () => {
    expect(quoteTimestampLiteral(new Date('2026-09-07T12:00:00.000Z'))).toBe(
      "'2026-09-07T12:00:00.000Z'"
    );
  });

  it('takes a Date and never a string — the parameter type IS the guard', () => {
    // There is no overload that accepts text, so there is no path by which a
    // caller-supplied string reaches a `VALID UNTIL` literal. The runtime
    // checks below exist for JavaScript callers and for our own bugs.
    expect(() => quoteTimestampLiteral('2026-09-07' as unknown as Date)).toThrow(
      InvalidSqlLiteralError
    );
    expect(() => quoteTimestampLiteral(new Date(Number.NaN))).toThrow(InvalidSqlLiteralError);
  });

  it('rejects an instant outside the four-digit-year range', () => {
    // `toISOString` renders these as `+275760-09-13T00:00:00.000Z`. An expiry a
    // quarter of a million years out is a bug, not a grant.
    expect(() => quoteTimestampLiteral(new Date(8.64e15))).toThrow(InvalidSqlLiteralError);
  });
});

describe('the derived database names', () => {
  it('appends the suffix and the UTC timestamp', () => {
    expect(buildScratchDatabaseName('appdb', AT)).toBe('appdb_restore_20260907T120000Z');
    expect(buildOldDatabaseName('appdb', AT)).toBe('appdb_old_20260907T120000Z');
  });

  it('trims the BASE, never the tail, for a maximally long database name', () => {
    const longest = 'd'.repeat(MAX_IDENTIFIER_BYTES);

    const scratch = buildScratchDatabaseName(longest, AT);
    const old = buildOldDatabaseName(longest, AT);

    // The suffix is the only part that disambiguates two restores, so it is
    // the part that must survive.
    expect(scratch.endsWith('_restore_20260907T120000Z')).toBe(true);
    expect(old.endsWith('_old_20260907T120000Z')).toBe(true);
    expect(scratch.length).toBeLessThanOrEqual(MAX_IDENTIFIER_BYTES);
    expect(old.length).toBeLessThanOrEqual(MAX_IDENTIFIER_BYTES);

    // And it is still a name this module will put into DDL.
    expect(() => quoteIdentifier(scratch)).not.toThrow();
    expect(() => quoteIdentifier(old)).not.toThrow();
  });

  it('keeps two restores of the same long database distinct', () => {
    // The failure this prevents: both names truncating to one physical
    // database, the second restore finding the first's half-restored contents.
    const longest = 'd'.repeat(MAX_IDENTIFIER_BYTES);
    const later = new Date('2026-09-08T12:00:00.000Z');

    expect(buildScratchDatabaseName(longest, AT)).not.toBe(
      buildScratchDatabaseName(longest, later)
    );
    expect(buildScratchDatabaseName(longest, AT)).not.toBe(buildOldDatabaseName(longest, AT));
  });

  it('refuses to derive a name from a database it would not quote', () => {
    expect(() => buildScratchDatabaseName('app db', AT)).toThrow(InvalidDatabaseIdentifierError);
  });
});

describe('the cluster reads', () => {
  it('probes CREATEDB rather than assuming it', async () => {
    const client = fakeClient(() => [{ can_create: true }]);

    await expect(probeCreateDatabasePrivilege(client)).resolves.toBe(true);
    expect(client.queries[0].text).toContain('rolsuper OR rolcreatedb');
    // `current_user`, not the configured user: SET ROLE, a pooler or a
    // DATABASE_URL override can all make the session's role something else.
    expect(client.queries[0].text).toContain('current_user');
  });

  it('reports a role without CREATEDB as false, not as an error', async () => {
    const client = fakeClient(() => [{ can_create: false }]);

    await expect(probeCreateDatabasePrivilege(client)).resolves.toBe(false);
  });

  it('treats an unknown role as "no", because a missing row proves nothing good', async () => {
    const client = fakeClient(() => []);

    await expect(probeCreateDatabasePrivilege(client)).resolves.toBe(false);
  });

  it('probes CREATEROLE rather than assuming it (#350)', async () => {
    const client = fakeClient(() => [{ can_create: true }]);

    await expect(probeCreateRolePrivilege(client)).resolves.toBe(true);
    // `rolsuper OR rolcreaterole` — a superuser creates roles without the
    // attribute being set, exactly as it creates databases without CREATEDB.
    expect(client.queries[0].text).toContain('rolsuper OR rolcreaterole');
    expect(client.queries[0].text).toContain('current_user');
  });

  it('reports a role without CREATEROLE as false — the ordinary managed-PostgreSQL answer', async () => {
    const client = fakeClient(() => [{ can_create: false }]);

    // NOT a throw. It is a verdict the broker turns into `guided`, because
    // this is a configuration and not a fault.
    await expect(probeCreateRolePrivilege(client)).resolves.toBe(false);
  });

  it('creates nothing while probing CREATEROLE', async () => {
    const client = fakeClient(() => [{ can_create: true }]);

    await probeCreateRolePrivilege(client);

    // ⚠ Asking "could you mint one?" must never mint one — the same rule the
    // restore pre-flight follows, and the reason a probe with side effects
    // leaves a half-made grant nobody recorded.
    expect(client.queries).toHaveLength(1);
    expect(client.queries[0].text).toMatch(/^SELECT/);
  });

  it('asks the server catalog whether an extension can be created', async () => {
    const client = fakeClient((_text, values) =>
      values?.[0] === 'pgcrypto' ? [{ '?column?': 1 }] : []
    );

    await expect(probePgExtensionAvailable(client, 'pgcrypto')).resolves.toBe(true);
    await expect(probePgExtensionAvailable(client, 'postgis')).resolves.toBe(false);
    expect(client.queries[0].text).toContain('pg_available_extensions');
    // A bind parameter: this is a value, not an identifier, so it never goes
    // near quoteIdentifier.
    expect(client.queries[0].values).toEqual(['pgcrypto']);
  });

  it('reads the database size as a bigint', async () => {
    // Via ::text, because int8 above 2^53 cannot survive a JS number — the
    // same reason size_bytes is a BigInt column.
    const client = fakeClient(() => [{ size: '9007199254740993' }]);

    await expect(readDatabaseSizeBytes(client, 'appdb')).resolves.toBe(9007199254740993n);
    expect(client.queries[0].values).toEqual(['appdb']);
  });

  it('returns null for a data directory this role may not see', async () => {
    // The ordinary answer on managed PostgreSQL, where SHOW data_directory
    // needs superuser or pg_read_all_settings. It must never be an error.
    const client = fakeClient(() => new Error('must be superuser to examine "data_directory"'));

    await expect(readDataDirectory(client)).resolves.toBeNull();
  });

  it('returns the data directory when it is visible', async () => {
    const client = fakeClient(() => [{ data_directory: '/var/lib/postgresql/data' }]);

    await expect(readDataDirectory(client)).resolves.toBe('/var/lib/postgresql/data');
  });

  it('reports whether a database exists', async () => {
    const client = fakeClient((_text, values) => (values?.[0] === 'appdb' ? [{ x: 1 }] : []));

    await expect(databaseExists(client, 'appdb')).resolves.toBe(true);
    await expect(databaseExists(client, 'appdb_restore_x')).resolves.toBe(false);
  });

  it('counts distinct client addresses, excluding socket connections', async () => {
    const client = fakeClient(() => [{ count: '3' }]);

    await expect(countDistinctClientAddresses(client, 'appdb')).resolves.toBe(3);
    expect(client.queries[0].text).toContain('client_addr IS NOT NULL');
  });

  it('counts zero rather than NaN when the count cannot be read', async () => {
    const client = fakeClient(() => [{}]);

    await expect(countDistinctClientAddresses(client, 'appdb')).resolves.toBe(0);
  });
});

describe('the cluster mutations (#285 only)', () => {
  it('creates a database through the identifier allowlist', async () => {
    const client = fakeClient();

    await createDatabase(client, 'appdb_restore_20260907T120000Z');

    expect(client.queries[0].text).toBe('CREATE DATABASE "appdb_restore_20260907T120000Z"');
  });

  it('creates from a template when asked, quoting that too', async () => {
    const client = fakeClient();

    await createDatabase(client, 'appdb_restore_x', { template: 'template0' });

    expect(client.queries[0].text).toBe('CREATE DATABASE "appdb_restore_x" TEMPLATE "template0"');
  });

  it('drops with IF EXISTS, so cleanup after a partial failure is not itself a failure', async () => {
    const client = fakeClient();

    await dropDatabase(client, 'appdb_restore_x');

    expect(client.queries[0].text).toBe('DROP DATABASE IF EXISTS "appdb_restore_x"');
  });

  it('terminates every other backend on the target database', async () => {
    // The precondition for a rename: Postgres refuses while any session is
    // connected, including this application's own Prisma pool.
    const client = fakeClient(() => [{ pg_terminate_backend: true }, { pg_terminate_backend: true }]);

    await expect(terminateConnections(client, 'appdb')).resolves.toBe(2);
    expect(client.queries[0].text).toContain('pid <> pg_backend_pid()');
    expect(client.queries[0].values).toEqual(['appdb']);
  });

  it('renames both halves of a swap through the allowlist', async () => {
    const client = fakeClient();

    await renameDatabase(client, 'appdb', 'appdb_old_20260907T120000Z');

    expect(client.queries[0].text).toBe(
      'ALTER DATABASE "appdb" RENAME TO "appdb_old_20260907T120000Z"'
    );
  });

  it('refuses a mutation naming an identifier outside the allowlist', async () => {
    // The whole point of the allowlist: this is the only place in the
    // subsystem where a string reaches SQL without a bind parameter.
    const client = fakeClient();

    await expect(createDatabase(client, 'x"; DROP DATABASE appdb; --')).rejects.toBeInstanceOf(
      InvalidDatabaseIdentifierError
    );
    await expect(renameDatabase(client, 'appdb', 'bad name')).rejects.toBeInstanceOf(
      InvalidDatabaseIdentifierError
    );
    expect(client.query).not.toHaveBeenCalled();
  });
});
