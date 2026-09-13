import type { DeployHooks, StepResult } from '../hooks.js';
import type { Journal } from '../journal.js';

// =============================================================================
// A deploy pipeline is DATA, not a long function  (issue #180, epic #168)
// =============================================================================
//
// Modelling the sequence as a list is what lets four different things read the
// same sequence instead of each modelling it separately: the --skip-* flags,
// --resume, `status`, and the TUI's progress view. A single imperative
// function would force every one of those to re-derive what the steps are.
// =============================================================================

export interface StepContext {
  journal: Journal;
  hooks: DeployHooks | undefined;
  /** Ids already completed, from the state file, for --resume. */
  completed: ReadonlySet<string>;
}

export interface DeployStep<C> {
  id: string;
  title: string;
  /** Skipped, with this reason, when it returns a string. */
  skip?: ((context: C) => string | undefined) | undefined;
  run(context: C): Promise<void>;
}

export interface PipelineResult {
  steps: StepResult[];
  completed: string[];
  failed?: StepResult | undefined;
}

/**
 * Runs the pipeline, reporting through hooks and stopping at the first failure.
 *
 * Every step reports through `DeployHooks` and NONE of them writes to a
 * terminal. That is what makes #184's ink screen a second renderer rather than
 * a second implementation.
 */
export async function runPipeline<C extends StepContext>(
  steps: readonly DeployStep<C>[],
  context: C,
): Promise<PipelineResult> {
  const results: StepResult[] = [];
  const completed: string[] = [];

  for (const [index, step] of steps.entries()) {
    const startedAt = Date.now();

    const alreadyDone = context.completed.has(step.id);
    const skipReason = alreadyDone
      ? 'already completed (resumed)'
      : step.skip?.(context);

    if (skipReason !== undefined) {
      const result: StepResult = {
        id: step.id,
        title: step.title,
        outcome: 'skipped',
        durationMs: 0,
        detail: skipReason,
      };
      results.push(result);
      if (alreadyDone) completed.push(step.id);
      context.journal.line(`- ${step.title}: ${skipReason}`);
      context.hooks?.onStepResult?.(result);
      continue;
    }

    context.journal.step(step.id, step.title);
    context.hooks?.onStepStart?.({
      id: step.id,
      title: step.title,
      index,
      total: steps.length,
    });

    try {
      await step.run(context);
    } catch (error) {
      const failed: StepResult = {
        id: step.id,
        title: step.title,
        outcome: 'failed',
        durationMs: Date.now() - startedAt,
        detail: error instanceof Error ? error.message : String(error),
      };
      results.push(failed);
      context.hooks?.onStepResult?.(failed);
      // Stop here. Continuing past a failed step is how a deployment ends up
      // half-applied and harder to reason about than one that stopped.
      return { steps: results, completed, failed };
    }

    const result: StepResult = {
      id: step.id,
      title: step.title,
      outcome: 'ok',
      durationMs: Date.now() - startedAt,
    };
    results.push(result);
    completed.push(step.id);
    context.hooks?.onStepResult?.(result);
  }

  return { steps: results, completed };
}
