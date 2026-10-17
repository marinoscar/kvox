// =============================================================================
// kg:eval — score knowledge-graph extraction against the golden set (issue #362)
// =============================================================================
//
//   npm run kg:eval --workspace=api -- --predictions gold
//   npm run kg:eval --workspace=api -- --predictions <dir> [--only m01,m07] [--tag promotion]
//   npm run kg:eval --workspace=api -- --run extract --model <id> [--out <dir>]
//   npm run kg:eval --workspace=api -- --real-dir <dir outside the repo> --export-note <id> --user <email>
//
// A THIN WRAPPER (#580): everything but `--export-note` is `kvox-eval kg` of
// `@marinoscar/kvox-eval` (`runKgCommand`), run under this script's name with
// the git-ignored `apps/api/.kg-eval/` as the synthetic runs directory. Every
// flag of the package command works here (`--runner`/`--run`, `--provider`,
// `--base-url`, ...). `--export-note` reads this app's database, so it stays here.
//
// Flags: --json <file> also writes the report as JSON; --enforce exits 1 when a
// §6 target (docs/specs/ontology.md) fails — for local use, CI reports only.
//
// Exit codes: 0 ok · 1 --enforce and a target failed · 2 usage/runner/load
// error · 3 a real-data path inside the repository (refused).
//
// The API key for --run comes from KVOX_EVAL_OPENAI_API_KEY (KG_EVAL_OPENAI_API_KEY
// for one more release) only, never a flag, and is never printed or written anywhere.
// =============================================================================

// Registers the settings namespaces `DEFAULT_SYSTEM_SETTINGS` is composed from.
// Must be the first import (see src/kvox.manifest.ts).
import '../src/kvox.manifest';

import { parseArgs } from 'util';

import { KG_EVAL_EXIT, KVOX_EVAL_API_KEY_ENV, runKgCommand, type EvalCommandIo } from '@marinoscar/kvox-eval';

import { assertOutsideRepo, exportNoteSkeleton, RealDataNotFoundError, RealDataPathError, syntheticRunsDir } from './kg-eval/real-data';

export const EXIT = KG_EVAL_EXIT;

const USAGE = `usage: kg:eval (--predictions <dir|gold> | --run <runner> --model <id> [--out <dir>])
               [--provider openai|openai-compatible|copilot] [--base-url <url>]
               [--only m01,m07] [--tag <tag>] [--json <file>] [--enforce] [--real-dir <dir>]
       kg:eval --export-note <noteId> --user <email> --real-dir <dir>
       reads a live runner's API key from ${KVOX_EVAL_API_KEY_ENV} (never a flag)`;

class UsageError extends Error {}

type Io = EvalCommandIo;

export async function main(argv: string[], io: Io = defaultIo()): Promise<number> {
  if (!argv.some((a) => a === '--export-note' || a.startsWith('--export-note='))) {
    return runKgCommand(argv, io, { name: 'kg:eval', usage: USAGE, syntheticRunsDir: syntheticRunsDir() });
  }
  try {
    return await exportNote(argv, io);
  } catch (err) {
    if (err instanceof RealDataPathError) {
      io.err(`kg:eval: ${err.message}`);
      return EXIT.pathRefused;
    }
    if (err instanceof UsageError || err instanceof RealDataNotFoundError) {
      io.err(`kg:eval: ${err.message}`);
      if (err instanceof UsageError) io.err(USAGE);
      return EXIT.usage;
    }
    throw err;
  }
}

/** `--export-note <id> --user <email> --real-dir <dir>`: one of your notes as an unlabelled skeleton. */
async function exportNote(argv: string[], io: Io): Promise<number> {
  let values: Record<string, string | boolean | undefined>;
  try {
    ({ values } = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: false,
      options: {
        'export-note': { type: 'string' },
        user: { type: 'string' },
        'real-dir': { type: 'string' },
      },
    }));
  } catch (err) {
    throw new UsageError((err as Error).message);
  }
  const str = (k: string) => (typeof values[k] === 'string' ? (values[k] as string) : undefined);

  // The path guard runs before anything is read or written.
  const realDirArg = str('real-dir') ?? (io.env.KG_EVAL_REAL_DIR || undefined);
  const realDir = realDirArg ? assertOutsideRepo(realDirArg) : null;

  const noteId = str('export-note') as string;
  const email = str('user');
  if (!email) throw new UsageError('--export-note requires --user <email>');
  if (!realDir) throw new UsageError('--export-note requires --real-dir <dir> (or KG_EVAL_REAL_DIR)');
  const file = await withPrisma((prisma) => exportNoteSkeleton({ prisma, noteId, email, realDir }));
  io.out(`kg:eval: wrote unlabelled skeleton ${file}`);
  return EXIT.ok;
}

async function withPrisma<T>(fn: (prisma: import('@prisma/client').PrismaClient) => Promise<T>): Promise<T> {
  // Loaded lazily so a scoring run never needs a generated client or a database.
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
  const { PrismaPg } = require('@prisma/adapter-pg') as typeof import('@prisma/adapter-pg');
  const { buildDatabaseUrl } = require('../src/common/database-url') as typeof import('../src/common/database-url');
  /* eslint-enable @typescript-eslint/no-require-imports */
  const prisma = new PrismaClient({ adapter: new PrismaPg(buildDatabaseUrl()) });
  try {
    return await fn(prisma);
  } finally {
    await prisma.$disconnect();
  }
}

function defaultIo(): Io {
  return {
    out: (s) => process.stdout.write(`${s}\n`),
    err: (s) => process.stderr.write(`${s}\n`),
    env: process.env,
  };
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      process.stderr.write(`kg:eval: ${(err as Error).stack ?? String(err)}\n`);
      process.exitCode = 2;
    },
  );
}
