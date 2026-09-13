import { readFileSync } from 'node:fs';

import { UsageError } from './errors.js';

// =============================================================================
// Resolving `--data` into a JSON value  (issue #144, epic #110)
// =============================================================================
//
// `--data` accepts three forms, following curl's convention because it is the
// one every user of a generic HTTP CLI already has in their fingers:
//
//   --data '{"email":"a@b.com"}'   the literal text
//   --data @body.json              the contents of a file
//   --data -                       everything on stdin  (also `@-`)
//
// WHY THE FILE AND STDIN FORMS ARE NOT A CONVENIENCE. #144 gives the reason
// directly: bodies do not belong in shell history, and a POST body is the
// common case for that. `appctl api POST /api/allowlist --data '{"email":...}'`
// is fine; the same command carrying an API key, a person's details, or a
// 40KB settings document is a credential-and-PII leak into `~/.bash_history`,
// into `ps` output visible to every other user on the box, and into the CI log
// of anything that echoes its commands. There is also a hard ceiling — ARG_MAX
// — that turns a large body into `Argument list too long`, which reads like a
// bug in the CLI rather than a limit of the shell.
//
// WHY THE PAYLOAD IS PARSED HERE RATHER THAN HANDED STRAIGHT TO THE CLIENT.
// A malformed body must be a LOCAL error. Sent as-is, a missing brace becomes
// a 400 from a Zod validator complaining about a field the user did believe
// they set — which sends them auditing their data model when the actual
// problem is a shell quoting mistake three characters long. Parsing first
// turns that into "your JSON is invalid at position 23", which is the whole
// diagnosis. It also means the exit code is USAGE (2) rather than API (3),
// which is the honest classification: the server never saw this request.
//
// The parsed value is then RE-SERIALISED by ApiClient rather than the original
// text being forwarded. That is deliberate: it guarantees the bytes on the
// wire are valid JSON with the client's own Content-Type, and it means a body
// with a UTF-8 BOM or trailing newline from an editor cannot reach the server
// as something Fastify's parser rejects.
// =============================================================================

/** Where a `--data` payload came from, for error messages that name the source. */
export type BodySourceKind = 'inline' | 'file' | 'stdin';

export interface ResolvedBody {
  /** The parsed value, ready to hand to `ApiClient`. */
  value: unknown;
  kind: BodySourceKind;
  /** Human-readable origin: `--data`, a path, or `stdin`. */
  description: string;
}

/**
 * Injection seam. Tests supply their own reader instead of writing temp files
 * or monkey-patching a global stdin, both of which leak across test files.
 */
export interface BodyResolutionContext {
  readFile?: ((path: string) => string) | undefined;
  readStdin?: (() => Promise<string>) | undefined;
  /** `process.stdin.isTTY`. See the guard in `readStdinText`. */
  stdinIsTTY?: boolean | undefined;
}

/**
 * The sentinel meaning "read stdin".
 *
 * UNAMBIGUOUS BY CONSTRUCTION, which is why no escape hatch is needed: `-` is
 * not valid JSON on its own (a bare minus sign is an incomplete number), so no
 * legitimate inline payload can ever be exactly this string. The same argument
 * covers `@` below — see `DATA_FILE_PREFIX`.
 */
const STDIN_SENTINEL = '-';

/**
 * The prefix meaning "read this file".
 *
 * A valid JSON document can only begin with `{`, `[`, `"`, a digit, `-`, or
 * one of `true`/`false`/`null`. NEVER with `@`. So treating a leading `@` as a
 * filename cannot shadow a real payload, and this CLI needs no `--data-raw`
 * counterpart to escape it — curl grew one only because its `--data` also
 * accepts non-JSON form bodies, where `@` is a plausible first character.
 *
 * THE COLLISION THAT DOES EXIST, stated plainly because it is unfixable rather
 * than overlooked: a file whose name literally starts with `@` cannot be named
 * here, since the first `@` is always consumed as the marker. `--data @@x.json`
 * reads a file called `@x.json`, and that is the whole workaround. Use `./@x`
 * — a relative path — if that ever matters.
 */
const DATA_FILE_PREFIX = '@';

/**
 * Turn whatever the user passed to `--data` into a parsed JSON value.
 *
 * Returns `undefined` when `--data` was not given at all, which is NOT the
 * same as `--data null`: the first sends no body and no Content-Type, the
 * second sends the four bytes `null`. `ApiClient.send` draws exactly that
 * distinction (`body !== undefined`), so preserving it here matters — a POST
 * to a body-less endpoint such as `/api/auth/logout` must not start declaring
 * a JSON content type it has no body for, which Fastify answers with a 400.
 */
export async function resolveRequestBody(
  raw: string | undefined,
  ctx?: BodyResolutionContext,
): Promise<ResolvedBody | undefined> {
  if (raw === undefined) return undefined;

  if (raw === STDIN_SENTINEL || raw === `${DATA_FILE_PREFIX}${STDIN_SENTINEL}`) {
    const text = await readStdinText(ctx);
    return { value: parseJson(text, 'stdin', 'stdin'), kind: 'stdin', description: 'stdin' };
  }

  if (raw.startsWith(DATA_FILE_PREFIX)) {
    const path = raw.slice(DATA_FILE_PREFIX.length);
    if (path.length === 0) {
      throw new UsageError(
        '--data @ needs a filename, for example --data @body.json (or --data - to read stdin).',
      );
    }
    const text = readFileText(path, ctx);
    return { value: parseJson(text, 'file', path), kind: 'file', description: path };
  }

  return { value: parseJson(raw, 'inline', '--data'), kind: 'inline', description: '--data' };
}

// -----------------------------------------------------------------------------
// Sources
// -----------------------------------------------------------------------------

function readFileText(path: string, ctx?: BodyResolutionContext): string {
  const read = ctx?.readFile ?? ((p: string) => readFileSync(p, 'utf8'));
  try {
    return read(path);
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException | null)?.code;
    // Each of these has a different fix, so each gets its own sentence rather
    // than a generic "could not read". ENOENT in particular is nearly always a
    // relative-path or a typo problem, and saying so beats echoing an errno.
    if (code === 'ENOENT') {
      throw new UsageError(`--data file not found: ${path}`, { cause });
    }
    if (code === 'EISDIR') {
      throw new UsageError(`--data ${path} is a directory, not a file.`, { cause });
    }
    if (code === 'EACCES') {
      throw new UsageError(`--data file is not readable: ${path}`, { cause });
    }
    throw new UsageError(`Could not read --data file ${path}: ${(cause as Error).message}`, {
      cause,
    });
  }
}

/**
 * Read stdin to the end.
 *
 * THE TTY GUARD IS THE POINT OF THIS FUNCTION. Without it, `appctl api POST
 * /api/allowlist --data -` typed at an interactive prompt simply HANGS — the
 * terminal is a valid stdin that will never reach EOF until the user happens
 * to know to press Ctrl-D. To anyone who mistyped the flag that is an
 * unresponsive CLI, and the usual reaction is Ctrl-C and a bug report. Failing
 * immediately with the actual remedy costs one branch.
 *
 * Read by async iteration rather than `readFileSync(0)`: reading fd 0
 * synchronously throws EAGAIN on a non-blocking pipe on some platforms — a
 * failure that depends on how the caller's shell set the descriptor up and so
 * reproduces on one machine in ten.
 *
 * NO SIZE LIMIT, deliberately. The reason this path exists is bodies too big
 * or too sensitive for a command line, and capping it would defeat that. The
 * ceiling is available memory, and the JSON has to be parsed into memory
 * regardless.
 */
async function readStdinText(ctx?: BodyResolutionContext): Promise<string> {
  if (ctx?.readStdin !== undefined) return ctx.readStdin();

  const isTTY = ctx?.stdinIsTTY ?? process.stdin.isTTY === true;
  if (isTTY) {
    throw new UsageError(
      '--data - reads the request body from stdin, but stdin is a terminal. ' +
        'Pipe the body in (`cat body.json | appctl api ...`) or use --data @body.json.',
    );
  }

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : (chunk as Buffer));
  }
  // Concatenated as BYTES and decoded once at the end, not decoded per chunk:
  // a multi-byte UTF-8 character can be split across a chunk boundary, and
  // decoding the halves independently yields two replacement characters — a
  // corruption that only appears for non-ASCII payloads over a certain size,
  // which is about the least reproducible bug available.
  return Buffer.concat(chunks).toString('utf8');
}

// -----------------------------------------------------------------------------
// Parsing
// -----------------------------------------------------------------------------

/**
 * Parse, and turn a failure into a message that names both the source and the
 * likely cause.
 *
 * The shell-quoting hint is attached ONLY to the inline form, because that is
 * the only form where it is the probable explanation — and it is a very
 * probable one. `--data "{"email":"a@b.com"}"` in bash produces the argument
 * `{email:a@b.com}`: the double quotes are consumed by the shell, and the CLI
 * is handed something that is not JSON and never was. Printing "unexpected
 * token e" without that hint sends people to check the API's schema.
 */
function parseJson(text: string, kind: BodySourceKind, source: string): unknown {
  const trimmed = text.trim();

  if (trimmed.length === 0) {
    // An empty file or an empty pipe is nearly always an upstream command that
    // produced nothing (a failed generator, a wrong path in a pipeline), and
    // sending an empty body would surface it as a confusing 400 from the API
    // instead of as the local mistake it is.
    const what =
      kind === 'stdin' ? 'stdin was empty' : kind === 'file' ? `${source} is empty` : '--data was empty';
    throw new UsageError(`${what}. A request body must be a JSON document.`);
  }

  try {
    return JSON.parse(trimmed);
  } catch (cause) {
    const detail = (cause as Error).message;
    const hint =
      kind === 'inline'
        ? " If your shell ate the quotes, wrap the whole value in single quotes: --data '{\"key\":\"value\"}' — or use --data @file.json."
        : '';
    throw new UsageError(`${source} is not valid JSON: ${detail}.${hint}`, { cause });
  }
}
