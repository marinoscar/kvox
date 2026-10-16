/**
 * Where the `kvox-db` command writes: two functions, one per stream.
 *
 * @stability experimental
 */
export interface KvoxDbIo {
  /** Writes text to standard output. */
  out(text: string): void;
  /** Writes text to standard error. */
  err(text: string): void;
}

/**
 * The commands `kvox-db` runs. Empty until issue 5.3 adds `sync` and `check`.
 *
 * @stability experimental
 */
export const KVOX_DB_COMMANDS: readonly string[] = [];

/**
 * The usage text of the `kvox-db` command.
 *
 * @returns The text `kvox-db --help` prints, ending with a newline.
 * @stability experimental
 */
export function kvoxDbUsage(): string {
  return [
    'Usage: kvox-db <command>',
    '',
    'Installs the KVox domain schema fragments and migrations into an app, and',
    'checks that the installed copies match the package.',
    '',
    'Commands: none yet. `sync` and `check` arrive with the schema move (issue 5.3).',
    '',
    'Options:',
    '  -h, --help  Print this text.',
    '',
  ].join('\n');
}

/**
 * Runs the `kvox-db` command.
 *
 * @param argv - The arguments after the command name.
 * @param io - Where to write.
 * @returns The process exit code: 0 for `--help` or no arguments, 2 for an
 * unknown command.
 * @stability experimental
 */
export function runKvoxDb(argv: readonly string[], io: KvoxDbIo): number {
  const [command] = argv;
  if (command === undefined || command === '-h' || command === '--help') {
    io.out(kvoxDbUsage());
    return 0;
  }
  io.err(`kvox-db: unknown command '${command}'\n\n${kvoxDbUsage()}`);
  return 2;
}
