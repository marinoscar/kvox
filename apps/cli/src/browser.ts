import { spawn } from 'node:child_process';
import { platform } from 'node:process';

// =============================================================================
// Best-effort browser launch  (issue #142, epic #110)
// =============================================================================
//
// NO DEPENDENCY. The obvious package here is `open`, and it is a good package;
// it is also ~30 lines of platform dispatch plus a transitive tree, added to a
// baseline whose whole job is to be a starting point somebody else audits. The
// three commands below are the entire mechanism, and they have not changed in
// a decade.
//
// THIS FUNCTION MUST NEVER FAIL THE LOGIN. Opening a browser is a convenience
// on top of a flow that is designed — this is the entire point of RFC 8628 —
// for devices that cannot open one. Over SSH, in a container, on a headless
// build agent, there is no browser and there was never going to be; the user
// code and the verification URL are printed regardless, and the user opens
// them wherever they actually are. So every failure path here returns `false`
// and nothing throws.
// =============================================================================

/** What happened, so the caller can word its next line accordingly. */
export interface BrowserOpenResult {
  opened: boolean;
  /** Why not, when `opened` is false. For a `--verbose`, not for the user. */
  reason?: 'unsupported-scheme' | 'headless' | 'spawn-failed' | 'no-opener';
}

/**
 * How long to wait for the child to start before giving up on it.
 *
 * We wait for `spawn`/`error`, NOT for the process to exit. A browser launcher
 * either execs immediately or fails immediately; waiting for exit would block
 * for as long as the browser runs, which on most Linux setups means until the
 * user closes it — i.e. forever, in the middle of a login.
 */
const SPAWN_TIMEOUT_MS = 2_000;

/**
 * Open `url` in the user's browser. Resolves `false` rather than throwing.
 *
 * Only `http:` and `https:` are accepted. That check is a security control,
 * not tidiness: this hands a string to a platform opener that will dispatch on
 * scheme, and `file:` would open a local file while schemes registered by
 * other applications can invoke them with arguments. The URL comes from the
 * server's `verificationUriComplete` — i.e. from a host the user named but
 * which is not otherwise trusted to choose what runs on their machine.
 */
export async function openInBrowser(url: string): Promise<BrowserOpenResult> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { opened: false, reason: 'unsupported-scheme' };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { opened: false, reason: 'unsupported-scheme' };
  }

  if (isHeadless()) {
    // Detected rather than attempted. Running `xdg-open` with no display does
    // not fail quietly — it prints its own error to the terminal, which lands
    // in the middle of the instructions the user is trying to read, and on
    // some systems it hangs waiting for a session bus that is not there.
    return { opened: false, reason: 'headless' };
  }

  const command = openerFor(url);
  if (command === undefined) return { opened: false, reason: 'no-opener' };

  return new Promise<BrowserOpenResult>((resolve) => {
    let settled = false;
    const finish = (result: BrowserOpenResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => finish({ opened: false, reason: 'spawn-failed' }), SPAWN_TIMEOUT_MS);
    // The timer must not itself hold the process open if everything else is
    // done — a login that has otherwise finished should not wait on it.
    timer.unref?.();

    try {
      const child = spawn(command.file, command.args, {
        // `detached` + `unref` so the CLI can exit while the browser lives on.
        // Without them, a launcher that keeps a handle on the browser process
        // keeps this process's event loop alive after `login` has finished.
        detached: true,
        // Everything ignored, so the browser's own diagnostics — GTK warnings,
        // profile-lock complaints, X11 noise — cannot interleave with the
        // device code we just printed.
        stdio: 'ignore',
        // No shell. The URL is attacker-influenced (see above) and a shell
        // would give `&`, `;` and backticks in it meaning.
        shell: false,
      });

      child.once('error', () => finish({ opened: false, reason: 'spawn-failed' }));
      child.once('spawn', () => {
        child.unref();
        finish({ opened: true });
      });
    } catch {
      finish({ opened: false, reason: 'spawn-failed' });
    }
  });
}

/**
 * There is no display to open a browser on.
 *
 * Linux/BSD only. macOS and Windows always have a window server when a user is
 * logged in, and `DISPLAY` means nothing there — testing it would wrongly skip
 * the open on every mac.
 */
function isHeadless(): boolean {
  if (platform === 'darwin' || platform === 'win32') return false;
  return (
    (process.env.DISPLAY ?? '') === '' &&
    (process.env.WAYLAND_DISPLAY ?? '') === '' &&
    // A macOS-style variable that some remote-desktop setups export; cheap to
    // honour and it prevents a false "headless" on those.
    (process.env.XDG_SESSION_TYPE ?? '') !== 'x11'
  );
}

/** The platform's "open this URL" command. */
function openerFor(url: string): { file: string; args: string[] } | undefined {
  switch (platform) {
    case 'darwin':
      // `--` so a URL that begins with a hyphen cannot be read as a flag.
      return { file: 'open', args: ['--', url] };
    case 'win32':
      // `start` is a cmd.exe BUILTIN, so cmd has to run it — there is no
      // `start.exe`. The empty string is the window TITLE argument: without
      // it, `start "https://..."` treats the quoted URL as the title and opens
      // nothing at all, which is the classic Windows bug in this function.
      return { file: 'cmd.exe', args: ['/d', '/s', '/c', 'start', '""', url] };
    default:
      // xdg-open on Linux and the BSDs. Absent on a minimal container, which
      // surfaces as an ENOENT `error` event and a clean `false`.
      return { file: 'xdg-open', args: [url] };
  }
}
