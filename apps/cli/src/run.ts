import { createCli, EXIT, exitCodeFor, formatError } from '@marinoscar/platform-cli';
import { CLI_NAME } from '@app/shared';

import { APP_CLI_OPTIONS } from './app.js';
import { reconcileForArgv } from './extensions/compose-project.js';
import { DeploymentResolutionError, resolveDeployment } from './extensions/deployment.js';
import { translateLegacyArgs } from './extensions/legacy-flags.js';
import { checkForUpdate, renderUpdateCheck, type GitRunner } from './extensions/update-check.js';

// =============================================================================
// One invocation of the CLI  (issue #482, epic #478)
// =============================================================================
//
// `cli.ts` is the entry point and must stay import-light; the work of one
// invocation lives here so it can be tested without a process exiting under the
// test runner. It does four things around the platform CLI:
//
//   1. translates the pre-platform `deploy` flags (extensions/legacy-flags.ts),
//   2. answers `deploy update --check` itself (extensions/update-check.ts),
//   3. records the compose project a legacy deployment really runs under
//      (extensions/compose-project.ts, #736), and
//   4. otherwise hands the (translated) arguments to `createCli(...).run`.
//
// It returns the exit code and never calls `process.exit()`: that would end the
// process before a pipe's pending writes drained.
// =============================================================================

/**
 * `formatError`, which needs the CLI identity the platform sets while building
 * the CLI; a build that failed before that point (an invalid identity) must
 * still print its reason rather than a second error about the missing identity.
 */
export function describeError(error: unknown): string {
  try {
    return formatError(error);
  } catch {
    return error instanceof Error ? `${CLI_NAME}: ${error.message}` : `${CLI_NAME}: ${String(error)}`;
  }
}

/** Where one invocation writes and what it runs against; the defaults are the process's. */
export interface RunAppOptions {
  stdout?: { write(text: string): unknown } | undefined;
  stderr?: { write(text: string): unknown } | undefined;
  cwd?: string | undefined;
  now?: (() => Date) | undefined;
  /** The git seam of `update --check`. */
  runGit?: GitRunner | undefined;
  /** Builds the CLI; tests substitute a fake to observe what it is handed. */
  createCli?: typeof createCli | undefined;
}

/**
 * Runs the CLI once.
 *
 * @param argv - The arguments after the executable name.
 * @param options - Streams and seams; omit all of them to run for real.
 * @returns the exit code.
 */
export async function runApp(argv: string[], options: RunAppOptions = {}): Promise<number> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const cwd = options.cwd ?? process.cwd();

  const plan = translateLegacyArgs(argv, { cli: CLI_NAME, cwd, now: options.now });

  if (plan.kind === 'refuse') {
    stderr.write(`${plan.message}\n`);
    return EXIT.USAGE;
  }

  for (const note of plan.notes) stderr.write(`${note}\n`);

  if (plan.kind === 'update-check') {
    try {
      const deployment = resolveDeployment({ ...plan.selector, cwd });
      const check = await checkForUpdate({
        deployRoot: deployment.deployRoot,
        ref: plan.ref,
        runGit: options.runGit,
        now: options.now,
      });
      stdout.write(plan.json ? `${JSON.stringify(check, null, 2)}\n` : `${renderUpdateCheck(check).join('\n')}\n`);
      return EXIT.OK;
    } catch (error) {
      stderr.write(`${CLI_NAME}: ${(error as Error).message}\n`);
      return error instanceof DeploymentResolutionError ? EXIT.USAGE : EXIT.FAILURE;
    }
  }

  let cli: ReturnType<typeof createCli>;
  try {
    cli = (options.createCli ?? createCli)(APP_CLI_OPTIONS);
  } catch (error) {
    stderr.write(`${describeError(error)}\n`);
    return exitCodeFor(error);
  }

  for (const step of plan.before) {
    try {
      const line = step();
      if (line !== undefined) stderr.write(`${line}\n`);
    } catch (error) {
      stderr.write(`${CLI_NAME}: ${(error as Error).message}\n`);
      return EXIT.FAILURE;
    }
  }

  // After the legacy steps and before the platform reads the record (#736); it never fails the command.
  const reconciled = await reconcileForArgv(plan.argv, cwd);
  if (reconciled !== undefined) stderr.write(`${reconciled}\n`);

  return cli.run(plan.argv);
}
