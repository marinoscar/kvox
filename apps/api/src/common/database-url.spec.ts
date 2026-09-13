import { buildDatabaseUrl, type DatabaseEnv } from './database-url';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { constructDatabaseUrl } = require('../../scripts/prisma-env.js') as {
  constructDatabaseUrl: (env: NodeJS.ProcessEnv) => string;
};

// =============================================================================
// The two connection-string builders must not drift (issue #172)
// =============================================================================
//
// scripts/prisma-env.js cannot import src/common/database-url.ts — it is
// CommonJS, runs before anything is compiled, and rootDir is ./src — so it
// keeps a copy. This file is what makes that copy safe: it requires the script
// directly and compares the two over inputs chosen to break naive
// interpolation.
//
// Do not "simplify" this to test one implementation. The point is the pair.
// =============================================================================

/** Inputs chosen because each one breaks an unencoded connection string. */
const AWKWARD_PASSWORDS = [
  'postgres',
  'p@ss/word#1',
  '@@@',
  'a:b',
  'a/b',
  'a#b',
  'a?b',
  'a%b',
  'a b',
  'wF3/kZ+9aQ==',
  "quote'and\"double",
  'ünïcødé',
];

function envFor(overrides: Partial<Record<string, string>>): NodeJS.ProcessEnv {
  return overrides as NodeJS.ProcessEnv;
}

describe('buildDatabaseUrl', () => {
  it('percent-encodes a password containing URL-reserved characters', () => {
    const url = buildDatabaseUrl(
      envFor({ POSTGRES_PASSWORD: 'p@ss/word#1', POSTGRES_HOST: 'db.internal' }),
    );

    // The host must be the configured one. Unencoded, the second `@` makes
    // `ss/word#1@db.internal` the authority and the host parses as garbage.
    expect(new URL(url).hostname).toBe('db.internal');
    expect(url).toContain('p%40ss%2Fword%231');
    expect(url).not.toContain('p@ss/word#1');
  });

  it('percent-encodes the user as well as the password', () => {
    const url = buildDatabaseUrl(envFor({ POSTGRES_USER: 'u@ser' }));

    expect(new URL(url).hostname).toBe('localhost');
    expect(url).toContain('u%40ser');
  });

  it('round-trips every awkward password through URL parsing', () => {
    for (const password of AWKWARD_PASSWORDS) {
      const url = buildDatabaseUrl(
        envFor({ POSTGRES_PASSWORD: password, POSTGRES_HOST: 'db.internal' }),
      );
      const parsed = new URL(url);

      expect(parsed.hostname).toBe('db.internal');
      expect(decodeURIComponent(parsed.password)).toBe(password);
    }
  });

  it('applies the documented defaults', () => {
    expect(buildDatabaseUrl(envFor({}))).toBe(
      'postgresql://postgres:postgres@localhost:5432/appdb',
    );
  });

  it('appends sslmode=require only for the exact string "true"', () => {
    expect(buildDatabaseUrl(envFor({ POSTGRES_SSL: 'true' }))).toContain(
      '?sslmode=require',
    );

    for (const value of ['false', 'TRUE', '1', 'yes', '']) {
      expect(buildDatabaseUrl(envFor({ POSTGRES_SSL: value }))).not.toContain(
        'sslmode',
      );
    }
  });

  it('returns an already-set DATABASE_URL untouched', () => {
    const explicit = 'postgresql://someone@/var/run/postgresql/db?host=/socket';

    expect(
      buildDatabaseUrl(
        envFor({ DATABASE_URL: explicit, POSTGRES_HOST: 'ignored.example' }),
      ),
    ).toBe(explicit);
  });

  it('ignores an empty DATABASE_URL rather than returning it', () => {
    expect(buildDatabaseUrl(envFor({ DATABASE_URL: '' }))).toBe(
      'postgresql://postgres:postgres@localhost:5432/appdb',
    );
  });

  it('reads process.env when no environment is passed', () => {
    const previous = process.env.POSTGRES_DB;
    const previousUrl = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    process.env.POSTGRES_DB = 'from_process_env';

    try {
      expect(buildDatabaseUrl()).toContain('/from_process_env');
    } finally {
      if (previous === undefined) delete process.env.POSTGRES_DB;
      else process.env.POSTGRES_DB = previous;
      if (previousUrl !== undefined) process.env.DATABASE_URL = previousUrl;
    }
  });
});

describe('parity with scripts/prisma-env.js', () => {
  const cases: DatabaseEnv[] = [
    {},
    { POSTGRES_PASSWORD: 'p@ss/word#1' },
    { POSTGRES_USER: 'u@ser', POSTGRES_PASSWORD: 'a b' },
    { POSTGRES_SSL: 'true' },
    { POSTGRES_SSL: 'TRUE' },
    {
      POSTGRES_HOST: 'db.internal',
      POSTGRES_PORT: '6432',
      POSTGRES_USER: 'app',
      POSTGRES_PASSWORD: 'wF3/kZ+9aQ==',
      POSTGRES_DB: 'appdb',
      POSTGRES_SSL: 'true',
    },
    { DATABASE_URL: 'postgresql://explicit@host:5432/db' },
    ...AWKWARD_PASSWORDS.map((POSTGRES_PASSWORD) => ({ POSTGRES_PASSWORD })),
  ];

  it.each(cases)('produces an identical string for %j', (env) => {
    expect(constructDatabaseUrl(env as NodeJS.ProcessEnv)).toBe(
      buildDatabaseUrl(env),
    );
  });
});
