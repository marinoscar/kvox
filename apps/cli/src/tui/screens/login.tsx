import { Box, Text, useInput } from 'ink';
import Spinner from 'ink-spinner';
import TextInput from 'ink-text-input';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

import { CLI_NAME } from '../../branding.js';
import { resolveConfig } from '../../config.js';
import type { DeviceCodeGrant, DevicePollState } from '../../device-auth.js';
import {
  DeviceLoginError,
  completeLogin,
  runDeviceLogin,
  type CurrentUser,
} from '../../device-login.js';
import { formatError } from '../../errors.js';
import { ErrorNotice, Field, Frame, useIsMounted, useTerminalSize } from '../layout.js';

// =============================================================================
// The login screen  (issue #145, epic #110)
// =============================================================================
//
// THIS SCREEN IS WHY THE TUI EXISTS. #110 chose ink over Commander-with-spinners
// knowing it costs a React reconciler inside a CLI, and recorded that the device
// flow is where the cost is repaid: a device flow is a WAIT with live state —
// code issued, browser opened or not, awaiting approval, told to slow down,
// approved, validating — and a redrawing frame shows that far better than a
// column of log lines, because the user is reading a code off the screen and
// typing it somewhere else while the state changes underneath.
//
// IT REIMPLEMENTS NOTHING. `runDeviceLogin` (#142) is the sequence and
// `pollForDeviceToken` is the RFC 8628 state machine; both were extracted with
// this screen as the named second consumer, and both are driven here exactly as
// `commands/login.ts` drives them. The ONLY difference between the two callers
// is what they do with `DeviceLoginHooks`: the command turns each callback into
// a line of stderr, this screen turns each into a piece of React state. Every
// interval rule, every `slow_down` widening and all four RFC outcomes are
// therefore shared by construction rather than by discipline.
//
// THE TOKEN IS NEVER RENDERED. `credential.accessToken` is read in exactly one
// place below — passed straight to `completeLogin`, which validates and writes
// it to the 0600 config file. It is never put into state, so it cannot reach a
// frame, and a frame is worse than a printed line: ink redraws it repeatedly,
// so a token on screen would be in the scrollback dozens of times over.
// =============================================================================

export interface LoginScreenProps {
  onDone: () => void;
}

/**
 * Where the flow is. A discriminated union rather than a bag of booleans,
 * because the states are genuinely exclusive and the render is a `switch` —
 * `isLoading && !isError && grant !== undefined` is how a screen ends up
 * momentarily displaying two things at once during a transition.
 */
type Phase =
  | { kind: 'server' }
  | { kind: 'requesting' }
  | { kind: 'awaiting'; grant: DeviceCodeGrant }
  | { kind: 'verifying'; grant: DeviceCodeGrant }
  | { kind: 'done'; user: CurrentUser; path: string; serverUrl: string }
  | { kind: 'failed'; message: string; hint: string };

export function LoginScreen({ onDone }: LoginScreenProps): ReactNode {
  const isMounted = useIsMounted();

  const [serverUrl, setServerUrl] = useState<string>(() => storedServerUrl() ?? '');
  const [phase, setPhase] = useState<Phase>({ kind: 'server' });

  // Kept OUT of `phase` on purpose. `onPollState` fires on every single poll —
  // up to once a second for fifteen minutes — and folding it into the phase
  // union would mean replacing the whole object (grant included) each time,
  // making every poll a change to data that did not change. Separate state
  // keeps the grant identity stable across the entire wait.
  const [poll, setPoll] = useState<DevicePollState | undefined>(undefined);
  const [browserNote, setBrowserNote] = useState<string | undefined>(undefined);
  const [unclassified, setUnclassified] = useState<string | undefined>(undefined);

  /**
   * Cancellation for everything in flight.
   *
   * THIS IS LOAD-BEARING, NOT TIDINESS. `pollForDeviceToken` sleeps between
   * polls with a real `setTimeout`, and a pending timer keeps the Node event
   * loop alive. Without the abort, pressing Esc (or Ctrl-C, which unmounts the
   * tree) would tear down the UI and leave the PROCESS running silently for the
   * remaining minutes of the device code's lifetime, with the user back at a
   * shell prompt that never returns. `defaultSleep` in device-auth.ts rejects on
   * abort and removes its listener, so aborting here ends the loop immediately.
   */
  const abortRef = useRef<AbortController | undefined>(undefined);

  useEffect(
    () => () => {
      abortRef.current?.abort();
    },
    [],
  );

  const start = useCallback(
    async (url: string): Promise<void> => {
      const trimmed = url.trim();
      if (trimmed.length === 0) return;

      const controller = new AbortController();
      abortRef.current = controller;

      setPoll(undefined);
      setBrowserNote(undefined);
      setUnclassified(undefined);
      setPhase({ kind: 'requesting' });

      try {
        const { credential, grant } = await runDeviceLogin({
          serverUrl: trimmed,
          signal: controller.signal,
          hooks: {
            // Every one of these can fire after an unmount — the sequence has no
            // idea the UI is gone — so every one is guarded. See `useIsMounted`.
            onCodeIssued: (issued) => {
              if (isMounted()) setPhase({ kind: 'awaiting', grant: issued });
            },
            onBrowserOpen: (result) => {
              if (!isMounted()) return;
              setBrowserNote(
                result.opened
                  ? 'Opened your browser.'
                  : 'Could not open a browser — use the URL above.',
              );
            },
            onPollState: (state) => {
              if (isMounted()) setPoll(state);
            },
            onUnclassified: (signal) => {
              if (!isMounted()) return;
              // Surfaced rather than hidden, for the same reason
              // `commands/login.ts` surfaces it: against a server that does not
              // put the RFC code on the wire (see the defect note at the top of
              // device-auth.ts) a denial is indistinguishable from waiting, so
              // a user who pressed Deny and then watches a spinner deserves to
              // know the CLI cannot tell.
              setUnclassified(
                `This server does not report device-authorization status in the standard format (it answered ${signal.status}). A denial will look like the code expiring.`,
              );
            },
          },
        });

        if (!isMounted()) return;
        setPhase({ kind: 'verifying', grant });

        const { user, path } = await completeLogin({
          serverUrl: trimmed,
          token: credential.accessToken,
          expiresAt: credential.expiresAt,
          tokenId: credential.tokenId,
          tokenName: credential.tokenName,
          signal: controller.signal,
        });

        if (!isMounted()) return;
        setPhase({ kind: 'done', user, path, serverUrl: trimmed });
      } catch (error) {
        // A cancellation is the user pressing Esc, not a failure. Reporting it
        // would flash a red error onto a screen that is already unmounting.
        if (isCancellation(error)) return;
        if (!isMounted()) return;
        setPhase({ kind: 'failed', message: formatError(error), hint: hintFor(error) });
      }
    },
    [isMounted],
  );

  // Esc returns to the menu from any phase; `r` retries a failed attempt.
  //
  // `isActive` is false while the server field has focus, because `ink-text-input`
  // and `useInput` BOTH receive every keystroke — without the guard, typing the
  // `r` in `server` would restart the flow, and Esc is a key some terminals send
  // as the prefix of an arrow-key sequence.
  useInput(
    (input, key) => {
      if (key.escape) {
        onDone();
        return;
      }
      if (input === 'r' && phase.kind === 'failed') {
        void start(serverUrl);
      }
      if (key.return && phase.kind === 'done') {
        onDone();
      }
    },
    { isActive: phase.kind !== 'server' },
  );

  switch (phase.kind) {
    case 'server':
      return (
        <Frame title="Login" hints={['enter continue', 'ctrl-c exit']}>
          <Box flexDirection="column" gap={1}>
            <Text>Which server?</Text>
            <Box>
              <Text dimColor>{'URL  '}</Text>
              <TextInput
                value={serverUrl}
                onChange={setServerUrl}
                onSubmit={(value) => {
                  void start(value);
                }}
                placeholder="https://app.example.com"
              />
            </Box>
            <Text dimColor>
              A personal access token will be issued for this machine and stored locally. You can
              revoke it from the Access Tokens page at any time.
            </Text>
          </Box>
        </Frame>
      );

    case 'requesting':
      return (
        <Frame title="Login" hints={['esc cancel']}>
          <Box>
            <Text color="cyan">
              <Spinner type="dots" />
            </Text>
            <Text> Requesting a device code from {serverUrl}…</Text>
          </Box>
        </Frame>
      );

    case 'awaiting':
      return (
        <Frame title="Login" hints={['esc cancel', 'ctrl-c exit']}>
          <DeviceCodePanel
            grant={phase.grant}
            poll={poll}
            browserNote={browserNote}
            unclassified={unclassified}
          />
        </Frame>
      );

    case 'verifying':
      return (
        <Frame title="Login" hints={['esc cancel']}>
          <Box flexDirection="column" gap={1}>
            <Text color="green">✔ Approved.</Text>
            <Box>
              <Text color="cyan">
                <Spinner type="dots" />
              </Text>
              {/* "Verifying" is the honest word: `completeLogin` calls
                  `GET /auth/me` BEFORE writing anything to disk, so a token
                  that does not work never replaces a working one. */}
              <Text> Verifying the token and saving…</Text>
            </Box>
          </Box>
        </Frame>
      );

    case 'done': {
      const who =
        phase.user.displayName === null
          ? phase.user.email
          : `${phase.user.displayName} <${phase.user.email}>`;
      const roles = phase.user.roles.map((role) => role.name).join(', ');

      return (
        <Frame title="Login" hints={['enter return to the menu', 'esc return to the menu']}>
          <Box flexDirection="column" gap={1}>
            <Text color="green" bold>
              ✔ Logged in to {phase.serverUrl}
            </Text>
            <Box flexDirection="column">
              <Field label="User" value={who} />
              {roles.length > 0 ? <Field label="Roles" value={roles} /> : null}
              {/* The PATH, never the token. Answers "where does my credential
                  live?" without putting the credential on screen. */}
              <Field label="Saved to" value={phase.path} dim />
            </Box>
            <Text dimColor>Revoke this token any time from the Access Tokens page.</Text>
          </Box>
        </Frame>
      );
    }

    case 'failed':
      return (
        <Frame title="Login" hints={['r retry', 'esc return to the menu']}>
          <ErrorNotice message={phase.message} hint={phase.hint} />
        </Frame>
      );
  }
}

// -----------------------------------------------------------------------------
// The instruction panel
// -----------------------------------------------------------------------------

/**
 * The user code, the verification URI, and the live polling state.
 *
 * THE CODE IS THE ONLY THING ON THIS SCREEN THAT MATTERS. Everything else is
 * context for it: the user is going to read these characters off the terminal
 * and type them into a browser, possibly on another device, and a mistyped
 * character means starting over. So it gets a box of its own, bold cyan, and
 * — at any width that allows it — a space between every character, because
 * letter-spacing is what stops `WDJB` from being read as `WD]B` in a
 * condensed terminal font and makes `0`/`O` and `1`/`l` distinguishable by
 * position when the user is checking their typing.
 *
 * WHY NOT `ink-big-text` / figlet-style block glyphs, which is the obvious way
 * to make a code "large": it needs another dependency (cfonts), it renders a
 * character as roughly six columns, and an eight-character code is then ~50
 * columns wide — so it wraps, and a wrapped block-letter code is genuinely
 * unreadable rather than merely small. A bordered, spaced, bold line is legible
 * at every width and degrades in one step.
 */
function DeviceCodePanel({
  grant,
  poll,
  browserNote,
  unclassified,
}: {
  grant: DeviceCodeGrant;
  poll: DevicePollState | undefined;
  browserNote: string | undefined;
  unclassified: string | undefined;
}): ReactNode {
  const { columns, narrow } = useTerminalSize();

  const spaced = grant.userCode.split('').join(' ');
  // Border plus padding costs 8 columns; below that the spacing is dropped and
  // then, if it still will not fit, the box.
  const spacedFits = spaced.length + 8 <= columns;
  const code = spacedFits ? spaced : grant.userCode;
  const boxed = !narrow && grant.userCode.length + 8 <= columns;

  const codeText = (
    <Text bold color="cyan">
      {code}
    </Text>
  );

  return (
    <Box flexDirection="column" gap={1}>
      <Text>1. Open this URL:</Text>
      {/* Not truncated and not wrapped by us at any width. A verification URI
          carries the code as a query parameter; a URL broken across lines
          cannot be copied, and one silently shortened with an ellipsis is
          worse — it looks complete and is not. The terminal's own soft wrap is
          the least-bad handling, so it is left to do it. */}
      <Text color="blue">{grant.verificationUriComplete}</Text>

      <Text>2. Enter this code:</Text>
      {boxed ? (
        <Box borderStyle="round" borderColor="cyan" paddingX={2}>
          {codeText}
        </Box>
      ) : (
        codeText
      )}

      {grant.verificationUri !== grant.verificationUriComplete ? (
        <Text dimColor>Code entry page: {grant.verificationUri}</Text>
      ) : null}

      {browserNote === undefined ? null : <Text dimColor>{browserNote}</Text>}

      <PollStatus poll={poll} />

      {unclassified === undefined ? null : (
        <Text color="yellow">! {unclassified}</Text>
      )}
    </Box>
  );
}

/**
 * The line that changes in place — the whole argument for a redrawing UI.
 *
 * A countdown is shown rather than an elapsed time because it answers the
 * question the user actually has ("do I still have time to go and find my
 * phone?"), and because it makes the eventual expiry unsurprising instead of an
 * error out of nowhere.
 */
function PollStatus({ poll }: { poll: DevicePollState | undefined }): ReactNode {
  if (poll === undefined) {
    return <Text dimColor>Waiting…</Text>;
  }

  switch (poll.kind) {
    case 'polling':
      return (
        <Box>
          <Text color="cyan">
            <Spinner type="dots" />
          </Text>
          <Text> Waiting for you to approve… </Text>
          <Text dimColor>({formatDuration(poll.secondsRemaining)} left)</Text>
        </Box>
      );
    case 'slow_down':
      // Shown, not hidden: the server is rate-limiting us and the visible
      // consequence is that approval will be noticed more slowly. A user
      // watching an unexplained slowdown assumes the CLI is broken.
      return (
        <Text color="yellow">
          ! The server asked us to slow down; now polling every {poll.intervalSeconds}s.
        </Text>
      );
    case 'approved':
      return <Text color="green">✔ Approved.</Text>;
  }
}

function formatDuration(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${String(seconds).padStart(2, '0')}s` : `${seconds}s`;
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/**
 * The stored server URL, offered as the field's initial value.
 *
 * PREFILLED, NOT USED OUTRIGHT — the same choice `commands/login.ts` makes.
 * Logging in against a different server is a normal thing to do, and silently
 * reusing the last one would mint a token for the wrong host with no sign that
 * a decision had been made on the user's behalf.
 *
 * Wrapped because `resolveConfig` reads and parses the config file and throws
 * ConfigError on a corrupt one. A throw here happens during the `useState`
 * initialiser, which would take down the tree before the screen ever appeared —
 * making a broken config file impossible to fix by logging in again, which is
 * the exact remedy the error text recommends.
 */
function storedServerUrl(): string | undefined {
  try {
    return resolveConfig().serverUrl;
  } catch {
    return undefined;
  }
}

/** Esc during the flow aborts it; that is not something to render as a failure. */
function isCancellation(error: unknown): boolean {
  if (error instanceof DeviceLoginError) return error.reason === 'cancelled';
  return error instanceof Error && error.name === 'AbortError';
}

/**
 * The extra sentence the SCREEN can add and the error cannot.
 *
 * The messages from device-auth.ts already carry their own remedy ("Run
 * `appctl login` to get a new code"), so this only adds what is specific to
 * being inside the TUI — which key to press — and, for a denial, the fact that
 * retrying means re-asking a person who just said no.
 */
function hintFor(error: unknown): string {
  if (error instanceof DeviceLoginError && error.reason === 'denied') {
    return 'Press esc to return to the menu. Retry only if the denial was a mistake.';
  }
  return `Press r to try again, or esc to return to the menu. The same flow runs as \`${CLI_NAME} login\`.`;
}
