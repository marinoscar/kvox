// =============================================================================
// kg:eval — score knowledge-graph extraction against the golden set (issue #362)
// =============================================================================
//
//   npm run kg:eval --workspace=api -- --predictions gold
//   npm run kg:eval --workspace=api -- --predictions <dir> [--only m01,m07] [--tag promotion]
//   npm run kg:eval --workspace=api -- --run extract --model <id> [--out <dir>]
//   npm run kg:eval --workspace=api -- --real-dir <dir outside the repo> --export-note <id> --user <email>
//
// Flags: --json <file> also writes the report as JSON; --enforce exits 1 when a
// §6 target (docs/specs/ontology.md) fails — for local use, CI reports only.
//
// Exit codes: 0 ok · 1 --enforce and a target failed · 2 usage/runner/load
// error · 3 a real-data path inside the repository (refused).
//
// The API key for --run comes from KG_EVAL_OPENAI_API_KEY only, never a flag,
// and is never printed or written anywhere.
// =============================================================================

import { mkdirSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { parseArgs } from 'util';

import { goldPrediction } from './kg-eval/gold-runner';
import { GOLDEN_MEETINGS_DIR, KgEvalLoadError, loadGoldenSet, loadPredictionFile, selectFixtures } from './kg-eval/load';
import { emptyPrediction, kgEvalPredictionSchema, type KgEvalPrediction } from './kg-eval/prediction-schema';
import {
  assertOutsideRepo,
  exportNoteSkeleton,
  RealDataNotFoundError,
  RealDataPathError,
  syntheticRunsDir,
} from './kg-eval/real-data';
import { buildReport, formatReport } from './kg-eval/report';
import { KG_EVAL_API_KEY_ENV, KG_EVAL_RUNNERS } from './kg-eval/runner';
import { scoreRun } from './kg-eval/scorer';

export const EXIT = { ok: 0, targetsFailed: 1, usage: 2, pathRefused: 3 } as const;

const USAGE = `usage: kg:eval (--predictions <dir|gold> | --run <runner> --model <id> [--out <dir>])
               [--only m01,m07] [--tag <tag>] [--json <file>] [--enforce] [--real-dir <dir>]
       kg:eval --export-note <noteId> --user <email> --real-dir <dir>`;

class UsageError extends Error {}

interface Io {
  out: (s: string) => void;
  err: (s: string) => void;
  env: NodeJS.ProcessEnv;
}

export async function main(argv: string[], io: Io = defaultIo()): Promise<number> {
  try {
    return await run(argv, io);
  } catch (err) {
    if (err instanceof RealDataPathError) {
      io.err(`kg:eval: ${err.message}`);
      return EXIT.pathRefused;
    }
    if (err instanceof UsageError || err instanceof KgEvalLoadError || err instanceof RealDataNotFoundError) {
      io.err(`kg:eval: ${err.message}`);
      if (err instanceof UsageError) io.err(USAGE);
      return EXIT.usage;
    }
    throw err;
  }
}

async function run(argv: string[], io: Io): Promise<number> {
  let values: Record<string, string | boolean | undefined>;
  try {
    ({ values } = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: false,
      options: {
        predictions: { type: 'string' },
        run: { type: 'string' },
        model: { type: 'string' },
        out: { type: 'string' },
        only: { type: 'string' },
        tag: { type: 'string' },
        json: { type: 'string' },
        enforce: { type: 'boolean' },
        'real-dir': { type: 'string' },
        'export-note': { type: 'string' },
        user: { type: 'string' },
        help: { type: 'boolean' },
      },
    }));
  } catch (err) {
    throw new UsageError((err as Error).message);
  }
  const str = (k: string) => (typeof values[k] === 'string' ? (values[k] as string) : undefined);

  if (values.help) {
    io.out(USAGE);
    return EXIT.ok;
  }

  // Real-data mode: the path guard runs before anything is read or written.
  const realDirArg = str('real-dir') ?? (io.env.KG_EVAL_REAL_DIR || undefined);
  const realDir = realDirArg ? assertOutsideRepo(realDirArg) : null;

  const exportNote = str('export-note');
  if (exportNote !== undefined) {
    const email = str('user');
    if (!email) throw new UsageError('--export-note requires --user <email>');
    if (!realDir) throw new UsageError('--export-note requires --real-dir <dir> (or KG_EVAL_REAL_DIR)');
    const file = await withPrisma((prisma) => exportNoteSkeleton({ prisma, noteId: exportNote, email, realDir }));
    io.out(`kg:eval: wrote unlabelled skeleton ${file}`);
    return EXIT.ok;
  }

  const predictionsArg = str('predictions');
  const runnerName = str('run');
  if ((predictionsArg === undefined) === (runnerName === undefined)) {
    throw new UsageError('pass exactly one of --predictions <dir|gold> or --run <runner>');
  }

  // An unregistered runner is reported before anything is loaded or written.
  const runnerFactory =
    runnerName !== undefined && Object.prototype.hasOwnProperty.call(KG_EVAL_RUNNERS, runnerName)
      ? KG_EVAL_RUNNERS[runnerName]
      : undefined;
  if (runnerName !== undefined && !runnerFactory) {
    io.err(`kg:eval: no runner '${runnerName}' registered (lands with the kg.extract issue)`);
    return EXIT.usage;
  }

  const all = loadGoldenSet(realDir ?? GOLDEN_MEETINGS_DIR);
  const only = str('only')
    ?.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const fixtures = selectFixtures(all, only ?? null, str('tag') ?? null);
  if (fixtures.length === 0) throw new UsageError('no fixtures selected');

  const predictions = new Map<string, KgEvalPrediction>();
  let runnerLabel: string;
  let model: string | null = null;

  if (runnerName !== undefined) {
    const factory = runnerFactory as NonNullable<typeof runnerFactory>;
    model = str('model') ?? null;
    if (!model) throw new UsageError('--run requires --model <id>');
    const apiKey = io.env[KG_EVAL_API_KEY_ENV];
    if (!apiKey) throw new UsageError(`--run reads its API key from ${KG_EVAL_API_KEY_ENV}; it is not set`);

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const outArg = str('out') ?? (realDir ? join(realDir, 'runs', stamp) : join(syntheticRunsDir(), 'runs', stamp));
    const outDir = assertOutsideRepo(outArg, { allowSyntheticRunsDir: realDir === null });
    mkdirSync(outDir, { recursive: true });

    const runner = await factory();
    runnerLabel = runner.name;
    for (const fixture of fixtures) {
      const pred = kgEvalPredictionSchema.parse(await runner.run(fixture, { model, apiKey }));
      predictions.set(fixture.id, pred);
      writeFileSync(join(outDir, `${fixture.id}.json`), `${JSON.stringify(pred, null, 2)}\n`);
    }
    io.err(`kg:eval: predictions written to ${outDir}`);
  } else if (predictionsArg === 'gold') {
    runnerLabel = 'gold';
    for (const f of fixtures) predictions.set(f.id, goldPrediction(f));
  } else {
    runnerLabel = 'predictions';
    const dir = resolve(predictionsArg as string);
    for (const f of fixtures) {
      const pred = loadPredictionFile(dir, f.id);
      if (pred === null) io.err(`kg:eval: no prediction for ${f.id} in ${dir} (scored as empty)`);
      predictions.set(f.id, pred ?? emptyPrediction(f.id));
      model ??= pred?.model ?? null;
    }
  }

  const report = buildReport(scoreRun(fixtures, predictions), {
    runner: runnerLabel,
    model,
    fixtureIds: fixtures.map((f) => f.id),
  });
  io.out(formatReport(report));

  const jsonPath = str('json');
  if (jsonPath) {
    const abs = resolve(jsonPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, `${JSON.stringify(report, null, 2)}\n`);
  }

  if (values.enforce && !report.targetsMet) {
    io.err('kg:eval: one or more §6 targets failed (--enforce)');
    return EXIT.targetsFailed;
  }
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
