#!/usr/bin/env node
/**
 * Prisma Environment Helper
 *
 * Constructs DATABASE_URL from individual PostgreSQL environment variables
 * and executes Prisma CLI commands with the proper environment.
 *
 * This is needed because Prisma CLI requires DATABASE_URL to be set,
 * but we use individual variables (POSTGRES_HOST, POSTGRES_PORT, etc.)
 * for flexibility in different environments.
 *
 * Usage:
 *   node scripts/prisma-env.js [prisma command and args]
 *
 * Examples:
 *   node scripts/prisma-env.js migrate deploy
 *   node scripts/prisma-env.js generate
 *   node scripts/prisma-env.js studio
 */

const { spawn } = require('child_process');

// Load .env files - try multiple locations
if (process.env.NODE_ENV !== 'production') {
  try {
    const path = require('path');
    const dotenv = require('dotenv');

    // Try local .env first (apps/api/.env)
    dotenv.config();

    // Also load from infra/compose/.env (canonical env location)
    const composeEnv = path.resolve(__dirname, '..', '..', '..', 'infra', 'compose', '.env');
    dotenv.config({ path: composeEnv });
  } catch (err) {
    // dotenv might not be available in production builds, that's OK
  }
}

/**
 * Constructs a PostgreSQL connection URL from individual environment variables.
 *
 * DELIBERATE DUPLICATE of src/common/database-url.ts, and the only one left.
 * This file is CommonJS, runs under plain `node`, and executes BEFORE anything
 * is compiled — `npm run prisma:migrate` is how a fresh database gets its
 * schema — while tsconfig.build.json sets rootDir to ./src. So it cannot
 * import the shared module, and a copy is the only option.
 *
 * The copy is not maintained by discipline: src/common/database-url.spec.ts
 * requires THIS file and asserts both implementations return identical strings
 * for a table of awkward inputs. Change a rule here or there and that test
 * fails until both agree.
 *
 * @param {NodeJS.ProcessEnv} [env] Defaults to process.env; injectable for tests.
 */
function constructDatabaseUrl(env = process.env) {
  // An already-set DATABASE_URL wins, untouched: it is the escape hatch for a
  // connection this formula cannot express (a socket path, pgbouncer, extra
  // query parameters), and re-deriving over it would discard that intent.
  if (env.DATABASE_URL) {
    return env.DATABASE_URL;
  }

  const host = env.POSTGRES_HOST || 'localhost';
  const port = env.POSTGRES_PORT || '5432';
  const user = env.POSTGRES_USER || 'postgres';
  const password = env.POSTGRES_PASSWORD || 'postgres';
  const dbName = env.POSTGRES_DB || 'appdb';
  const ssl = env.POSTGRES_SSL === 'true';

  // Both the user and the password are encoded. The password is the one that
  // bites in practice, but a username can contain `@` too, and encoding only
  // one of them is how this bug comes back.
  const encodedUser = encodeURIComponent(user);
  const encodedPassword = encodeURIComponent(password);

  const sslParam = ssl ? '?sslmode=require' : '';

  return `postgresql://${encodedUser}:${encodedPassword}@${host}:${port}/${dbName}${sslParam}`;
}

/**
 * Main execution
 */
function main() {
  // Get Prisma command from arguments (skip node and script name)
  const prismaArgs = process.argv.slice(2);

  if (prismaArgs.length === 0) {
    console.error('Error: No Prisma command specified');
    console.error('Usage: node scripts/prisma-env.js [prisma command and args]');
    console.error('Example: node scripts/prisma-env.js migrate deploy');
    process.exit(1);
  }

  // Construct DATABASE_URL
  const databaseUrl = constructDatabaseUrl();

  // Set up environment for Prisma CLI
  const env = {
    ...process.env,
    DATABASE_URL: databaseUrl,
  };

  // Execute Prisma CLI with constructed environment
  const prismaProcess = spawn('npx', ['prisma', ...prismaArgs], {
    env,
    stdio: 'inherit',
    shell: true,
  });

  prismaProcess.on('exit', (code) => {
    process.exit(code || 0);
  });

  prismaProcess.on('error', (err) => {
    console.error('Failed to execute Prisma command:', err);
    process.exit(1);
  });
}

// Only run when invoked directly. src/common/database-url.spec.ts requires this
// file to compare the two implementations, and that must not spawn Prisma.
if (require.main === module) {
  main();
}

module.exports = { constructDatabaseUrl };
