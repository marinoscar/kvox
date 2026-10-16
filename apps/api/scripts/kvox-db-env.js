#!/usr/bin/env node
/**
 * kvox-db Environment Helper
 *
 * Runs the `kvox-db` command of @marinoscar/kvox-db with DATABASE_URL set,
 * built from the individual POSTGRES_* variables exactly the way
 * scripts/prisma-env.js and scripts/platform-env.js do it. Only the command
 * that touches a database needs it (`check --database`); the offline ones
 * (`sync`, `check`, `promote`) are wired straight to `kvox-db` in package.json.
 *
 * Usage:
 *   node scripts/kvox-db-env.js <kvox-db arguments>
 *
 * Example:
 *   node scripts/kvox-db-env.js check --database
 */

const { spawn } = require('child_process');
const path = require('path');

// Same URL formula as every other helper (requiring prisma-env.js is side-effect
// free apart from its dotenv load).
const { constructDatabaseUrl } = require('./prisma-env.js');

/** Resolves the `kvox-db` bin of the installed @marinoscar/kvox-db. */
function resolveKvoxDbBin() {
  const pkgJson = require.resolve('@marinoscar/kvox-db/package.json');
  return path.join(path.dirname(pkgJson), 'bin', 'kvox-db.js');
}

function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.error('Error: No kvox-db command specified');
    console.error('Usage: node scripts/kvox-db-env.js <kvox-db arguments>');
    console.error('Example: node scripts/kvox-db-env.js check --database');
    process.exit(1);
  }

  const child = spawn(process.execPath, [resolveKvoxDbBin(), ...args], {
    env: { ...process.env, DATABASE_URL: constructDatabaseUrl() },
    stdio: 'inherit',
  });

  child.on('exit', (code, signal) => {
    process.exit(code === null ? (signal ? 1 : 0) : code);
  });

  child.on('error', (err) => {
    console.error('Failed to execute kvox-db:', err);
    process.exit(1);
  });
}

if (require.main === module) {
  main();
}

module.exports = { resolveKvoxDbBin };
