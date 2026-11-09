// =============================================================================
// `kvox-eval calibrate` (issue #681)
// =============================================================================
//
//   kvox-eval calibrate --self-test
//   kvox-eval calibrate --dump-texts <file>
//   kvox-eval calibrate --vectors <recorded.json> [--vectors <more.json>] [--json <file>]
//
// --self-test    runs the harness on deterministic hashed n-gram vectors: a check that the
//                set loads and the report renders. The numbers say nothing about a model.
// --dump-texts   writes the distinct texts to embed, as a JSON array: embed them with the
//                host's model (documents, no query prefix) and record
//                `{ "model": "<catalog id>", "vectors": { "<text>": [..] } }`.
// --vectors      measures a recorded model against the catalog value it ships with.
// --json         also writes the reports as JSON.
//
// Exit codes: 0 ok · 2 usage or an unreadable file.
// =============================================================================

import { mkdirSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { parseArgs } from 'util';

import { KVOX_EMBEDDING, KVOX_LOCAL_EMBEDDING } from '@marinoscar/kvox-ai';

import { loadGoldenMeetings } from '../fixtures/index.js';
import { resolveGraphCalibration } from './internals.js';
import { buildCalibrationSet, calibrationTexts, CalibrationSetError } from './calibration-set.js';
import { hashedNgramVectors, recordedVectors } from './embedders.js';
import { evaluateModel, type ModelCalibrationReport } from './evaluate.js';
import { formatCalibrationReport } from './report.js';

/**
 * Where the command writes, and the environment it reads (structurally the `cli` slice's `EvalCommandIo`).
 *
 * @stability experimental
 */
export interface CalibrateCommandIo {
  /** One line to standard output. */
  out: (line: string) => void;
  /** One line to standard error. */
  err: (line: string) => void;
}

/**
 * The usage text of `kvox-eval calibrate`.
 *
 * @stability experimental
 */
export const CALIBRATE_COMMAND_USAGE = `usage: kvox-eval calibrate --self-test
       kvox-eval calibrate --dump-texts <file>
       kvox-eval calibrate --vectors <recorded.json> [--vectors <more.json>] [--json <file>]

  --self-test         run on deterministic hashed n-gram vectors (a harness check, not a model)
  --dump-texts <file> write the distinct texts to embed with your model (JSON array)
  --vectors <file>    recorded vectors: { "model": "<id>", "vectors": { "<text>": [..] } }
  --json <file>       also write the reports as JSON`;

/** The catalog's current calibration for a model id (the OpenAI baseline for one it does not know). */
function catalogCalibration(model: string) {
  const entry = [KVOX_EMBEDDING, KVOX_LOCAL_EMBEDDING].find((e) => e.model === model);
  return resolveGraphCalibration(entry?.graphCalibration);
}

/**
 * Runs `kvox-eval calibrate`.
 *
 * @param argv - the arguments after the command name.
 * @param io - output streams.
 * @returns the exit code.
 * @stability experimental
 */
export async function runCalibrateCommand(argv: string[], io: CalibrateCommandIo): Promise<number> {
  let values: { 'self-test'?: boolean; 'dump-texts'?: string; vectors?: string[]; json?: string; help?: boolean };
  try {
    values = parseArgs({
      args: argv,
      allowPositionals: false,
      options: {
        'self-test': { type: 'boolean' },
        'dump-texts': { type: 'string' },
        vectors: { type: 'string', multiple: true },
        json: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    }).values;
  } catch (error) {
    io.err(`kvox-eval calibrate: ${error instanceof Error ? error.message : String(error)}`);
    io.err(CALIBRATE_COMMAND_USAGE);
    return 2;
  }
  if (values.help) {
    io.out(CALIBRATE_COMMAND_USAGE);
    return 0;
  }
  if (!values['self-test'] && !values['dump-texts'] && !(values.vectors && values.vectors.length > 0)) {
    io.err('kvox-eval calibrate: give --self-test, --dump-texts or --vectors');
    io.err(CALIBRATE_COMMAND_USAGE);
    return 2;
  }

  try {
    const set = buildCalibrationSet(loadGoldenMeetings());
    const texts = calibrationTexts(set);

    if (values['dump-texts']) {
      const file = resolve(values['dump-texts']);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, `${JSON.stringify(texts, null, 2)}\n`);
      io.out(`${texts.length} texts written to ${file}`);
      if (!values['self-test'] && !values.vectors?.length) return 0;
    }

    const reports: ModelCalibrationReport[] = [];
    if (values['self-test']) {
      reports.push(evaluateModel('self-test:hashed-ngram', set, hashedNgramVectors(texts)));
    }
    for (const file of values.vectors ?? []) {
      const { model, vectors } = recordedVectors(resolve(file));
      reports.push(evaluateModel(model, set, vectors, { calibration: catalogCalibration(model) }));
    }

    io.out(formatCalibrationReport(reports));
    if (values.json) {
      const file = resolve(values.json);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, `${JSON.stringify(reports, null, 2)}\n`);
    }
    return 0;
  } catch (error) {
    if (error instanceof CalibrationSetError) {
      io.err(`kvox-eval calibrate: ${error.message}`);
      return 2;
    }
    throw error;
  }
}
