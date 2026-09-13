import { CLI_NAME } from '../branding.js';
import { HttpNodeApi, type NodeApi } from './node-api.js';
import { registerNode } from './enrollment.js';
import { NodeEngine } from './node-engine.js';
import type { NodeEngineEvent } from './node-events.js';
import { NodeLogger, readLogTail, formatLogRecord } from './logger.js';
import { startDaemonHost, type DaemonHost } from './daemon.js';
import { nodeLogPath, nodePidPath, nodeSocketPath, nodeTmpDir, type NodePathsContext } from './paths.js';
import { resolveNodeConfig, saveNodeConfig, type ResolvedNodeConfig } from './node-config.js';
import {
  probeCapabilities,
  runStartupSelfTest,
  type CapabilityProbe,
  type JobTypeRequirements,
} from './capabilities.js';
import { MemoryWatchdog, memoryWatchdogEnabled } from './memory-watchdog.js';
import { writeHeapSnapshot } from './heap-snapshot.js';
import { resolveDefaultConcurrency } from './runtime-tuning.js';
import { snapshotsDir } from './paths.js';

// =============================================================================
// `node start`  (issue #275, epic #254)
// =============================================================================
//
// Wires config → API client → engine → daemon socket → signal handlers, and
// owns exactly two decisions that are hard to get right anywhere else:
//
//   1. EVERY RUN HOSTS THE DAEMON SOCKET, foreground or detached. A worker you
//      can only inspect if you happened to start it a particular way is a
//      worker nobody inspects.
//
//   2. `--headless` DRAINS ON SIGTERM WITHOUT DEREGISTERING. A restarting
//      container must RE-ATTACH to its existing node row; deregistering on
//      every SIGTERM would leak a row per restart, and a crash-looping replica
//      would fill the fleet page with corpses. Interactive Ctrl-C does
//      deregister, because a human stopping a worker on their laptop means it
//      is going away.
// =============================================================================

export interface StartNodeOptions extends NodePathsContext {
  /** Drain-without-deregister on SIGTERM. Also settable through the environment. */
  headless?: boolean | undefined;
  /** Streams. Human output goes to stderr, per program.ts. */
  stderr?: { write(chunk: string): unknown } | undefined;
  /** Test seams. */
  createApi?: ((config: ResolvedNodeConfig) => NodeApi) | undefined;
  /** Replaces the signal wiring, which a test must not install globally. */
  installSignalHandlers?: ((handler: (signal: NodeJS.Signals) => void) => void) | undefined;
  /** Wired by #277. */
  writeHeapSnapshot?: (() => Promise<{ path: string; size: number }>) | undefined;
  capabilities?: Record<string, unknown> | undefined;
  /** Overrides the capability probe. Injected by tests; never in production. */
  probe?: CapabilityProbe | undefined;
  /** Overrides `JOB_TYPE_REQUIREMENTS`. A fork could supply its own map here. */
  requirements?: Record<string, JobTypeRequirements> | undefined;
  /**
   * Run the startup self-test. Defaults to ON in headless mode, where a hard
   * exit is a visible crash-loop with a reason; interactive runs default to
   * warning, because a human is right there to read it.
   */
  selfTest?: boolean | undefined;
  /** Replaces `process.exit` for the self-test's hard failure. */
  exit?: ((code: number) => never) | undefined;
  /** `false` disables the memory watchdog for this run (#277). */
  watchdog?: boolean | undefined;
}

/** Exit code for "this node cannot do the work it advertised". */
export const EXIT_MISSING_CAPABILITY = 70;

export interface StartedNode {
  engine: NodeEngine;
  /** `undefined` when the watchdog is disabled. */
  watchdog: MemoryWatchdog | undefined;
  host: DaemonHost;
  logger: NodeLogger;
  config: ResolvedNodeConfig;
  /** Resolves when the engine has drained and the socket is closed. */
  finished: Promise<void>;
}

/**
 * Start a worker in this process and return once it is serving.
 *
 * Returns rather than awaiting the run loop, so a caller can hold the handle —
 * which is what makes this testable and what #279's TUI needs.
 */
export async function startNode(options: StartNodeOptions = {}): Promise<StartedNode> {
  const stderr = options.stderr ?? process.stderr;
  const pathCtx: NodePathsContext = {
    ...(options.env !== undefined ? { env: options.env } : {}),
    ...(options.home !== undefined ? { home: options.home } : {}),
    ...(options.platform !== undefined ? { platform: options.platform } : {}),
  };

  // The RAM- and core-aware default lands here rather than in `node-config.ts`
  // so the config module stays free of any runtime-tuning dependency; an
  // explicit setting in the file or the environment still wins.
  const config = resolveNodeConfig({ ...pathCtx, defaultConcurrency: resolveDefaultConcurrency() });
  const headless = options.headless ?? config.headless;

  const logger = new NodeLogger({
    path: nodeLogPath(pathCtx),
    // In the foreground a human wants to see what is happening; a detached run
    // has its stdio redirected to the same file anyway, so mirroring would
    // double every line.
    ...(headless ? {} : { mirror: (record) => stderr.write(`${formatLogRecord(record)}\n`) }),
  });

  // ---------------------------------------------------------------------------
  // The startup self-test (#276), BEFORE anything is registered or claimed
  // ---------------------------------------------------------------------------
  // A node that cannot do the work it advertised must not reach the claim loop:
  // there it would take a lease, fail it, and charge the job an attempt — once
  // per job, looking healthy the whole time.
  const probe = options.probe ?? probeCapabilities();
  const selfTestEnabled = options.selfTest ?? headless;
  if (selfTestEnabled) {
    const failures: string[] = [];
    const result = runStartupSelfTest({
      types: config.node.eligibleTypes,
      probe,
      ...(options.requirements !== undefined ? { requirements: options.requirements } : {}),
      warn: (message) => logger.warn(message),
      fail: (message) => {
        logger.error(message);
        failures.push(message);
      },
    });

    if (!result.ok) {
      stderr.write(`${failures.join('\n')}\n`);
      const exit = options.exit ?? ((code: number) => process.exit(code));
      exit(EXIT_MISSING_CAPABILITY);
    }
  }

  const api = options.createApi?.(config) ?? HttpNodeApi.create(config.serverUrl, config.token);

  // Register on first start. `validateTypes: false` because a start must not
  // fail because `GET /nodes/job-types` was briefly unavailable — the server
  // re-checks every claim against its own registry regardless.
  let nodeId = config.nodeId;
  if (nodeId === undefined) {
    const registered = await registerNode({
      api,
      node: config.node,
      validateTypes: false,
      configContext: pathCtx,
      ...(options.capabilities !== undefined ? { capabilities: options.capabilities } : {}),
    });
    nodeId = registered.node.id;
    logger.info(registered.reattached ? 'reattached to node' : 'registered node', {
      nodeId,
      name: registered.node.name,
    });
  }

  let host: DaemonHost | undefined;

  const engine = new NodeEngine({
    api,
    nodeId,
    concurrency: config.node.concurrency,
    eligibleTypes: config.node.eligibleTypes,
    pollIntervalMs: config.node.pollIntervalMs,
    tmpDir: nodeTmpDir(pathCtx),
    capabilities: { ...(options.capabilities ?? {}), probe: { ...probe } },
    persistConcurrency: (value) => {
      saveNodeConfig({ node: { concurrency: value } }, { ...pathCtx, degradeOnFailure: true });
    },
    onEvent: (event) => {
      logEvent(logger, event);
      host?.broadcast(event);
    },
  });

  // The `heap-snapshot` IPC command asks the LIVE daemon to write one, which
  // is the point: restarting to attach a diagnostic flag discards exactly the
  // accumulated state that names the retainer.
  const snapshotWriter =
    options.writeHeapSnapshot ??
    (async () => {
      const result = writeHeapSnapshot({ dir: snapshotsDir(pathCtx), reason: 'manual', ...(options.env !== undefined ? { env: options.env } : {}) });
      if (!result.written) throw new Error(result.skipped ?? 'The snapshot could not be written.');
      return { path: result.path ?? '', size: result.size ?? 0 };
    });

  host = await startDaemonHost(engine, logger, {
    pidPath: nodePidPath(pathCtx),
    socketPath: nodeSocketPath(pathCtx),
    logTail: () => readLogTail(nodeLogPath(pathCtx), 50),
    writeHeapSnapshot: snapshotWriter,
  });

  // ---------------------------------------------------------------------------
  // The memory watchdog (#277)
  // ---------------------------------------------------------------------------
  // ⚠ Its valve EXITS DELIBERATELY after a clean drain. Without a supervisor —
  // `Restart=on-failure` (#276) or `restart: unless-stopped` (#278) — that
  // successful drain leaves the worker down.
  const watchdog =
    options.watchdog === false || !memoryWatchdogEnabled(options.env ?? process.env)
      ? undefined
      : new MemoryWatchdog({
          snapshotDir: snapshotsDir(pathCtx),
          ...(options.env !== undefined ? { env: options.env } : {}),
          stop: () => engine.stop({ deregister: false }),
          log: (message, fields) => logger.warn(message, fields),
        });
  watchdog?.start();

  const install =
    options.installSignalHandlers ??
    ((handler: (signal: NodeJS.Signals) => void) => {
      for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(signal, () => handler(signal));
    });

  let shuttingDown = false;
  install((signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('shutdown signal received', { signal, headless });
    // THE ONE BRANCH THAT MATTERS. See the file header.
    void engine.stop({ deregister: !headless });
  });

  const finished = engine
    .run()
    .then(async () => {
      watchdog?.stop();
      await host?.close();
    })
    .catch(async (error: unknown) => {
      logger.error('worker exited with an error', { error: error instanceof Error ? error.message : String(error) });
      watchdog?.stop();
      await host?.close();
      throw error;
    });

  logger.info('worker started', {
    nodeId,
    name: config.node.name,
    concurrency: config.node.concurrency,
    types: engine.claimableTypes(),
    headless,
  });

  if (!headless) {
    stderr.write(
      `Worker ${config.node.name} (${nodeId}) is running.\n` +
        `  Concurrency ${config.node.concurrency}; types ${
          engine.claimableTypes().length > 0 ? engine.claimableTypes().join(', ') : '(none — this node has no executors)'
        }\n` +
        `  Attach from another terminal: ${CLI_NAME} node status\n`,
    );
  }

  return { engine, host, logger, config, watchdog, finished };
}

/**
 * One engine event → one log line.
 *
 * Kept OUT of the engine deliberately: the engine is UI-free and must stay
 * renderable by a printer, the IPC broadcast and the TUI without any of them
 * inheriting a logging opinion from it.
 */
function logEvent(logger: NodeLogger, event: NodeEngineEvent): void {
  switch (event.kind) {
    case 'job-succeeded':
      logger.info('job succeeded', { jobId: event.jobId, type: event.type, durationMs: event.durationMs });
      return;
    case 'job-failed':
      logger.error('job failed', {
        jobId: event.jobId,
        type: event.type,
        error: event.error,
        rateLimited: event.rateLimited,
        willRetry: event.willRetry,
      });
      return;
    case 'job-started':
      logger.info('job started', { jobId: event.jobId, type: event.type });
      return;
    case 'lease-renew-failed':
      logger.warn('lease renew failed', { jobId: event.jobId, error: event.error });
      return;
    case 'heartbeat-failed':
      logger.warn('heartbeat failed', { error: event.error });
      return;
    case 'claim-failed':
      logger.warn('claim failed', { error: event.error });
      return;
    case 'concurrency-changed':
      logger.info('concurrency changed', { concurrency: event.concurrency });
      return;
    case 'draining':
      logger.info('draining', { inFlight: event.inFlight });
      return;
    case 'stopped':
      logger.info('stopped', { deregistered: event.deregistered });
      return;
    default:
      // `idle`, `claimed`, `heartbeat`, `job-input`, `job-log`, `lease-renewed`
      // and `started` are high-volume or uninteresting on their own; they still
      // reach attached clients through the broadcast.
      logger.debug(event.kind, { event });
  }
}
