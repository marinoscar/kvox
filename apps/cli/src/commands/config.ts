import type { Command } from 'commander';

import { CLI_NAME } from '../branding.js';
import {
  SERVER_URL_ENV_VAR,
  TOKEN_ENV_VAR,
  describeConfig,
  type ConfigContext,
  type ConfigSource,
  type ConfigSummary,
} from '../config.js';

// =============================================================================
// `appctl config`  (issue #143, epic #110)
// =============================================================================
//
// "Where is my token, which server am I pointed at, and is it still valid?" is
// the first question asked whenever anything is wrong, and without this
// command the only way to answer it is to `cat` the config file — which prints
// the token to the terminal, into scrollback, and usually into a pasted bug
// report. Giving people a safe way to look is the point.
//
// THE TOKEN CANNOT BE PRINTED FROM HERE. Not because this file is careful, but
// because `describeConfig()` returns a ConfigSummary, and ConfigSummary has no
// field capable of holding it — `tokenHint` is already masked by the time it
// arrives. A future edit that tried to print the token would not compile.
// =============================================================================

export function registerConfigCommand(program: Command, ctx?: ConfigContext): Command {
  return program
    .command('config')
    .description('Show the stored server URL and a masked token hint')
    .action(() => {
      // stderr, like every other human-readable line in this CLI: stdout stays
      // reserved for #144's pipeable output. `--json` on stdout would be a
      // reasonable future addition and would go through the SAME
      // ConfigSummary, so it inherits the no-token guarantee for free.
      process.stderr.write(formatSummary(describeConfig(ctx)));
    });
}

export function formatSummary(summary: ConfigSummary): string {
  const lines: string[] = [''];

  if (summary.serverUrl === undefined && summary.tokenSource === undefined) {
    return (
      [
        '',
        `  Not logged in.`,
        '',
        `  Run \`${CLI_NAME} login\`, or set ${SERVER_URL_ENV_VAR} and ${TOKEN_ENV_VAR}.`,
        `  Config file: ${summary.path} (does not exist)`,
        '',
      ].join('\n') + '\n'
    );
  }

  lines.push(`  Server:  ${summary.serverUrl ?? '(not set)'}${source(summary.serverUrlSource)}`);
  lines.push(`  Token:   ${summary.tokenHint}${source(summary.tokenSource)}`);

  if (summary.tokenName !== undefined) {
    // The name and id are what let a user find the exact row to revoke in the
    // web UI's Access Tokens page — the property that makes a long-lived
    // credential acceptable (epic #110). Neither is a secret: `GET /api/pat`
    // already returns both to the same user.
    lines.push(`  Name:    ${summary.tokenName}`);
  }
  if (summary.tokenId !== undefined) {
    lines.push(`  ID:      ${summary.tokenId}`);
  }

  if (summary.expiresAt !== undefined) {
    const state = summary.expired === true ? ' (EXPIRED — run login again)' : '';
    lines.push(`  Expires: ${summary.expiresAt}${state}`);
  }

  if (summary.updatedAt !== undefined) {
    lines.push(`  Updated: ${summary.updatedAt}`);
  }

  lines.push(
    `  File:    ${summary.path}${summary.fileExists ? '' : ' (does not exist)'}`,
  );
  lines.push('');

  return lines.join('\n') + '\n';
}

/**
 * Says which layer won.
 *
 * Worth a column of its own: the single most confusing state this CLI can be
 * in is an exported `APPCTL_TOKEN` left over in a shell, quietly overriding
 * the config file so that `login` appears to have had no effect. Naming the
 * winning source turns a mystery into a one-word answer.
 */
function source(from: ConfigSource | undefined): string {
  switch (from) {
    case 'env':
      return '  (from the environment)';
    case 'file':
      return '  (from the config file)';
    default:
      return '';
  }
}
