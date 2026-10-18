// The ask-run slice's public surface (re-exported by the package root): the
// headless Ask evaluation. An in-memory PostgreSQL (PGlite) migrated with the
// platform and domain history, the golden graph seeded through the graph write
// service, the real `ask.respond` handler on the Ask slice, over any model port.
export { ASK_EVAL_USER_EMAIL, startAskEvalHost } from './host/app.js';
export type { AskEvalHost, StartAskEvalHostOptions } from './host/app.js';
export { ASK_EVAL_HOST_DIR, startAskEvalDatabase } from './host/db.js';
export type { AskEvalDatabase, AskEvalPrismaClient } from './host/db.js';
export { ASK_EVAL_PERMISSIONS, createAskEvalIdentity, createAskEvalJobs, createAskEvalSettings } from './host/ports.js';
export { seedGoldenGraph } from './seed-golden-graph.js';
export type { AskEvalIdMap, AskEvalSeedRefusal, SeededGoldenGraph } from './seed-golden-graph.js';
export { DEFAULT_ASK_EVAL_MODEL, runAskEval, startAskEvalSession } from './run-ask-eval.js';
export type { AskEvalRunResult, AskEvalSession, AskQuestionRunResult, RunAskEvalOptions } from './run-ask-eval.js';
export {
  ASK_REPLAY_MODEL,
  ASK_REPLAY_SCENARIOS,
  ASK_REPLAY_SENSITIVE_TEXT,
  askReplayStepEvents,
  runAskReplay,
} from './replay.js';
export type { AskReplayResult, AskReplayRun, AskReplayScenario, AskReplayStep } from './replay.js';
