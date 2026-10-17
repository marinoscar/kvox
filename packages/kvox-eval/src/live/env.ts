// =============================================================================
// Where a live evaluation's API key comes from (issue #580)
// =============================================================================
//
// ONE environment variable, `KVOX_EVAL_OPENAI_API_KEY`, for every live run (kg
// and Ask). The two names it replaces, `KG_EVAL_OPENAI_API_KEY` (#475) and
// `ASK_EVAL_OPENAI_API_KEY` (#382), are still read for one release, with a
// one-line deprecation note naming the variable — never its value.
//
// ⚠ The key is never a flag, never printed, never written into a report, a
// prediction or an error message. An empty variable counts as unset.
// =============================================================================

/**
 * The environment variable a live run reads its API key from — never a flag.
 *
 * @stability experimental
 */
export const KVOX_EVAL_API_KEY_ENV = 'KVOX_EVAL_OPENAI_API_KEY';

/**
 * The former names of {@link KVOX_EVAL_API_KEY_ENV}, read for one release with a
 * deprecation note.
 *
 * @stability deprecated
 */
export const DEPRECATED_EVAL_API_KEY_ENVS: readonly string[] = Object.freeze(['KG_EVAL_OPENAI_API_KEY', 'ASK_EVAL_OPENAI_API_KEY']);

/**
 * Where a key was found.
 *
 * @stability experimental
 */
export interface EvalApiKey {
  /** The key. ⚠ Secret: hand it to the runtime, never print it. */
  apiKey: string;
  /** The variable it was read from (safe to print). */
  source: string;
}

/**
 * The live run's API key from the environment, or `null` when none is set.
 *
 * @example
 * ```ts
 * const key = readEvalApiKey(process.env, (line) => process.stderr.write(`${line}\n`));
 * if (key === null) throw new Error(`set ${KVOX_EVAL_API_KEY_ENV}`);
 * ```
 *
 * @param env - the environment to read (`process.env`, or a test's own).
 * @param warn - receives the one-line deprecation note when an old name supplied the key.
 * @returns the key and the variable it came from, or `null`.
 * @stability experimental
 */
export function readEvalApiKey(env: Readonly<Record<string, string | undefined>>, warn?: (line: string) => void): EvalApiKey | null {
  const primary = env[KVOX_EVAL_API_KEY_ENV];
  if (primary) return { apiKey: primary, source: KVOX_EVAL_API_KEY_ENV };
  for (const name of DEPRECATED_EVAL_API_KEY_ENVS) {
    const value = env[name];
    if (value) {
      warn?.(`kvox-eval: ${name} is deprecated and will stop being read in the next release; set ${KVOX_EVAL_API_KEY_ENV} instead`);
      return { apiKey: value, source: name };
    }
  }
  return null;
}
