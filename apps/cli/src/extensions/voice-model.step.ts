import { CLI_NAME } from '@app/shared';
import type { DeployStepContext, DeployStepRegistration } from '@marinoscar/platform-cli/deploy';

import {
  VOICEPRINT_MODEL_SCRIPT,
  execInContainer,
  findApiContainer,
  lastJsonLine,
  type DockerRun,
  type DockerRunResult,
} from './api-container.js';
import { VOICEPRINT_REQUIRED_HOSTS } from './voiceprint-egress.js';

// =============================================================================
// Pre-installing the speaker voice model on deploy  (issue #831)
// =============================================================================
//
// Speaker voiceprints (issue #825) need a ~30 MB model. The API installs it on first
// use inside a queue job, which means a host with no route to github.com finds out
// when the first voice job fails and retries, long after the deploy said "healthy".
// This step moves the discovery (and the download) to deploy time: right after the
// health check, in BOTH pipelines, it runs `scripts/voiceprint-model.js ensure`
// inside the running api container. The model lands in the volume
// `app.prod.voiceprint-models.compose.yml` mounts, so it survives the next update.
//
// NEVER FATAL. Voice matching is an optional feature and the API installs the model
// itself when a voice job first needs it, so a failed download must not roll back a
// release that is otherwise healthy. A failure logs one clear warning with the
// remedy and returns normally. Output goes through `context.log` only, so `--json`
// and the progress view behave as for any step.
// =============================================================================

/** The step id (permanent: `--resume` records it). */
export const VOICE_MODEL_STEP_ID = 'voice-model';

/** The built-in step it follows in both pipelines. */
export const VOICE_MODEL_AFTER = 'health';

/** The whole download's budget: about 30 MB, but a slow link and two redirects. */
export const VOICE_MODEL_TIMEOUT_MS = 5 * 60 * 1000;

/** The remedy every failure names. */
export const VOICE_MODEL_REMEDY =
  `Allow egress to ${VOICEPRINT_REQUIRED_HOSTS}, then re-run "${CLI_NAME} deploy update --force"; ` +
  'otherwise the first voice job downloads the model itself.';

/** Adapts the step context's journaled `exec` to the docker seam; never throws. */
function dockerThroughContext(context: DeployStepContext): DockerRun {
  return async (args, timeoutMs): Promise<DockerRunResult> => {
    try {
      const result = await context.exec(['docker', ...args], { timeoutMs, allowExitCodes: [1, 2, 125, 126, 127] });
      return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, unavailable: false };
    } catch {
      return { exitCode: null, stdout: '', stderr: '', unavailable: true };
    }
  };
}

interface EnsureReport {
  status?: unknown;
  bytes?: unknown;
  dir?: unknown;
  code?: unknown;
  message?: unknown;
}

function warn(context: DeployStepContext, why: string): void {
  context.log(`WARNING: the speaker voice model was not installed: ${why}`);
  context.log(`  Remedy: ${VOICE_MODEL_REMEDY}`);
  context.log('  The release itself is unaffected.');
}

/**
 * The step body, with the docker seam injectable for the tests.
 *
 * @param context - the platform's step context.
 * @param run - docker; defaults to the journaled `context.exec`.
 */
export async function runVoiceModelStep(context: DeployStepContext, run: DockerRun = dockerThroughContext(context)): Promise<void> {
  try {
    const container = await findApiContainer({ deployRoot: context.deployRoot }, run);
    if (container.kind !== 'found') {
      context.log(`Voice model: skipped, ${container.reason}. The API installs it on first use.`);
      return;
    }

    context.progress('Installing the speaker voice model (one-time download, about 30 MB)');
    const result = await execInContainer(container.id, ['node', VOICEPRINT_MODEL_SCRIPT, 'ensure'], VOICE_MODEL_TIMEOUT_MS, run);
    if (result.unavailable) {
      warn(context, 'the model script could not be run in the api container (timed out or Docker was unavailable)');
      return;
    }

    const report = lastJsonLine(result.stdout) as EnsureReport | undefined;
    if (result.exitCode === 0 && report !== undefined && (report.status === 'installed' || report.status === 'already-installed')) {
      const megabytes = typeof report.bytes === 'number' ? ` (${(report.bytes / 1_000_000).toFixed(1)} MB)` : '';
      context.log(
        report.status === 'installed'
          ? `Voice model: downloaded and verified${megabytes}.`
          : `Voice model: already installed${megabytes}.`,
      );
      return;
    }

    const code = typeof report?.code === 'string' ? report.code : 'unknown';
    const message = typeof report?.message === 'string' ? `: ${report.message}` : '';
    warn(context, `the download failed (${code})${message}`);
  } catch (error) {
    warn(context, error instanceof Error ? error.message : 'an unexpected error');
  }
}

/** The registrations `createCli({ deploySteps })` takes: the same step after `health` in both pipelines. */
export const voiceModelSteps: DeployStepRegistration[] = (['install', 'update'] as const).map((pipeline) => ({
  pipeline,
  id: VOICE_MODEL_STEP_ID,
  after: VOICE_MODEL_AFTER,
  step: {
    title: 'Install the speaker voice model',
    run: (context: DeployStepContext) => runVoiceModelStep(context),
  },
}));
