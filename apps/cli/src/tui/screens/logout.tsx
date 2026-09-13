import { Box, Text, useInput } from 'ink';
import SelectInput from 'ink-select-input';
import Spinner from 'ink-spinner';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

import { ApiClient, resolveApiBaseUrl } from '../../api-client.js';
import { CLI_NAME } from '../../branding.js';
import {
  TOKEN_ENV_VAR,
  deleteConfigFile,
  describeConfig,
  resolveConfig,
  type ConfigSummary,
} from '../../config.js';
import { formatError } from '../../errors.js';
import { ErrorNotice, Field, Frame } from '../layout.js';

// =============================================================================
// The logout screen  (issue #145, epic #110)
// =============================================================================
//
// -----------------------------------------------------------------------------
// WHY LOGOUT REVOKES THE TOKEN SERVER-SIDE AND DOES NOT JUST DELETE THE FILE
// -----------------------------------------------------------------------------
// The credential this CLI stores is a PERSONAL ACCESS TOKEN with a lifetime
// measured in days (#141), not a fifteen-minute session JWT. Deleting the local
// file makes it invisible to the user and leaves it FULLY VALID on the server
// for the rest of its life — so "log out on the machine I am about to hand back"
// would achieve nothing at all, while looking like it had worked. Epic #110's
// entire argument for accepting a long-lived credential is that it is
// revocable; a logout that skips the revocation quietly withdraws that.
//
// So: `DELETE /api/pat/{id}` first, then remove the file. The order matters and
// it is the opposite of the intuitive one — revoke while we still HAVE a
// credential to authenticate the revocation with. Deleting the file first would
// leave the only copy of the token id and the token itself gone, with the PAT
// still live and now impossible to revoke from here at all.
//
// THE LOCAL FILE IS REMOVED EVEN IF THE REVOCATION FAILS. The machine in front
// of us is the one thing we can definitely secure, and refusing to log out
// because the network is down is the wrong trade. The screen says plainly that
// the server-side token is still live and where to revoke it by hand.
//
// -----------------------------------------------------------------------------
// `POST /api/auth/logout` IS DELIBERATELY NOT CALLED
// -----------------------------------------------------------------------------
// That endpoint invalidates a refresh-token SESSION — the web app's model. This
// CLI has no session and no refresh token (epic #110 puts refresh rotation out
// of scope on purpose); it holds a PAT, and PATs are revoked through the PAT
// module. Calling the session endpoint would return success while revoking
// nothing, which is worse than not calling it.
// =============================================================================

export interface LogoutScreenProps {
  onDone: () => void;
}

type Phase =
  | { kind: 'confirm' }
  | { kind: 'working' }
  | { kind: 'done'; revoked: RevocationOutcome; removedFile: boolean }
  | { kind: 'failed'; message: string };

/** What happened to the token on the SERVER. Distinct from the local file. */
type RevocationOutcome =
  | { kind: 'revoked' }
  /** No token id stored, or the token came from the environment. */
  | { kind: 'skipped'; why: string }
  /** We tried and could not. The token is still live. */
  | { kind: 'failed'; message: string };

interface ConfirmItem {
  key: string;
  label: string;
  value: 'yes' | 'no';
}

const CONFIRM_ITEMS: ConfirmItem[] = [
  // "No" FIRST, and selected by default. This action revokes a credential and
  // cannot be undone — re-logging in mints a different token — so the default
  // highlighted choice must be the harmless one. A destructive action whose
  // default is "yes" is one stray Enter away from happening by accident.
  { key: 'no', label: 'No — keep me logged in', value: 'no' },
  { key: 'yes', label: 'Yes — revoke this token and remove the local file', value: 'yes' },
];

export function LogoutScreen({ onDone }: LogoutScreenProps): ReactNode {
  const [summary, setSummary] = useState<ConfigSummary | undefined>(undefined);
  const [phase, setPhase] = useState<Phase>({ kind: 'confirm' });

  const mounted = useRef(true);
  const abortRef = useRef<AbortController | undefined>(undefined);

  useEffect(
    () => () => {
      mounted.current = false;
      abortRef.current?.abort();
    },
    [],
  );

  useEffect(() => {
    try {
      setSummary(describeConfig());
    } catch (error) {
      // A corrupt config file is one of the states logout is FOR — deleting it
      // is the documented remedy (see `readConfigFile`). So the screen stays
      // usable and offers to remove the file anyway; only the summary is lost.
      setPhase({ kind: 'failed', message: formatError(error) });
    }
  }, []);

  const run = useCallback(async () => {
    setPhase({ kind: 'working' });

    const controller = new AbortController();
    abortRef.current = controller;

    const revoked = await revokeStoredToken(controller.signal);

    let removedFile = false;
    try {
      removedFile = deleteConfigFile();
    } catch (error) {
      if (mounted.current) setPhase({ kind: 'failed', message: formatError(error) });
      return;
    }

    if (mounted.current) setPhase({ kind: 'done', revoked, removedFile });
  }, []);

  useInput(
    (_input, key) => {
      if (key.escape || (key.return && phase.kind === 'done')) onDone();
    },
    // Off during 'confirm', where SelectInput owns Enter — otherwise the same
    // keypress that chooses an item would also leave the screen.
    { isActive: phase.kind !== 'confirm' },
  );

  switch (phase.kind) {
    case 'confirm':
      return (
        <Frame title="Logout" hints={['↑↓ move', 'enter choose', 'esc back']}>
          <Box flexDirection="column" gap={1}>
            {summary === undefined || summary.tokenSource === undefined ? (
              <Text>Nothing is stored — there is nothing to log out of.</Text>
            ) : (
              <Box flexDirection="column">
                <Text>This will revoke the token below and delete the local file.</Text>
                <Field label="Server" value={summary.serverUrl ?? '(not set)'} />
                {/* Masked before it reached this screen — `ConfigSummary` has
                    no field that could hold the real token. */}
                <Field label="Token" value={summary.tokenHint} />
                {summary.tokenName === undefined ? null : (
                  <Field label="Name" value={summary.tokenName} />
                )}
                <Field label="File" value={summary.path} dim />
              </Box>
            )}

            {summary?.tokenSource === 'env' ? (
              // The one case where logout genuinely cannot do what it says.
              // Saying so beats deleting a file that was not being used and
              // reporting success while the environment keeps the CLI logged in.
              <Text color="yellow">
                ! {TOKEN_ENV_VAR} is set, and it takes precedence over the file. Removing the file
                will not log this shell out — unset the variable as well.
              </Text>
            ) : null}

            <SelectInput
              items={CONFIRM_ITEMS}
              onSelect={(item) => {
                if (item.value === 'no') {
                  onDone();
                  return;
                }
                void run();
              }}
            />
          </Box>
        </Frame>
      );

    case 'working':
      return (
        <Frame title="Logout" hints={['esc cancel']}>
          <Box>
            <Text color="cyan">
              <Spinner type="dots" />
            </Text>
            <Text> Revoking the token and clearing local state…</Text>
          </Box>
        </Frame>
      );

    case 'done':
      return (
        <Frame title="Logout" hints={['enter return to the menu', 'esc return to the menu']}>
          <Box flexDirection="column" gap={1}>
            <Text color="green" bold>
              ✔ Logged out.
            </Text>
            <Box flexDirection="column">
              <RevocationLine outcome={phase.revoked} />
              <Text dimColor>
                {phase.removedFile
                  ? 'Local configuration removed.'
                  : 'There was no local configuration file to remove.'}
              </Text>
            </Box>
            <Text dimColor>{`Run \`${CLI_NAME} login\` — or choose Login — to sign in again.`}</Text>
          </Box>
        </Frame>
      );

    case 'failed':
      return (
        <Frame title="Logout" hints={['esc back']}>
          <ErrorNotice
            message={phase.message}
            hint={
              summary === undefined
                ? 'The configuration could not be read. Delete it by hand and log in again.'
                : `Delete ${summary.path} by hand if this keeps happening.`
            }
          />
        </Frame>
      );
  }
}

function RevocationLine({ outcome }: { outcome: RevocationOutcome }): ReactNode {
  switch (outcome.kind) {
    case 'revoked':
      return <Text dimColor>Token revoked on the server.</Text>;
    case 'skipped':
      return <Text dimColor>{outcome.why}</Text>;
    case 'failed':
      // Loud, because the user believes they have logged out and the
      // credential is still live. Naming the page is the actionable part.
      return (
        <Text color="yellow">
          ! The token could NOT be revoked on the server and is still valid: {outcome.message}{' '}
          Revoke it from the Access Tokens page.
        </Text>
      );
  }
}

/**
 * `DELETE /api/pat/{id}` for the stored token.
 *
 * Never throws — every outcome is a value, because the caller must delete the
 * local file regardless of what happened here and a thrown error would skip
 * that. The three outcomes are distinguished because they mean three different
 * things to a user who is trying to make a credential stop working.
 *
 * The `tokenId` is what makes this possible at all, and it is stored at login
 * for exactly this purpose (#143). Without one — a token supplied through the
 * environment, or a config written before ids were recorded — there is nothing
 * to address the request to, and inventing a guess is not an option.
 */
async function revokeStoredToken(signal: AbortSignal): Promise<RevocationOutcome> {
  let resolved;
  try {
    resolved = resolveConfig();
  } catch (error) {
    return { kind: 'failed', message: formatError(error) };
  }

  const { serverUrl, token, tokenId, tokenSource } = resolved;

  if (tokenSource === 'env') {
    return {
      kind: 'skipped',
      why: `The token came from ${TOKEN_ENV_VAR}, so it was not revoked — unset the variable, or revoke it from the Access Tokens page.`,
    };
  }

  if (serverUrl === undefined || token === undefined || tokenId === undefined) {
    return {
      kind: 'skipped',
      why: 'No revocable token id was stored, so nothing was revoked on the server.',
    };
  }

  try {
    const client = new ApiClient({ baseUrl: resolveApiBaseUrl(serverUrl), token });
    await client.delete(`/pat/${encodeURIComponent(tokenId)}`, { signal });
    return { kind: 'revoked' };
  } catch (error) {
    // A 401 here is the ordinary case, not a bug: the token may already have
    // been revoked from the web UI, which is precisely why the local file needs
    // clearing. `formatError` produces the server's own sentence.
    return { kind: 'failed', message: formatError(error) };
  }
}
