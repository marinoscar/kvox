import type { Command } from 'commander';

import { CLI_NAME } from '../branding.js';
import {
  SERVER_URL_ENV_VAR,
  TOKEN_ENV_VAR,
  resolveConfig,
  type ConfigContext,
} from '../config.js';
import type { DeviceCodeGrant, DevicePollState } from '../device-auth.js';
import { completeLogin, runDeviceLogin, type CurrentUser } from '../device-login.js';
import { UsageError } from '../errors.js';
import { canPrompt, promptForServerUrl } from '../prompt.js';

// =============================================================================
// `appctl login`  (issues #142/#143, epic #110)
// =============================================================================
//
// DELIBERATELY THIN. Everything with logic in it — the RFC 8628 state machine,
// the browser launch, the validate-then-save step — lives in device-auth.ts,
// browser.ts and device-login.ts, because #145 renders the identical flow in
// ink and must not reimplement any of it. What is left here is argument
// resolution and turning hook callbacks into lines of text.
//
// ALL HUMAN OUTPUT GOES TO STDERR, including the success message. program.ts
// reserves stdout for command *data* so that #144's `--raw` pipes into `jq`
// unchanged, and `login` produces no data — it has a side effect. Writing the
// banner to stdout would mean `appctl login > /dev/null` silently hides the
// user code, which is the one thing the flow cannot work without.
//
// THE TOKEN IS NEVER PRINTED. Not on success, not in the summary, not in an
// error. It goes from the response body into the config file and nowhere else.
// The only token-shaped thing this file can emit is `tokenName`, which is a
// label the server chose.
// =============================================================================

interface LoginOptions {
  server?: string;
  token?: string;
  deviceName?: string;
  /** commander's `--no-browser` sets this to false; default true. */
  browser: boolean;
}

export function registerLoginCommand(program: Command, ctx?: ConfigContext): Command {
  return program
    .command('login')
    .description('Authorize this machine and store a token')
    .option('--server <url>', `Server URL (or set ${SERVER_URL_ENV_VAR})`)
    .option(
      '--token <pat>',
      'Skip the device flow and use an existing personal access token (headless)',
    )
    .option('--device-name <name>', 'Name shown for this machine in the Access Tokens page')
    .option('--no-browser', 'Do not try to open a browser; just print the URL')
    .addHelpText(
      'after',
      [
        '',
        'Examples:',
        `  ${CLI_NAME} login                                   Device flow, prompting for the server`,
        `  ${CLI_NAME} login --server https://app.example.com  Device flow, no prompt`,
        `  ${CLI_NAME} login --server https://app.example.com --token pat_...`,
        '',
        'In CI, skip this command entirely and set:',
        `  ${SERVER_URL_ENV_VAR} and ${TOKEN_ENV_VAR}`,
      ].join('\n'),
    )
    .action(async (options: LoginOptions) => {
      await runLogin(options, ctx);
    });
}

async function runLogin(options: LoginOptions, ctx?: ConfigContext): Promise<void> {
  const serverUrl = await resolveServerUrl(options.server, ctx);

  const result =
    options.token === undefined
      ? await deviceFlowLogin(serverUrl, options, ctx)
      : await headlessLogin(serverUrl, options.token, ctx);

  reportSuccess(result.user, result.path, serverUrl);
}

/**
 * Where the server URL comes from, in order.
 *
 * The environment beats the stored config (matching #143's precedence
 * everywhere else) but loses to `--server`, because an explicit flag is the
 * user telling us about *this* invocation and nothing should silently override
 * that.
 *
 * The stored URL is offered as the PROMPT DEFAULT rather than used outright:
 * re-running `login` against a different server is a normal thing to do, and
 * silently reusing the old one would produce a token for the wrong host with
 * no indication that a choice was made.
 */
async function resolveServerUrl(flag: string | undefined, ctx?: ConfigContext): Promise<string> {
  if (flag !== undefined && flag.trim().length > 0) return flag.trim();

  const resolved = resolveConfig(ctx);

  if (resolved.serverUrlSource === 'env' && resolved.serverUrl !== undefined) {
    return resolved.serverUrl;
  }

  if (!canPrompt()) {
    // The non-TTY case gets its own sentence rather than the prompt's generic
    // one, because the fix here is specific and worth stating: this is CI, and
    // CI should be setting both variables instead of running `login` at all.
    throw new UsageError(
      `No server URL. Pass --server <url>, or set ${SERVER_URL_ENV_VAR} (and ${TOKEN_ENV_VAR}) for non-interactive use.`,
    );
  }

  return promptForServerUrl(resolved.serverUrl);
}

/** The RFC 8628 path. */
async function deviceFlowLogin(
  serverUrl: string,
  options: LoginOptions,
  ctx?: ConfigContext,
): Promise<{ user: CurrentUser; path: string }> {
  const { credential } = await runDeviceLogin({
    serverUrl,
    deviceName: options.deviceName,
    openBrowser: options.browser,
    hooks: {
      onCodeIssued: printInstructions,
      onBrowserOpen: (result) => {
        write(
          result.opened
            ? '  Opening your browser…\n'
            : '  Could not open a browser automatically — open the URL above yourself.\n',
        );
      },
      onPollState: printPollState,
      onUnclassified: (signal) => {
        // Surfaced rather than hidden: the CLI genuinely cannot tell the four
        // RFC outcomes apart against a server that does not send them, and a
        // user who denies the request and then watches the CLI wait deserves
        // to know why it is waiting. See UNCLASSIFIED_POLL_POLICY.
        write(
          `\n  Note: this server does not report device-authorization status in the standard\n` +
            `  format (it answered ${signal.status}: ${signal.message}). Waiting for approval\n` +
            `  anyway; a denial will look like the code expiring.\n`,
        );
      },
    },
  });

  write('\n  Approved. Verifying…\n');

  return completeLogin({
    serverUrl,
    token: credential.accessToken,
    expiresAt: credential.expiresAt,
    tokenId: credential.tokenId,
    tokenName: credential.tokenName,
    configContext: ctx,
  });
}

/**
 * The headless `--token` path (#143).
 *
 * Same validate-then-save shape as the device flow, on purpose: a bad token
 * must fail at `login`, where the user still has the thing they pasted in
 * front of them, rather than at the first real command.
 */
async function headlessLogin(
  serverUrl: string,
  token: string,
  ctx?: ConfigContext,
): Promise<{ user: CurrentUser; path: string }> {
  write(`  Checking the token against ${serverUrl}…\n`);

  const result = await completeLogin({ serverUrl, token, configContext: ctx });

  // A token on the command line is in the shell history and in the process
  // list of every other user on the machine. Worth one line, AFTER success —
  // warning before it would make a failed login look like the warning's fault.
  write(
    `\n  Note: a token passed as a command-line argument is recorded in your shell\n` +
      `  history and is visible in \`ps\` to other users. Prefer ${TOKEN_ENV_VAR}.\n`,
  );

  return result;
}

// -----------------------------------------------------------------------------
// Presentation
// -----------------------------------------------------------------------------

function write(text: string): void {
  process.stderr.write(text);
}

/**
 * The instruction panel.
 *
 * Boxed and spaced because this is the one moment the user has to READ
 * something and act on it in another application, and a user code buried in a
 * line of prose gets mistyped. Drawn with box characters and blank lines
 * rather than colour: colour needs either a dependency or a hand-rolled
 * TTY/NO_COLOR/`FORCE_COLOR` matrix, and it is the first thing to disappear
 * when the output is redirected to a log — which is where a user who missed
 * the code goes looking for it.
 */
function printInstructions(grant: DeviceCodeGrant): void {
  const minutes = Math.max(1, Math.round(grant.expiresIn / 60));

  write(
    [
      '',
      '  ┌────────────────────────────────────────────────────────┐',
      '  │  Authorize this device                                 │',
      '  └────────────────────────────────────────────────────────┘',
      '',
      `  1. Open:  ${grant.verificationUri}`,
      `  2. Enter: ${grant.userCode}`,
      '',
      `  Or go straight to: ${grant.verificationUriComplete}`,
      '',
      `  This code expires in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
      '',
    ].join('\n'),
  );
}

/**
 * A one-line status that rewrites itself on a TTY and appends on a pipe.
 *
 * The `\r` trick is gated on `isTTY` for a reason: carriage returns in a CI
 * log do not overwrite anything, they produce one enormous unbroken line that
 * some log viewers refuse to render at all. Off a TTY this prints nothing per
 * poll — the interesting events (issued, approved, failed) are all logged
 * separately, and a line every five seconds for fifteen minutes is noise.
 */
function printPollState(state: DevicePollState): void {
  if (process.stderr.isTTY !== true) {
    if (state.kind === 'slow_down') {
      write(`  Server asked us to slow down; polling every ${state.intervalSeconds}s.\n`);
    }
    return;
  }

  switch (state.kind) {
    case 'polling':
      write(
        `\r  Waiting for approval… (${formatDuration(state.secondsRemaining)} left)    `,
      );
      break;
    case 'slow_down':
      write(`\r  Server asked us to slow down; now polling every ${state.intervalSeconds}s.    `);
      break;
    case 'approved':
      write('\r' + ' '.repeat(60) + '\r');
      break;
  }
}

function formatDuration(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${String(seconds).padStart(2, '0')}s` : `${seconds}s`;
}

/**
 * The success summary.
 *
 * Names the config path so "where does my token live?" — a fair question about
 * a credential that was just written to the user's home directory — is
 * answered without having to look it up. It reports the identity the server
 * confirmed, which is the only proof the login actually worked, and it does
 * not report the token.
 */
function reportSuccess(user: CurrentUser, path: string, serverUrl: string): void {
  const who = user.displayName === null ? user.email : `${user.displayName} <${user.email}>`;
  const roles = user.roles.map((role) => role.name).join(', ');

  write(
    [
      '',
      `  Logged in to ${serverUrl} as ${who}`,
      roles.length > 0 ? `  Roles: ${roles}` : '',
      `  Token saved to ${path}`,
      `  Revoke it any time from the Access Tokens page on ${serverUrl}.`,
      '',
    ]
      .filter((line) => line !== '')
      .join('\n') + '\n',
  );
}
