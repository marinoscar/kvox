import { Box, Text, useInput } from 'ink';
import Spinner from 'ink-spinner';
import { useEffect, useRef, useState, type ReactNode } from 'react';

import { CLI_NAME } from '../../branding.js';
import {
  SERVER_URL_ENV_VAR,
  TOKEN_ENV_VAR,
  describeConfig,
  resolveConfig,
  type ConfigSource,
  type ConfigSummary,
} from '../../config.js';
import { validateToken, type CurrentUser } from '../../device-login.js';
import { formatError } from '../../errors.js';
import { ErrorNotice, Field, Frame } from '../layout.js';

// =============================================================================
// The status screen  (issue #145, epic #110)
// =============================================================================
//
// #145's fourth screen: server, signed-in user, token expiry. It is the
// interactive form of `appctl config` plus the one thing that command does not
// do — actually asking the server who you are.
//
// -----------------------------------------------------------------------------
// THE TOKEN CANNOT BE DISPLAYED FROM HERE, AND NOT BECAUSE THIS FILE IS CAREFUL
// -----------------------------------------------------------------------------
// Everything shown comes from `describeConfig()`, which returns a
// `ConfigSummary` — a type with NO FIELD CAPABLE OF HOLDING THE TOKEN.
// `tokenHint` is already masked by `maskToken` before it arrives, and that
// function has no input for which it returns its input. So an edit that tried
// to render the credential would not compile; the guarantee is structural
// rather than a rule somebody has to remember. `commands/config.ts` relies on
// exactly the same property.
//
// This matters MORE in a TUI than in a command. A printed line appears once; a
// TUI frame is redrawn on every state change, so a token on this screen would
// be written into the user's scrollback dozens of times, and it is the screen
// people screenshot when they file a bug.
//
// The LIVE half — `GET /auth/me` — is separate from the stored half on purpose.
// Stored config answers "what do I have"; the server answers "does it still
// work". A revoked PAT still looks perfectly valid on disk, and the whole
// security argument for a long-lived token (epic #110) is that it can be
// revoked from the web UI — so a status screen that only read the file would
// confidently report a dead credential as fine.
// =============================================================================

export interface StatusScreenProps {
  onDone: () => void;
}

type Live =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'ok'; user: CurrentUser }
  | { kind: 'failed'; message: string };

export function StatusScreen({ onDone }: StatusScreenProps): ReactNode {
  const [summary, setSummary] = useState<ConfigSummary | undefined>(undefined);
  const [configError, setConfigError] = useState<string | undefined>(undefined);
  const [live, setLive] = useState<Live>({ kind: 'idle' });

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
    // Read inside an effect rather than during render: `describeConfig` touches
    // the filesystem and can throw on a corrupt file, and a throw during render
    // takes the whole ink tree down — turning "my config is broken" into "the
    // CLI will not start", with no screen left to explain it.
    let current: ConfigSummary;
    try {
      current = describeConfig();
    } catch (error) {
      setConfigError(formatError(error));
      return;
    }
    setSummary(current);

    const serverUrl = current.serverUrl;
    if (serverUrl === undefined || current.tokenSource === undefined) return;

    // `validateToken` needs the REAL token, so it is read here — from
    // `resolveConfig`, not from the summary, which structurally cannot carry
    // one. It is bound to a local const and goes into the request and nowhere
    // else: never into state, never into a message, so it cannot reach a frame.
    // `validateToken` already rewrites the server's 401 into a sentence naming
    // the remedy without echoing the credential.
    const token = resolveConfig().token;
    if (token === undefined) return;

    const controller = new AbortController();
    abortRef.current = controller;
    setLive({ kind: 'checking' });

    void (async () => {
      try {
        const user = await validateToken(serverUrl, token, { signal: controller.signal });
        if (mounted.current) setLive({ kind: 'ok', user });
      } catch (error) {
        if (!mounted.current) return;
        if (error instanceof Error && error.name === 'AbortError') return;
        setLive({ kind: 'failed', message: formatError(error) });
      }
    })();
  }, []);

  useInput((_input, key) => {
    if (key.escape || key.return) onDone();
  });

  if (configError !== undefined) {
    return (
      <Frame title="Status" hints={['esc back']}>
        <ErrorNotice
          message={configError}
          hint="Choose Logout from the menu to remove the file and start again."
        />
      </Frame>
    );
  }

  if (summary === undefined) {
    return (
      <Frame title="Status" hints={['esc back']}>
        <Text dimColor>Reading configuration…</Text>
      </Frame>
    );
  }

  if (summary.serverUrl === undefined && summary.tokenSource === undefined) {
    return (
      <Frame title="Status" hints={['esc back']}>
        <Box flexDirection="column" gap={1}>
          <Text bold>Not logged in.</Text>
          <Text dimColor>
            Choose Login from the menu, or set {SERVER_URL_ENV_VAR} and {TOKEN_ENV_VAR}.
          </Text>
          <Field label="File" value={`${summary.path} (does not exist)`} dim />
        </Box>
      </Frame>
    );
  }

  return (
    <Frame title="Status" hints={['esc back']}>
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Field
            label="Server"
            value={`${summary.serverUrl ?? '(not set)'}${sourceSuffix(summary.serverUrlSource)}`}
          />
          {/* Masked, and masked BEFORE it got here. See the header. */}
          <Field label="Token" value={`${summary.tokenHint}${sourceSuffix(summary.tokenSource)}`} />
          {summary.tokenName === undefined ? null : (
            // Name and id are not secrets — `GET /api/pat` returns both to the
            // same user — and they are what makes the token findable in the web
            // UI's Access Tokens list, which is the only way to revoke it.
            <Field label="Name" value={summary.tokenName} />
          )}
          {summary.tokenId === undefined ? null : <Field label="ID" value={summary.tokenId} dim />}
          <ExpiryField summary={summary} />
          <Field label="File" value={summary.fileExists ? summary.path : `${summary.path} (none)`} dim />
        </Box>

        <LiveIdentity live={live} />
      </Box>
    </Frame>
  );
}

/**
 * Expiry, with the three states `isExpired` actually distinguishes.
 *
 * `undefined` is UNKNOWN, not "fine": it is returned both when no expiry was
 * recorded and when the recorded one will not parse, and collapsing that to
 * "valid" would have the screen vouch for something it could not read. A token
 * supplied through the environment has no expiry we know of at all — see the
 * note in `resolveConfig` about why the file's leftover `expiresAt` is
 * deliberately not paired with it.
 */
function ExpiryField({ summary }: { summary: ConfigSummary }): ReactNode {
  if (summary.expiresAt === undefined) {
    return <Field label="Expires" value="unknown (no expiry recorded)" dim />;
  }
  if (summary.expired === true) {
    return (
      <Field label="Expires" value={`${summary.expiresAt}  — EXPIRED, log in again`} color="red" />
    );
  }
  return <Field label="Expires" value={summary.expiresAt} color="green" />;
}

/** The half only the server can answer. */
function LiveIdentity({ live }: { live: Live }): ReactNode {
  switch (live.kind) {
    case 'idle':
      return null;

    case 'checking':
      return (
        <Box>
          <Text color="cyan">
            <Spinner type="dots" />
          </Text>
          <Text dimColor> Checking with the server…</Text>
        </Box>
      );

    case 'ok': {
      const who =
        live.user.displayName === null
          ? live.user.email
          : `${live.user.displayName} <${live.user.email}>`;
      const roles = live.user.roles.map((role) => role.name).join(', ');
      return (
        <Box flexDirection="column">
          <Text color="green">✔ Signed in</Text>
          <Field label="User" value={who} />
          {roles.length > 0 ? <Field label="Roles" value={roles} /> : null}
        </Box>
      );
    }

    case 'failed':
      return (
        <ErrorNotice
          message={live.message}
          hint={`The stored details above are still what is on disk. Choose Login to replace them, or run \`${CLI_NAME} login\`.`}
        />
      );
  }
}

/**
 * Which layer won, env or file.
 *
 * Worth a column: the single most confusing state this CLI can be in is a
 * leftover exported `APPCTL_TOKEN` quietly overriding the config file, so that
 * a successful login appears to have had no effect whatsoever. Naming the
 * winning source turns that mystery into a one-word answer.
 */
function sourceSuffix(from: ConfigSource | undefined): string {
  switch (from) {
    case 'env':
      return '  (from the environment)';
    case 'file':
      return '  (from the config file)';
    default:
      return '';
  }
}
