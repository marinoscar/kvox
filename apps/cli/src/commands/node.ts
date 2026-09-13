import type { Command } from 'commander';

import { CLI_NAME } from '../branding.js';
import { PreconditionError, UsageError } from '../errors.js';
import { enrollNode, registerNode } from '../node/enrollment.js';
import { HttpNodeApi } from '../node/node-api.js';
import {
  parseEligibleTypes,
  resolveNodeConfig,
  type NodeConfig,
} from '../node/node-config.js';
import { WORKER_ENV } from '../node/worker-env.js';
import { resolveConfig } from '../config.js';
import { formatLogRecord, readLogTail } from '../node/logger.js';
import {
  applyConcurrency,
  noDaemonHint,
  readLiveStatus,
  spawnDetachedDaemon,
  stopNode,
} from '../node/lifecycle.js';
import { connectToDaemon } from '../node/daemon.js';
import { nodeLogPath, nodePidPath, nodeSocketPath } from '../node/paths.js';
import { startNode } from '../node/start.js';
import { saveNodeConfig } from '../node/node-config.js';
import { formatDoctorReport, runDoctor } from '../node/doctor.js';
import { formatInstallReport, runInstallDeps } from '../node/install-deps.js';
import { installService, serviceStatus, uninstallService } from '../node/service.js';
import { nodeStateDir } from '../node/paths.js';
import { maybeReexecWithHeapLimit } from '../node/runtime-tuning.js';

// =============================================================================
// `appctl node` — the worker-node command group  (issue #272, epic #254)
// =============================================================================
//
// This file establishes the GROUP; the subcommands arrive with the issues that
// own them (#273 register/enroll, #275 start/stop/status/logs/set-concurrency,
// #276 doctor/install-deps/service, #277 heap-snapshot). Registering the group
// here, in its own module, is what lets each of those be a purely additive
// change to one file rather than a widening edit to `program.ts`.
//
// Inherited from `program.ts` and not negotiable in any subcommand added here:
//
//   - HUMAN OUTPUT GOES TO STDERR. stdout carries `--json` and nothing else.
//   - FAILURE IS NON-ZERO, ALWAYS.
// =============================================================================

/**
 * Injection seam shared by every `node` subcommand.
 *
 * Deliberately the same shape as `DeployContext`: streams, a fetch, and the
 * odd engine override. Tests drive the commands through this rather than
 * mutating `process.env` or writing to a real home directory.
 */
export interface NodeCommandContext {
  stdout?: { write(chunk: string): unknown } | undefined;
  stderr?: { write(chunk: string): unknown } | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  home?: string | undefined;
  fetch?: typeof globalThis.fetch | undefined;
}

export function registerNodeCommand(program: Command, ctx?: NodeCommandContext): Command {
  const node = program
    .command('node')
    .description('Run this machine as a worker node for the application’s job queue');

  node
    .command('config')
    .description('Show the worker settings this machine would start with')
    .option('--json', 'Emit the resolved settings as JSON on stdout')
    .action((options: { json?: boolean }) => {
      const stdout = ctx?.stdout ?? process.stdout;
      const stderr = ctx?.stderr ?? process.stderr;

      const resolved = resolveNodeConfig(contextOf(ctx));

      if (options.json === true) {
        // The token is NEVER in this output. `resolveNodeConfig` returns it
        // because the engine needs it; a display path that forwarded it would
        // put a `nod_` credential into anybody's terminal scrollback and CI
        // log. Fields are listed explicitly rather than spread for exactly
        // that reason — a spread would leak a future secret automatically.
        stdout.write(
          `${JSON.stringify(
            {
              serverUrl: resolved.serverUrl,
              nodeId: resolved.nodeId ?? null,
              name: resolved.node.name,
              concurrency: resolved.node.concurrency,
              eligibleTypes: resolved.node.eligibleTypes,
              pollIntervalMs: resolved.node.pollIntervalMs,
              headless: resolved.headless,
              stateDir: resolved.stateDir,
              synthesised: resolved.synthesised,
            },
            null,
            2,
          )}\n`,
        );
        return;
      }

      const lines = [
        `Server        ${resolved.serverUrl} (${resolved.serverUrlSource})`,
        `Node          ${resolved.nodeId ?? `not registered — run \`${CLI_NAME} node register\``}`,
        `Name          ${resolved.node.name}`,
        `Concurrency   ${resolved.node.concurrency}`,
        `Types         ${
          resolved.node.eligibleTypes.length > 0 ? resolved.node.eligibleTypes.join(', ') : '(all node-eligible types)'
        }`,
        `Poll interval ${resolved.node.pollIntervalMs} ms`,
        `Headless      ${resolved.headless ? 'yes' : 'no'}`,
        `State dir     ${resolved.stateDir}`,
      ];

      if (resolved.synthesised) {
        lines.push('', `No config file — these settings came from ${WORKER_ENV.serverUrl}/${WORKER_ENV.token}.`);
      }

      stderr.write(`${lines.join('\n')}\n`);
    });

  node
    .command('enroll')
    .description('Log in and mint a node credential for this machine, in one step')
    .option('-s, --server <url>', 'Server URL, when this machine has no stored one')
    .option('-n, --name <name>', 'Name for the credential in the web UI')
    .option('--expires-in-days <days>', 'Expire the credential after N days (default: never)')
    .option('--no-browser', 'Do not try to open a browser; print the URL instead')
    .option(
      '--show-token',
      'Print the credential. Only needed to provision ANOTHER machine — it is already stored here',
    )
    .action(async (options: EnrollCommandOptions) => {
      const stdout = ctx?.stdout ?? process.stdout;
      const stderr = ctx?.stderr ?? process.stderr;
      const configContext = contextOf(ctx);

      const serverUrl = options.server ?? resolveConfig(configContext).serverUrl;
      if (serverUrl === undefined) {
        throw new UsageError(
          `No server URL. Pass --server, or set ${WORKER_ENV.serverUrl}.`,
        );
      }

      const result = await enrollNode({
        serverUrl,
        ...(options.name !== undefined ? { credentialName: options.name } : {}),
        ...(options.expiresInDays !== undefined
          ? { expiresInDays: parsePositiveInteger('--expires-in-days', options.expiresInDays) }
          : {}),
        openBrowser: options.browser !== false,
        configContext,
        hooks: {
          onCodeIssued: (grant) => {
            stderr.write(
              `\nTo authorise this machine, open:\n  ${grant.verificationUriComplete}\n` +
                `and confirm the code:  ${grant.userCode}\n\n`,
            );
          },
        },
      });

      stderr.write(
        `Enrolled. Credential "${result.credentialName}" (${result.tokenPrefix}…) stored in ${result.configPath}.\n` +
          `Expiry: ${result.expiresAt ?? 'never'}\n` +
          `Next:   ${CLI_NAME} node register\n`,
      );

      // stdout ONLY when explicitly asked for, so the secret is pipeable to a
      // provisioning script and absent from every other invocation's output.
      if (options.showToken === true) stdout.write(`${result.token}\n`);
    });

  node
    .command('register')
    .description('Register (or re-attach) this machine as a worker node')
    .option('-n, --name <name>', 'Node name. Reattachment keys on it; defaults to the hostname')
    .option('-c, --concurrency <n>', 'How many jobs to run at once')
    .option('-t, --types <csv>', 'Comma-separated job types to claim (default: all node-eligible)')
    .option('--json', 'Emit the registered node as JSON on stdout')
    .action(async (options: RegisterCommandOptions) => {
      const stdout = ctx?.stdout ?? process.stdout;
      const stderr = ctx?.stderr ?? process.stderr;
      const configContext = contextOf(ctx);

      const resolved = resolveNodeConfig(configContext);

      // Flags win over both the file and the environment: a flag is the most
      // explicit thing a user can say, and it is the thing they will re-run.
      const node: NodeConfig = {
        name: options.name ?? resolved.node.name,
        concurrency:
          options.concurrency !== undefined
            ? parsePositiveInteger('--concurrency', options.concurrency)
            : resolved.node.concurrency,
        eligibleTypes:
          options.types !== undefined ? parseEligibleTypes(options.types) : resolved.node.eligibleTypes,
        pollIntervalMs: resolved.node.pollIntervalMs,
      };

      const api = HttpNodeApi.create(resolved.serverUrl, resolved.token, {
        ...(ctx?.fetch !== undefined ? { fetch: ctx.fetch } : {}),
      });

      const result = await registerNode({ api, node, configContext });

      if (options.json === true) {
        stdout.write(`${JSON.stringify({ ...result.node, reattached: result.reattached }, null, 2)}\n`);
        return;
      }

      stderr.write(
        `${result.reattached ? 'Reattached to' : 'Registered'} node "${result.node.name}" (${result.node.id}).\n` +
          `Concurrency ${result.node.concurrency}; types ${
            result.node.eligibleTypes.length > 0 ? result.node.eligibleTypes.join(', ') : '(all node-eligible)'
          }.\n`,
      );
    });

  node
    .command('start')
    .description('Run this machine as a worker until stopped')
    .option('-d, --daemon', 'Detach and run in the background')
    .option('--headless', 'Drain on SIGTERM WITHOUT deregistering — the container/service mode')
    .action(async (options: StartCommandOptions) => {
      const stderr = ctx?.stderr ?? process.stderr;
      const configContext = contextOf(ctx);

      // THE FIRST THING, before config load: the re-exec replaces this
      // process, so anything done before it is done twice — including any
      // error it would report. When it re-execs, this process becomes a
      // signal-forwarding shim and never returns from here.
      if (options.daemon !== true) {
        const tuned = maybeReexecWithHeapLimit({
          ...(ctx?.env !== undefined ? { env: ctx.env } : {}),
        });
        if (tuned.reexeced) return;
      }

      if (options.daemon === true) {
        // Re-spawn ourselves detached and return immediately. The child hosts
        // the same socket, so `status`, `logs` and `set-concurrency` behave
        // identically against a detached run and a foreground one.
        const args = ['node', 'start', ...(options.headless === true ? ['--headless'] : [])];
        const pid = spawnDetachedDaemon({ logPath: nodeLogPath(configContext), args });
        stderr.write(
          `Worker started in the background${pid === undefined ? '' : ` (pid ${pid})`}.\n` +
            `  ${CLI_NAME} node status\n  ${CLI_NAME} node logs --follow\n  ${CLI_NAME} node stop\n`,
        );
        return;
      }

      const started = await startNode({
        ...configContext,
        ...(options.headless === true ? { headless: true } : {}),
        stderr,
      });
      await started.finished;
    });

  node
    .command('stop')
    .description('Stop the worker running on this machine')
    .action(async () => {
      const stderr = ctx?.stderr ?? process.stderr;
      const configContext = contextOf(ctx);

      const outcome = await stopNode({
        socketPath: nodeSocketPath(configContext),
        pidPath: nodePidPath(configContext),
      });

      stderr.write(`${outcome.detail}\n`);
      if (!outcome.wasRunning && outcome.stoppedBy === undefined) {
        stderr.write(`${noDaemonHint(nodeSocketPath(configContext))}\n`);
      }
    });

  node
    .command('status')
    .description('Report what the worker on this machine is doing')
    .option('--json', 'Emit the snapshot as JSON on stdout')
    .action(async (options: { json?: boolean }) => {
      const stdout = ctx?.stdout ?? process.stdout;
      const stderr = ctx?.stderr ?? process.stderr;
      const configContext = contextOf(ctx);

      const status = await readLiveStatus({
        socketPath: nodeSocketPath(configContext),
        pidPath: nodePidPath(configContext),
      });

      if (status.live && status.snapshot !== undefined) {
        if (options.json === true) {
          stdout.write(`${JSON.stringify(status.snapshot, null, 2)}\n`);
          return;
        }
        const snapshot = status.snapshot;
        stderr.write(
          [
            `Node        ${snapshot.nodeId}`,
            `Status      ${snapshot.status}`,
            `Concurrency ${snapshot.concurrency}`,
            `Types       ${snapshot.eligibleTypes.join(', ') || '(none)'}`,
            `Active      ${snapshot.activeJobs.length}`,
            `Totals      ${snapshot.counters.succeeded} ok, ${snapshot.counters.failed} failed, ` +
              `${snapshot.counters.rateLimited} rate-limited of ${snapshot.counters.claimed} claimed`,
            `Heartbeat   ${
              snapshot.heartbeatAgeMs === null ? 'never' : `${Math.round(snapshot.heartbeatAgeMs / 1000)}s ago`
            }`,
            ...snapshot.activeJobs.map((job) => `  · ${job.type} ${job.jobId} since ${job.startedAt}`),
          ].join('\n') + '\n',
        );
        return;
      }

      // NEVER SIMPLY UNAVAILABLE: fall back to what this machine is configured
      // to do, so the command answers something useful either way.
      const resolved = resolveNodeConfig(configContext);
      if (options.json === true) {
        stdout.write(
          `${JSON.stringify(
            {
              live: false,
              nodeId: resolved.nodeId ?? null,
              name: resolved.node.name,
              concurrency: resolved.node.concurrency,
              eligibleTypes: resolved.node.eligibleTypes,
            },
            null,
            2,
          )}\n`,
        );
        return;
      }

      stderr.write(
        `${noDaemonHint(nodeSocketPath(configContext))}\n\n` +
          `Configured as "${resolved.node.name}"${resolved.nodeId === undefined ? ' (not registered)' : ` (${resolved.nodeId})`}, ` +
          `concurrency ${resolved.node.concurrency}.\n`,
      );
    });

  node
    .command('logs')
    .description('Show this worker’s log')
    .option('-n, --lines <n>', 'How many lines to show', '50')
    .option('-f, --follow', 'Stream new lines until interrupted')
    .action(async (options: { lines?: string; follow?: boolean }) => {
      const stdout = ctx?.stdout ?? process.stdout;
      const stderr = ctx?.stderr ?? process.stderr;
      const configContext = contextOf(ctx);
      const limit = parsePositiveInteger('--lines', options.lines ?? '50');

      for (const record of readLogTail(nodeLogPath(configContext), limit)) {
        stdout.write(`${formatLogRecord(record)}\n`);
      }

      if (options.follow !== true) return;

      // Following ATTACHES to the daemon rather than tailing the file: the
      // daemon already pushes every line, so this needs no polling and shows
      // events the file does not carry.
      await new Promise<void>((resolve) => {
        connectToDaemon({
          socketPath: nodeSocketPath(configContext),
          onMessage: (message) => {
            if (message.type === 'log-tail') {
              for (const record of message.lines) stdout.write(`${formatLogRecord(record)}\n`);
            }
          },
          onClose: () => resolve(),
        })
          .then((client) => {
            // Ctrl-C detaches cleanly and leaves the daemon untouched.
            const finish = (): void => {
              client.close();
              resolve();
            };
            process.once('SIGINT', finish);
            process.once('SIGTERM', finish);
          })
          .catch(() => {
            stderr.write(`${noDaemonHint(nodeSocketPath(configContext))}\n`);
            resolve();
          });
      });
    });

  node
    .command('set-concurrency')
    .argument('<n>', 'How many jobs to run at once (1–64)')
    .description('Change how many jobs this worker runs at once, live if it is running')
    .action(async (raw: string) => {
      const stderr = ctx?.stderr ?? process.stderr;
      const configContext = contextOf(ctx);
      const value = parsePositiveInteger('<n>', raw);

      const outcome = await applyConcurrency({
        value,
        socketPath: nodeSocketPath(configContext),
        persist: (next) => {
          saveNodeConfig({ node: { concurrency: next } }, { ...configContext, degradeOnFailure: true });
        },
      });

      stderr.write(
        outcome.applied
          ? `Concurrency set to ${outcome.value} on the running worker, and saved for next start.\n`
          : `No worker is running here; saved concurrency ${outcome.value} for the next start.\n`,
      );
    });

  node
    .command('doctor')
    .description('Check this machine, the server, and the worker — independently')
    .option('--json', 'Emit the report as JSON on stdout')
    // A FLAG, NOT A STORED SETTING (#352). A worker node holds no database
    // configuration of its own — the connection arrives per job and is dropped
    // when the job settles — so the reachability probe takes its target from
    // the operator asking the question, and is skipped when nobody asks.
    .option(
      '--db-host <host[:port]>',
      'Also test a TCP route to this PostgreSQL server, for db.backup.run offload',
    )
    .action(async (options: { json?: boolean; dbHost?: string }) => {
      const stdout = ctx?.stdout ?? process.stdout;
      const stderr = ctx?.stderr ?? process.stderr;
      const configContext = contextOf(ctx);

      // The config itself can fail to resolve — that IS a diagnosis, and
      // doctor is the command that should report it rather than throw it.
      let config;
      try {
        config = resolveNodeConfig(configContext);
      } catch (error) {
        stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        throw error;
      }

      const report = await runDoctor({
        config,
        socketPath: nodeSocketPath(configContext),
        pidPath: nodePidPath(configContext),
        stateDir: nodeStateDir(configContext),
        api: HttpNodeApi.create(config.serverUrl, config.token, {
          ...(ctx?.fetch !== undefined ? { fetch: ctx.fetch } : {}),
        }),
        ...(options.dbHost !== undefined ? { databaseHost: options.dbHost } : {}),
      });

      if (options.json === true) {
        stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      } else {
        stderr.write(formatDoctorReport(report));
      }

      if (!report.ok) throw new PreconditionError('At least one worker check failed.');
    });

  node
    .command('install-deps')
    .description('Install the dependencies this worker’s job types need')
    .option('--dry-run', 'Print the plan without changing anything')
    .action((options: { dryRun?: boolean }) => {
      const stderr = ctx?.stderr ?? process.stderr;
      const configContext = contextOf(ctx);

      const report = runInstallDeps({
        stateDir: nodeStateDir(configContext),
        ...(options.dryRun === true ? { dryRun: true } : {}),
        log: (message) => stderr.write(`${message}\n`),
      });

      stderr.write(formatInstallReport(report));
      if (!report.ok) throw new PreconditionError('At least one dependency step failed.');
    });

  const service = node.command('service').description('Manage the worker as a systemd user service');

  service
    .command('install')
    .description('Install and start a systemd user unit for this worker')
    .action(() => {
      const stderr = ctx?.stderr ?? process.stderr;
      const result = installService(contextOf(ctx));
      stderr.write(`${result.detail}\n`);
      if (result.guidance !== undefined) stderr.write(`${result.guidance}\n`);
    });

  service
    .command('uninstall')
    .description('Stop and remove the systemd user unit')
    .action(() => {
      const stderr = ctx?.stderr ?? process.stderr;
      const result = uninstallService(contextOf(ctx));
      stderr.write(`${result.detail}\n`);
      if (result.guidance !== undefined) stderr.write(`${result.guidance}\n`);
    });

  service
    .command('status')
    .description('Report the real state of the systemd user unit')
    .action(() => {
      const stderr = ctx?.stderr ?? process.stderr;
      const status = serviceStatus(contextOf(ctx));
      stderr.write(`${status.detail}\n  unit: ${status.unitPath}\n`);
    });

  node
    .command('heap-snapshot')
    .description('Ask the running worker to write a heap snapshot')
    .action(async () => {
      const stderr = ctx?.stderr ?? process.stderr;
      const configContext = contextOf(ctx);
      const socketPath = nodeSocketPath(configContext);

      // Deliberately asks the LIVE daemon rather than snapshotting a fresh
      // process: restarting to attach a diagnostic flag discards exactly the
      // accumulated state that names the retainer.
      const result = await new Promise<{ ok: boolean; detail: string }>((resolve) => {
        connectToDaemon({
          socketPath,
          onMessage: (message) => {
            if (message.type === 'ack' && message.command === 'heap-snapshot') {
              const detail = message.detail as { path?: string; size?: number } | undefined;
              resolve({
                ok: true,
                detail: `Wrote ${detail?.path ?? '(unknown path)'} (${Math.round((detail?.size ?? 0) / 1024 / 1024)} MB).`,
              });
            } else if (message.type === 'error') {
              resolve({ ok: false, detail: message.message });
            }
          },
        })
          .then((client) => client.send({ type: 'heap-snapshot' }))
          .catch(() => resolve({ ok: false, detail: noDaemonHint(socketPath) }));
      });

      stderr.write(`${result.detail}\n`);
      if (!result.ok) throw new PreconditionError('No heap snapshot was written.');
    });

  return node;
}

interface StartCommandOptions {
  daemon?: boolean;
  headless?: boolean;
}

interface EnrollCommandOptions {
  server?: string;
  name?: string;
  expiresInDays?: string;
  browser?: boolean;
  showToken?: boolean;
}

interface RegisterCommandOptions {
  name?: string;
  concurrency?: string;
  types?: string;
  json?: boolean;
}

/** Commander hands every option through as a string. Reject a non-number here. */
function parsePositiveInteger(flag: string, raw: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new UsageError(`${flag} must be a whole number of at least 1 (got ${JSON.stringify(raw)}).`);
  }
  return value;
}

/** Narrow the command context to the config seam, dropping undefined keys. */
function contextOf(ctx: NodeCommandContext | undefined): { env?: NodeJS.ProcessEnv; home?: string } {
  return {
    ...(ctx?.env !== undefined ? { env: ctx.env } : {}),
    ...(ctx?.home !== undefined ? { home: ctx.home } : {}),
  };
}
