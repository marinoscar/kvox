#!/usr/bin/env node
/**
 * db-drift-kvox.mjs - `npm run db:drift:kvox`, a FILTERED platform drift check.
 *
 * `platform db drift` replays prisma/migrations into a shadow database, diffs
 * the result against the composed schema (prisma/schema/), and asserts the
 * raw-SQL indexes and RLS policies against the live database. For KVox it is
 * never clean on its own, because Prisma's schema language cannot express some
 * of what the migrations create, and because three temporary deviation columns
 * exist on platform tables. Every statement it prints for those is listed, with
 * a reason and the issue that removes it, in prisma/drift-allowlist.json.
 *
 * This script runs the platform check (through scripts/platform-env.js, which
 * builds DATABASE_URL from POSTGRES_*), removes the allowlisted SCHEMA_DRIFT
 * statements, and fails (exit 1) on:
 *   - any SCHEMA_DRIFT statement that is not allowlisted,
 *   - any other problem the platform check prints (INDEX_MISSING,
 *     INDEX_DEFINITION_DIFFERS, POLICY_MISSING, ...), which are never filtered,
 *   - a failed run that printed neither (the tool itself broke).
 * An allowlist entry the check no longer prints is reported as STALE (a notice,
 * not a failure): delete it when the issue named in `removeIn` lands.
 *
 * The allowlist is the ONLY place a drift statement is excused. Never "fix" a
 * raw-SQL index statement by adding @@index/@@unique to a fragment.
 *
 * Usage:
 *   node scripts/db-drift-kvox.mjs                     run the check
 *   node scripts/db-drift-kvox.mjs --from-file <f>     filter saved drift output
 *                                                      (stderr of `db drift`); no database
 *   node scripts/db-drift-kvox.mjs --allowlist <f>     another allowlist file
 *
 * Exit codes: 0 clean after filtering, 1 unexplained drift, 2 usage / broken allowlist.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const apiDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Same normalisation the platform baseline uses for statements. */
export function normaliseStatement(statement) {
  return statement.replace(/"public"\./g, '').replace(/\s+/g, ' ').trim();
}

/** Splits `prisma migrate diff --script` output into statements (comments dropped, `;` kept). */
export function splitStatements(script) {
  return script
    .split(/;[ \t]*\r?\n|;[ \t]*$/m)
    .map((chunk) => chunk.replace(/^(\s*--[^\n]*\n)+/g, '').replace(/^\s*--[^\n]*$/gm, '').trim())
    .filter((chunk) => chunk !== '')
    .map((chunk) => normaliseStatement(chunk.endsWith(';') ? chunk : `${chunk};`));
}

/**
 * Splits the combined output of `platform db drift` into the SCHEMA_DRIFT
 * statements and the other problem lines.
 */
export function parseDriftOutput(text) {
  const lines = text.split(/\r?\n/);
  const problems = [];
  const diffLines = [];
  let inDiff = false;
  for (const line of lines) {
    if (/^SCHEMA_DRIFT\b/.test(line)) {
      inDiff = true;
      continue;
    }
    // A problem line is `CODE  message` (two spaces), the format drift prints.
    if (/^[A-Z][A-Z_]{3,}  \S/.test(line)) {
      inDiff = false;
      problems.push(line.trim());
      continue;
    }
    // npm's own failure banner (when run through `npm run db:drift`) ends the diff.
    if (/^(npm (error|ERR!)|\u25c7 injected env)/.test(line)) {
      inDiff = false;
      continue;
    }
    if (inDiff) diffLines.push(line);
  }
  return { statements: splitStatements(diffLines.join('\n')), problems };
}

export function loadAllowlist(file) {
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  const entries = Array.isArray(parsed) ? parsed : parsed.entries;
  if (!Array.isArray(entries)) throw new Error(`${file}: expected { "entries": [...] }`);
  for (const [i, e] of entries.entries()) {
    for (const key of ['statement', 'reason', 'removeIn']) {
      if (typeof e[key] !== 'string' || e[key].trim() === '') {
        throw new Error(`${file}: entry ${i} has no ${key}`);
      }
    }
  }
  return entries.map((e) => ({ ...e, statement: normaliseStatement(e.statement) }));
}

/** Applies the allowlist: what is left is unexplained, and which entries matched nothing. */
export function filterDrift(parsed, allowlist) {
  const allowed = new Set(allowlist.map((e) => e.statement));
  const seen = new Set();
  const unexplained = [];
  for (const statement of parsed.statements) {
    if (allowed.has(statement)) seen.add(statement);
    else unexplained.push(statement);
  }
  const stale = allowlist.filter((e) => !seen.has(e.statement));
  return { unexplained, stale, excused: seen.size };
}

function parseArgs(argv) {
  const args = { fromFile: null, allowlist: join(apiDir, 'prisma', 'drift-allowlist.json') };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--from-file') args.fromFile = argv[++i];
    else if (argv[i] === '--allowlist') args.allowlist = resolve(argv[++i]);
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  return args;
}

export function main(argv, out = process.stdout, err = process.stderr) {
  let args;
  let allowlist;
  try {
    args = parseArgs(argv);
    allowlist = loadAllowlist(args.allowlist);
  } catch (e) {
    err.write(`db:drift:kvox: ${e.message}\n`);
    return 2;
  }

  let text;
  let status = 0;
  if (args.fromFile) {
    text = readFileSync(args.fromFile, 'utf8');
    status = /^SCHEMA_DRIFT\b|^[A-Z][A-Z_]{3,}  \S/m.test(text) ? 1 : 0;
  } else {
    const run = spawnSync(process.execPath, [join(apiDir, 'scripts', 'platform-env.js'), 'db', 'drift'], {
      cwd: apiDir,
      env: process.env,
      encoding: 'utf8',
    });
    if (run.error) {
      err.write(`db:drift:kvox: could not run the platform drift check: ${run.error.message}\n`);
      return 2;
    }
    status = run.status ?? 1;
    text = `${run.stderr ?? ''}\n${run.stdout ?? ''}`;
    if (status === 0) {
      out.write('db:drift:kvox: ok (platform drift is clean on its own; the allowlist excused nothing)\n');
      for (const e of allowlist) err.write(`  STALE  ${e.statement}  (removeIn ${e.removeIn})\n`);
      return 0;
    }
  }

  const parsed = parseDriftOutput(text);
  if (status !== 0 && parsed.statements.length === 0 && parsed.problems.length === 0) {
    err.write(`db:drift:kvox: the platform drift check failed without a drift report:\n${text}\n`);
    return 1;
  }

  const { unexplained, stale, excused } = filterDrift(parsed, allowlist);
  for (const e of stale) err.write(`  STALE  ${e.statement}  (removeIn ${e.removeIn}; delete the entry once that lands)\n`);

  if (unexplained.length === 0 && parsed.problems.length === 0) {
    out.write(`db:drift:kvox: ok (${excused} statement(s) excused by prisma/drift-allowlist.json)\n`);
    return 0;
  }
  err.write('db:drift:kvox: FAILED\n');
  for (const s of unexplained) err.write(`  SCHEMA_DRIFT  not in the allowlist: ${s}\n`);
  for (const p of parsed.problems) err.write(`  ${p}\n`);
  err.write('Add a migration for real drift. A raw-SQL index Prisma cannot express goes in prisma/drift-allowlist.json with a reason and removeIn; never into a fragment as @@index/@@unique.\n');
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
