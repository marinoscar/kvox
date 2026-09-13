// =============================================================================
// DeployHooks - the seam between the work and the two things that render it
// =============================================================================
// (issue #173, epic #168)
//
// This is `DeviceLoginHooks` applied to deployment, and the reasoning is
// identical (see device-login.ts): two consumers, one sequence. `appctl deploy
// install` renders these callbacks as lines on stderr; the ink screen in #184
// renders the same callbacks as React state.
//
// THE SPLIT IS DRAWN AT I/O. Nothing in src/deploy/ writes to a terminal.
// Everything a user would see is delivered through this interface, so the two
// interfaces cannot drift: there is no second implementation to drift from.
//
// Every member is optional. A caller that wants none of it - a test, or a
// programmatic use - passes nothing and the pipeline is silent.
// =============================================================================

export type StepOutcome = 'ok' | 'skipped' | 'failed';

export interface StepResult {
  id: string;
  title: string;
  outcome: StepOutcome;
  durationMs: number;
  /** Why it was skipped, or what failed. */
  detail?: string | undefined;
}

export interface DeployHooks {
  /** A step is starting. Fires once per step, in pipeline order. */
  onStepStart?: ((step: { id: string; title: string; index: number; total: number }) => void) | undefined;
  /** A step finished, however it finished. */
  onStepResult?: ((result: StepResult) => void) | undefined;
  /**
   * A line of output from whatever the step is running.
   *
   * ALREADY ANSI-FREE - `runCommand` strips it - because the TUI renders these
   * through `ScrollBox`, which requires plain text.
   */
  onLog?: ((line: string) => void) | undefined;
  /**
   * A long wait is making progress: polling health, waiting on a certificate.
   *
   * Separate from `onLog` so the TUI can render it as a line that CHANGES IN
   * PLACE rather than appending forever - the same distinction `login.tsx`
   * draws for its polling countdown.
   */
  onProgress?: ((message: string) => void) | undefined;
}
