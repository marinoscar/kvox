import type { CheckContext } from './types.js';

/** What a probe learned. `ok` is the exit status; the text is trimmed. */
export interface ProbeOutcome {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/**
 * Runs a command purely to see whether it works. Never throws.
 *
 * Shared by every check module: a check's contract (types.ts, rule 1) is that
 * it never throws, and the executor's contract is that a non-zero exit DOES
 * throw - this is the one place the two are reconciled, so no check has to
 * remember to catch.
 */
export async function probe(
  context: CheckContext,
  argv: readonly string[],
  timeoutMs = 20_000,
): Promise<ProbeOutcome> {
  try {
    const result = await context.runCommand(argv, {
      cwd: process.cwd(),
      timeoutMs,
    });
    return { ok: true, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
  } catch (error) {
    const failure = error as { result?: { stdout?: string; stderr?: string } };
    return {
      ok: false,
      stdout: (failure.result?.stdout ?? '').trim(),
      stderr:
        (failure.result?.stderr ?? '').trim() ||
        (error instanceof Error ? error.message : String(error)),
    };
  }
}
