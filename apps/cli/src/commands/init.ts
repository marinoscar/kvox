import type { Command } from 'commander';

import { CLI_NAME } from '../branding.js';
import { runInit } from '../init/run-init.js';
import type { PromptContext } from '../prompt.js';

// =============================================================================
// `appctl init`  (issue #344, epic #341)
// =============================================================================
//
// The command that runs BEFORE there is anything to log in to: it turns a
// fresh clone into a checkout that can be started. Everything it does lives in
// `init/run-init.ts` (and the local profile beside it) so that this file stays
// what every other command file here is - flags, help, and one call - and so
// the behaviour can be exercised without commander in the way.
//
// It follows the group's two standing rules from program.ts: human output goes
// to STDERR, and a refusal exits NON-ZERO. Refusing to overwrite an existing
// .env is a refusal, not a no-op success - `appctl init && docker compose up`
// must not proceed as though a file had been written.
// =============================================================================

export interface InitCommandOptions {
  force?: boolean | undefined;
  nonInteractive?: boolean | undefined;
  adminEmail?: string | undefined;
  repoRoot?: string | undefined;
  all?: boolean | undefined;
}

export interface InitContext {
  cwd?: string | undefined;
  stderr?: { write(chunk: string): unknown } | undefined;
  promptContext?: PromptContext | undefined;
}

export function registerInitCommand(program: Command, ctx?: InitContext): Command {
  return program
    .command('init')
    .description('Create infra/compose/.env so this checkout can be started')
    .option('--force', 'Update an existing .env in place, keeping the values already in it')
    .option(
      '--non-interactive',
      'Never prompt: generate the secrets, take every default, leave OAuth blank',
    )
    .option('--admin-email <email>', 'Set INITIAL_ADMIN_EMAIL without being asked for it')
    .option('--all', 'Review every variable, not only the ones that must be answered')
    .option('--repo-root <path>', "Repository root (default: this directory or a parent)")
    .addHelpText(
      'after',
      [
        '',
        'Examples:',
        `  ${CLI_NAME} init`,
        `  ${CLI_NAME} init --admin-email you@example.com`,
        `  ${CLI_NAME} init --non-interactive`,
        `  ${CLI_NAME} init --force`,
        '',
        'What it writes:',
        '  infra/compose/.env, at mode 0600, and nothing else. The questions and',
        '  the defaults come from infra/compose/.env.example, which is never',
        '  modified. JWT_SECRET, COOKIE_SECRET and SECRETS_ENCRYPTION_KEY are',
        '  generated with the CSPRNG and never asked for.',
        '',
        'Google OAuth is REQUIRED. The API does not start without',
        'GOOGLE_CLIENT_ID; it is the only way to log in.',
        '',
        'Exit codes:',
        '  0  the file was written',
        '  2  a .env already exists (re-run with --force), or a value is missing',
        '     that an unattended run cannot supply',
        '  6  this is not a checkout of the repository, or the template is gone',
      ].join('\n'),
    )
    .action(async (options: InitCommandOptions) => {
      await runInit({
        ...(ctx?.cwd === undefined ? {} : { cwd: ctx.cwd }),
        ...(ctx?.stderr === undefined ? {} : { stderr: ctx.stderr }),
        ...(ctx?.promptContext === undefined ? {} : { promptContext: ctx.promptContext }),
        ...(options.force === undefined ? {} : { force: options.force }),
        ...(options.nonInteractive === undefined
          ? {}
          : { nonInteractive: options.nonInteractive }),
        ...(options.adminEmail === undefined ? {} : { adminEmail: options.adminEmail }),
        ...(options.repoRoot === undefined ? {} : { repoRoot: options.repoRoot }),
        ...(options.all === undefined ? {} : { all: options.all }),
      });
    });
}
