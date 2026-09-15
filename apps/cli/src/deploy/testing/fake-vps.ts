import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import type { PromptContext } from '../../prompt.js';
import { CommandFailedError, type CommandResult, type RunCommandOptions } from '../executor.js';

// =============================================================================
// A fake VPS for driving the install and update pipelines end to end
// =============================================================================
// (issue #120, epic #118)
//
// `executor.ts` is the only place a deploy subprocess is spawned, and every
// pipeline takes `runCommand` as an option - so a whole install can be run
// against a canned command table plus a real temp directory, and the tests
// then assert on what was WRITTEN (the .env, its link, the state, deploy-info)
// rather than on which commands were called. Nothing here is a mock of the
// pipeline itself.
//
// Three things are real: the filesystem under the deploy root, a TCP
// listener standing in for PostgreSQL (the `database-reachable` check
// connects to it), and the clock.
// =============================================================================

/** The default deployed API version, as `apps/api/package.json` in the clone. */
export const FAKE_APP_VERSION = '1.2.3';

export const FAKE_DF =
  'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 78125000 10000000 68000000 13% /\n';

/**
 * A template small enough that the non-interactive wizard can be satisfied
 * from a handful of answers. It is what `git clone` leaves at
 * `repo/infra/compose/.env.example`.
 */
export const FAKE_ENV_EXAMPLE = [
  `# ${'-'.repeat(77)}`,
  '# Database',
  `# ${'-'.repeat(77)}`,
  'POSTGRES_HOST=localhost',
  'POSTGRES_PORT=5432',
  'POSTGRES_USER=postgres',
  'POSTGRES_PASSWORD=postgres',
  'POSTGRES_DB=appdb',
  'POSTGRES_SSL=false',
  '',
  `# ${'-'.repeat(77)}`,
  '# Application',
  `# ${'-'.repeat(77)}`,
  'APP_BIND_PORT=3535',
  'INITIAL_ADMIN_EMAIL=admin@example.com',
  '',
].join('\n');

export interface FakeVpsOptions {
  /** What `origin/<ref>` resolves to. */
  remoteSha?: string | undefined;
  /** What `rev-parse HEAD` answers before any checkout; for an installed clone. */
  head?: string | undefined;
  appVersion?: string | undefined;
  /** What `git log <a>..<b>` lists between two DIFFERENT revisions, newest first. */
  commits?: readonly { sha: string; subject: string }[] | undefined;
}

/** The commits between any two different revisions, unless a test says otherwise. */
export const FAKE_COMMITS: readonly { sha: string; subject: string }[] = [
  { sha: 'b2b2b2b', subject: 'feat(api): the second thing' },
  { sha: 'b1b1b1b', subject: 'fix(web): the first thing' },
];

export interface FakeVps {
  runCommand: typeof import('../executor.js').runCommand;
  /** Every argv seen, in order. */
  seen: string[][];
  /** The clone's HEAD, moved by `git checkout`. */
  head: string | undefined;
  remoteSha: string;
  /** The port the fake PostgreSQL listener holds on 127.0.0.1. */
  dbPort: number;
  /** Makes every command the predicate matches fail from now on. */
  failWhen(predicate: (argv: readonly string[]) => boolean, stderr?: string): void;
  /** Wizard answers that satisfy FAKE_ENV_EXAMPLE against this VPS. */
  answers(): Map<string, string>;
  close(): Promise<void>;
}

/** Writes what a clone of this template would contain, at `path`. */
export function populateClone(path: string, appVersion = FAKE_APP_VERSION): void {
  mkdirSync(join(path, '.git'), { recursive: true });
  mkdirSync(join(path, 'infra', 'compose'), { recursive: true });
  mkdirSync(join(path, 'apps', 'api'), { recursive: true });
  writeFileSync(join(path, 'infra', 'compose', '.env.example'), FAKE_ENV_EXAMPLE);
  writeFileSync(join(path, 'apps', 'api', 'package.json'), JSON.stringify({ version: appVersion }));
}

export async function fakeVps(options: FakeVpsOptions = {}): Promise<FakeVps> {
  const listener: Server = createServer((socket) => socket.end());
  await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const address = listener.address();
  const dbPort = typeof address === 'object' && address !== null ? address.port : 0;

  const remoteSha = options.remoteSha ?? 'b'.repeat(40);
  const failures: { predicate: (argv: readonly string[]) => boolean; stderr: string }[] = [];

  const vps: FakeVps = {
    seen: [],
    head: options.head,
    remoteSha,
    dbPort,
    failWhen(predicate, stderr = 'boom') {
      failures.push({ predicate, stderr });
    },
    answers() {
      return new Map([
        ['POSTGRES_HOST', '127.0.0.1'],
        ['POSTGRES_PORT', String(dbPort)],
        ['POSTGRES_USER', 'app'],
        ['POSTGRES_PASSWORD', 'not-the-default-password'],
        ['POSTGRES_DB', 'appdb'],
        ['INITIAL_ADMIN_EMAIL', 'admin@ops.test'],
      ]);
    },
    close: () => new Promise<void>((resolve) => listener.close(() => resolve())),
    runCommand: (async (argv: readonly string[], runOptions: RunCommandOptions): Promise<CommandResult> => {
      vps.seen.push([...argv]);
      const joined = argv.join(' ');

      const result = (stdout = ''): CommandResult => ({
        argv: [...argv],
        cwd: runOptions.cwd,
        exitCode: 0,
        stdout,
        stderr: '',
        durationMs: 1,
        timedOut: false,
      });

      const failure = failures.find((entry) => entry.predicate(argv));
      if (failure !== undefined) {
        const failed = { ...result(), exitCode: 1, stderr: failure.stderr };
        throw new CommandFailedError(failure.stderr, failed);
      }

      if (argv[0] === 'git') {
        if (argv[1] === 'clone') {
          populateClone(argv[argv.length - 1] as string, options.appVersion);
          return result();
        }
        if (argv[1] === 'checkout') {
          vps.head = argv[argv.length - 1];
          return result();
        }
        if (argv[1] === 'rev-parse' && argv[2] === '--verify') {
          // Read off `vps` rather than the closure, so a test can move the
          // remote between calls.
          return (argv[4] as string).startsWith('refs/remotes/origin/')
            ? result(`${vps.remoteSha}\n`)
            : { ...result(), exitCode: 1 };
        }
        if (argv[1] === 'rev-parse' && argv[2] === 'HEAD') {
          return result(`${vps.head ?? ''}\n`);
        }
        // `rev-list --count a..b` and `log … a..b`: the range is the last
        // argument, and two equal ends mean nothing in between.
        const range = (argv[argv.length - 1] as string).split('..');
        const same = range.length === 2 && range[0] === range[1];
        const commits = options.commits ?? FAKE_COMMITS;
        if (argv[1] === 'rev-list' && argv[2] === '--count') {
          return result(`${same ? 0 : commits.length}\n`);
        }
        if (argv[1] === 'log') {
          return result(same ? '' : commits.map((commit) => `${commit.sha}\t${commit.subject}\n`).join(''));
        }
        return result();
      }

      if (joined === 'docker --version') return result('Docker version 27.3.1, build 1234abc\n');
      if (joined === 'docker compose version --short') return result('v2.29.7\n');
      if (argv[0] === 'df') return result(FAKE_DF);

      if (argv[0] === 'docker' && argv[1] === 'run') {
        // The one-off psql container behind the database checks.
        return result('t\n');
      }

      if (argv[0] === 'docker' && argv[1] === 'compose') {
        if (joined.includes(' ps ')) return result('[]\n');
        if (joined.includes('prisma migrate status')) {
          return result('3 migrations found in prisma/migrations\n\nDatabase schema is up to date!\n');
        }
        return result();
      }

      return result();
    }) as typeof import('../executor.js').runCommand,
  };

  return vps;
}

/** A `fetch` that answers 200 to every health probe. */
export function healthyFetch(): typeof globalThis.fetch {
  return (async () => ({ status: 200 }) as Response) as typeof globalThis.fetch;
}

/** A prompt context whose output goes nowhere, so the wizard's summary stays out of the test log. */
export function silentPrompt(): PromptContext {
  return { output: new PassThrough() as unknown as NodeJS.WriteStream };
}
