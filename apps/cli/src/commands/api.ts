import type { Command } from 'commander';

import { ApiClient, resolveApiBaseUrl } from '../api-client.js';
import { API_PATH_PREFIX, CLI_NAME } from '../branding.js';
import { requireCredentials, type ConfigContext } from '../config.js';
import { UsageError } from '../errors.js';
import { createSpinner, formatJson, formatStatusLine, shouldUseColour } from '../output.js';
import { resolveRequestBody, type BodyResolutionContext } from '../request-body.js';

// =============================================================================
// `appctl api <method> <path>`  (issue #144, epic #110)
// =============================================================================
//
// ONE COMMAND FOR THE WHOLE API, and the reason is architectural rather than
// lazy. This repository is a BASELINE: downstream applications delete
// `/api/allowlist`, add `/api/invoices`, and rename half of what is left. A
// CLI with a hand-written subcommand per resource would be obsolete in every
// fork on the day it was forked, and every new endpoint would need matching
// CLI work forever. A generic invoker is the only shape that stays correct
// through that — it works against endpoints that do not exist yet.
//
// #110 records the two alternatives and why they lost: typed subcommands
// (friendlier, and wrong for a template) and generating commands from the
// published OpenAPI document (genuinely attractive, and a code-generation
// pipeline plus a schema-drift problem — a project of its own). The generic
// command is the foundation under either of them.
//
// -----------------------------------------------------------------------------
// THE CONTRACT THIS COMMAND MAKES WITH A SHELL
// -----------------------------------------------------------------------------
//   stdout : the response body. Nothing else. Ever.
//   stderr : status line, spinner, warnings, errors.
//   exit 0 : if and only if the server answered 2xx.
//
// All three are load-bearing and all three fail silently when broken. A status
// line on stdout breaks `--raw | jq` for every consumer at once. An exit 0 on
// a 403 turns a broken deploy into a green pipeline, and nobody finds out
// until much later.
//
// The exit codes are not computed here: the command THROWS, `program.ts`
// catches, and `exitCodeFor` (errors.ts) maps ApiError → 3 (or 5 for a 401),
// NetworkError → 4, UsageError → 2. The message printed is `err.message`,
// which ApiError has already built as `<status>: <the server's own sentence>`
// — so a missing permission arrives as `403: Missing permission users:read`
// and not as `Request failed`. That is the entire point of errors.ts, and this
// command's job is to not get in its way.
// =============================================================================

/**
 * Methods this command will send.
 *
 * AN ALLOW-LIST, not a passthrough, because #144 asks for a typo to be a clear
 * local error rather than a confusing remote one. `appctl api GTE /api/users`
 * sent verbatim gets a 404 or a 405 from the server, and a 404 reads as "that
 * endpoint does not exist" — sending the user to check the path, which was
 * correct all along. Rejecting it here names the actual mistake.
 *
 * The set is HTTP's own, not this API's: HEAD and OPTIONS are here because
 * probing an endpoint's existence and its allowed methods is a legitimate
 * thing to do with a generic client, and excluding them would push someone to
 * curl. TRACE and CONNECT are excluded — no application server should honour
 * them and both are proxy-level operations.
 *
 * EXPORTED FOR THE INK TUI (#145), which offers these as a pick-list on its
 * endpoint-invoker screen rather than making the user type one. A second
 * hard-coded list there would be the classic way for the two interfaces to
 * drift — the TUI would keep offering a method the command had stopped
 * accepting, and the mismatch would only ever be noticed by a user.
 */
export const ALLOWED_METHODS = [
  'GET',
  'HEAD',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'OPTIONS',
] as const;

export type AllowedMethod = (typeof ALLOWED_METHODS)[number];

/**
 * Methods for which a request body is not merely unusual but IMPOSSIBLE.
 *
 * The WHATWG fetch specification forbids a body on GET and HEAD, so Node's
 * fetch throws `TypeError: Request with GET/HEAD method cannot have body`
 * before a socket is opened. That throw lands in `ApiClient.send`'s catch
 * around `fetchImpl`, which classifies everything it catches as a transport
 * failure — so the user would be told "Could not reach https://host", which is
 * a lie with a completely misleading fix attached (check your VPN, is the
 * server up) for what is actually a two-word mistake in their command.
 *
 * Checked HERE, before the client is ever called, so the diagnosis is the real
 * one. DELETE is deliberately absent: a DELETE with a body is legal, some APIs
 * use it, and fetch permits it.
 *
 * Exported for the TUI, which uses it to decide whether to ask for a body at
 * all rather than offering a field that could only produce this error.
 */
export const BODYLESS_METHODS: ReadonlySet<AllowedMethod> = new Set<AllowedMethod>([
  'GET',
  'HEAD',
]);

interface ApiCommandOptions {
  /** Absent when `--query` was never passed; see the registration below. */
  query?: string[] | undefined;
  data?: string | undefined;
  raw?: boolean | undefined;
  quiet?: boolean | undefined;
  /** commander's `--no-color` sets this false; default true. */
  color: boolean;
  timeout?: string | undefined;
}

export function registerApiCommand(
  program: Command,
  ctx?: ConfigContext & BodyResolutionContext,
): Command {
  return program
    .command('api')
    .description('Call any API endpoint and print the response')
    .argument('<method>', `HTTP method (${ALLOWED_METHODS.join(', ')})`)
    .argument('<path>', 'Request path, e.g. /api/auth/me')
    // No default value is passed to commander here on purpose: supplying `[]`
    // makes it advertise `(default: [])` in `--help`, which is noise that
    // means nothing to a reader. The absent case is handled at the use site.
    .option('--query <key=value>', 'Query parameter; repeat for more than one', collectQuery)
    .option('--data <json>', "Request body: inline JSON, @file.json, or - for stdin")
    .option('--raw', 'Print unformatted JSON on stdout and nothing else')
    .option('-q, --quiet', 'Suppress the status line and spinner on stderr')
    .option('--no-color', 'Disable colour even on a terminal')
    .option('--timeout <ms>', 'Per-request timeout in milliseconds')
    .addHelpText(
      'after',
      [
        '',
        'Examples:',
        `  ${CLI_NAME} api GET /api/auth/me`,
        `  ${CLI_NAME} api GET /api/users --query page=2 --query pageSize=50`,
        `  ${CLI_NAME} api POST /api/allowlist --data '{"email":"a@b.com"}'`,
        `  ${CLI_NAME} api POST /api/allowlist --data @entry.json`,
        `  cat entry.json | ${CLI_NAME} api POST /api/allowlist --data -`,
        `  ${CLI_NAME} api GET /api/users --raw | jq '.data[].email'`,
        '',
        'Output:',
        '  The response body goes to stdout; everything else goes to stderr, so',
        '  `--raw | jq` and `--raw > file.json` both stay clean. The exit code is 0',
        '  only for a 2xx; a non-2xx exits non-zero with the server’s own message.',
        '',
        `  The \`${API_PATH_PREFIX}\` prefix is optional: /api/auth/me and /auth/me are the same.`,
      ].join('\n'),
    )
    .action(async (method: string, path: string, options: ApiCommandOptions) => {
      await runApiCommand(method, path, options, ctx);
    });
}

async function runApiCommand(
  rawMethod: string,
  rawPath: string,
  options: ApiCommandOptions,
  ctx?: ConfigContext & BodyResolutionContext,
): Promise<void> {
  const method = parseMethod(rawMethod);
  const { path, query } = parseRequestPath(rawPath);
  const timeoutMs = parseTimeout(options.timeout);

  for (const pair of options.query ?? []) {
    const { key, value } = parseQueryPair(pair);
    // `append`, not `set`: repeated keys are how a REST API expresses a
    // multi-valued filter (`?role=Admin&role=Viewer`), and collapsing them
    // would silently drop all but the last. This is also why the query string
    // is assembled here instead of being handed to `ApiClient` as the
    // `Record<string, QueryValue>` its `query` option takes — a Record cannot
    // represent a repeated key at all.
    query.append(key, value);
  }

  const body = await resolveRequestBody(options.data, ctx);

  if (body !== undefined && BODYLESS_METHODS.has(method)) {
    throw new UsageError(
      `${method} requests cannot carry a body. Use --query for parameters, or a method that takes one (POST, PUT, PATCH).`,
    );
  }

  // Credentials are resolved BEFORE the request, and their absence throws
  // AuthRequiredError with "run login" rather than sending `Authorization:
  // Bearer undefined` and relaying a 401 that blames the user's credentials
  // for not existing. See requireCredentials() in config.ts.
  //
  // There is deliberately NO `--server` or `--token` flag on this command.
  // The server and the credential are a PAIR — a PAT minted for one host is
  // worthless on another and must never be sent to it — and a flag that let
  // them be set independently would make leaking a token to the wrong host a
  // single typo away. Pointing at a different server is `login`, or the
  // APPCTL_SERVER_URL / APPCTL_TOKEN pair, which #143 resolves together.
  const credentials = requireCredentials(ctx);

  const client = new ApiClient({
    baseUrl: resolveApiBaseUrl(credentials.serverUrl),
    token: credentials.token,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });

  const queryString = query.toString();
  const requestPath = queryString.length > 0 ? `${path}?${queryString}` : path;

  // What the status line and the spinner say. `path` has had the `/api`
  // prefix stripped so it can be joined onto a base URL that already carries
  // one — an internal detail — and echoing THAT back would show the user a
  // path they did not type and that does not exist on the server. This puts
  // the prefix back, so what is reported is the real path on the wire.
  const displayPath = `${API_PATH_PREFIX}${path === '/' ? '' : path}${
    queryString.length > 0 ? `?${queryString}` : ''
  }`;

  const quiet = options.quiet === true;
  const raw = options.raw === true;

  // Progress belongs on stderr and only on a terminal — `createSpinner`
  // enforces the second half itself. Suppressed under `--quiet` for the case
  // where a caller merges the two streams (`2>&1`) and wants only the body.
  const stopSpinner = createSpinner(`${method} ${displayPath}`, { enabled: !quiet });

  const startedAt = Date.now();
  let response;
  try {
    // The body is spread in only when `--data` was actually given. This is not
    // cosmetic: `ApiClient.send` decides whether to send a payload AND whether
    // to set `Content-Type: application/json` on `options.body !== undefined`,
    // and Fastify 5 answers 400 to a request that declares a JSON content type
    // and then carries no body. So `{ body: undefined }` and no `body` key are
    // very different things here, and `exactOptionalPropertyTypes` is what
    // makes the compiler agree.
    //
    // A body of literal `null` (`--data null`) still counts as present and is
    // sent as the four bytes `null`, which is what the user asked for.
    response = await client.send<unknown>(method, requestPath, {
      ...(body === undefined ? {} : { body: body.value }),
    });
  } finally {
    // In a `finally` so a thrown ApiError cannot leave a half-drawn spinner
    // frame sitting in front of the error message program.ts is about to
    // print. This runs on the failure path far more often than on the success
    // one, which is exactly why it cannot live after the await.
    stopSpinner();
  }
  const durationMs = Date.now() - startedAt;

  if (!quiet) {
    process.stderr.write(
      formatStatusLine({ method, path: displayPath, status: response.status, durationMs }),
    );
  }

  writeBody(response.body, { raw, quiet, colourRequested: options.color });
}

/**
 * Write the response body to stdout.
 *
 * ---------------------------------------------------------------------------
 * WHAT GETS PRINTED: `response.body`, IN BOTH MODES. THE UNWRAPPED
 * `response.data` IS NEVER PRINTED. This is the one decision in #144 with a
 * real argument on both sides, so here is the whole of it.
 *
 * The API's TransformInterceptor wraps a handler's return value as
 * `{ data, meta: { timestamp } }` — but it PASSES THROUGH anything that
 * already carries a `data` key. A paginated endpoint returns
 * `{ data: [...], pagination: { total, page, pageSize } }` and is therefore
 * NEVER WRAPPED. `unwrapEnvelope` cannot tell those two cases apart (nothing
 * can, from the outside — they are the same shape), so unwrapping
 * `GET /api/users` yields the bare array and SILENTLY DISCARDS THE PAGE COUNT.
 *
 * THE CASE FOR PRINTING `data`: it is what a human wants. One less level of
 * nesting, no `meta.timestamp` noise on every single call.
 *
 * THE CASE FOR PRINTING `body`, which wins, on two grounds:
 *
 *   1. THE TWO MODES MUST AGREE. `--raw` must emit the server's own bytes —
 *      a script piping into `jq` wants the truth, not a client-side
 *      interpretation, and `ApiResponse.body` exists to carry exactly that.
 *      If the default mode unwrapped and `--raw` did not, then a user who
 *      explored an endpoint interactively and then wrote a `jq` filter against
 *      what they saw would have written it against a shape that does not
 *      exist in the pipe. They would debug the filter. The CLI would have lied
 *      to them, in the one mode where being trustworthy is the whole feature.
 *
 *   2. UNWRAPPING IS LOSSY AND INCONSISTENT — see the pagination case above.
 *      A generic API command that cannot show the total on `GET /api/users` is
 *      broken for the endpoint from #144's own examples. The envelope is cheap
 *      noise; the dropped page count is expensive silence. Between a mode that
 *      is slightly verbose and a mode that is quietly wrong, take verbose.
 *
 * `unwrapEnvelope` and `ApiResponse.data` remain right for TYPED callers —
 * `device-login.ts` asks for a `CurrentUser` and means it. They are wrong for
 * a passthrough, which is what this command is.
 * ---------------------------------------------------------------------------
 */
function writeBody(
  body: unknown,
  options: { raw: boolean; quiet: boolean; colourRequested: boolean },
): void {
  if (body === undefined) {
    // A 204, or any 2xx with an empty body — `DELETE /api/allowlist/{id}` and
    // `POST /api/auth/logout` both do this. NOTHING goes to stdout: the server
    // sent no bytes, so printing `null` would invent a value it never sent,
    // and `--raw > file.json` would produce a file whose content is a fiction.
    // An empty stdout is also correct for `jq`, which reads it as no input.
    if (!options.quiet) process.stderr.write('  (no response body)\n');
    return;
  }

  if (options.raw) {
    // Compact, one line, and NEVER coloured — `shouldUseColour` is not even
    // consulted here, so no FORCE_COLOR on any machine can inject escape
    // sequences into a pipeline (see the note in output.ts).
    //
    // The trailing newline is a LINE TERMINATOR, not extra output: a POSIX
    // text line ends with one, `jq` and every line-oriented tool expect it,
    // and omitting it leaves a shell prompt glued to the last brace. It is
    // also what makes `--raw` usable inside `while read`.
    process.stdout.write(`${JSON.stringify(body)}\n`);
    return;
  }

  const colour = shouldUseColour({
    requested: options.colourRequested,
    isTTY: process.stdout.isTTY === true,
    env: process.env,
  });

  process.stdout.write(`${formatJson(body, { colour })}\n`);
}

// -----------------------------------------------------------------------------
// Argument parsing and validation
// -----------------------------------------------------------------------------

/** commander's repeatable-option collector. */
function collectQuery(value: string, previous: string[] | undefined): string[] {
  return [...(previous ?? []), value];
}

export function parseMethod(raw: string): AllowedMethod {
  const method = raw.trim().toUpperCase();

  if ((ALLOWED_METHODS as readonly string[]).includes(method)) {
    return method as AllowedMethod;
  }

  throw new UsageError(
    `"${raw}" is not an HTTP method. Use one of: ${ALLOWED_METHODS.join(', ')}.`,
  );
}

/**
 * Validate the path and split any inline query string off it.
 *
 * The leading-slash requirement is #144's, and it earns its place: without it
 * `appctl api GET api/users` produces `https://host/apiapi/users` or a 404
 * depending on how the join lands, and the user is left staring at a path that
 * looks right.
 *
 * THE `/api` PREFIX IS OPTIONAL AND STRIPPED WHEN PRESENT. This is the subtle
 * one. `ApiClient`'s base URL ALREADY ends in `/api` (`resolveApiBaseUrl`
 * appends it, because the API sets it as a global prefix in main.ts), so
 * passing `/api/auth/me` through unchanged would request
 * `https://host/api/api/auth/me`. Fastify answers 404, and a 404 is read by
 * every human being as "that endpoint does not exist" — sending them to check
 * the endpoint, the docs, and their permissions, none of which are the
 * problem. Since #144's own examples all write the prefix, and the docs and
 * Swagger show it too, both forms must work. The match requires a segment
 * boundary, so a real endpoint at `/apikeys` is untouched.
 *
 * The inline query string is SPLIT AND MERGED rather than left in the path,
 * because `buildUrl` would otherwise append `?page=2` to a path that already
 * contained a `?` and produce a URL with two of them — which is not an error
 * anywhere, just silently wrong parsing on the server.
 */
export function parseRequestPath(raw: string): { path: string; query: URLSearchParams } {
  const trimmed = raw.trim();

  if (trimmed.length === 0) {
    throw new UsageError('A request path is required, for example /api/auth/me.');
  }

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    // A full URL is a reasonable thing to try, and accepting it would be
    // actively dangerous: the stored bearer token would be sent to whatever
    // host was typed. The server comes from the login that minted the token,
    // and only from there.
    throw new UsageError(
      `Pass a path, not a full URL: ${trimmed}. The server comes from your login (\`${CLI_NAME} config\` shows it).`,
    );
  }

  if (!trimmed.startsWith('/')) {
    throw new UsageError(`Path must start with "/": try /${trimmed.replace(/^\/+/, '')}`);
  }

  if (trimmed.includes('#')) {
    // A fragment is never transmitted to a server, so silently dropping it
    // would mean requesting something other than what was typed. In a shell it
    // is nearly always an unquoted `#` starting a comment instead.
    throw new UsageError(
      `Path contains "#", which is never sent to a server. Quote the argument if the character is part of the path.`,
    );
  }

  const questionMark = trimmed.indexOf('?');
  const rawPathPart = questionMark === -1 ? trimmed : trimmed.slice(0, questionMark);
  const rawQueryPart = questionMark === -1 ? '' : trimmed.slice(questionMark + 1);

  // `//users` collapses to `/users`: a doubled slash is a distinct path to
  // Fastify and answers 404, and it is what you get from naive string joining
  // upstream of this command.
  const normalisedSlashes = rawPathPart.replace(/^\/+/, '/');

  const path = stripApiPrefix(normalisedSlashes);

  return { path, query: new URLSearchParams(rawQueryPart) };
}

function stripApiPrefix(path: string): string {
  if (path === API_PATH_PREFIX) return '/';
  if (path.startsWith(`${API_PATH_PREFIX}/`)) return path.slice(API_PATH_PREFIX.length);
  return path;
}

/**
 * `key=value` → a pair.
 *
 * Split on the FIRST `=` only, so a value containing one (a base64 cursor, an
 * ISO timestamp, a filter expression) survives intact. Encoding is left to
 * `URLSearchParams`, which is the only thing that gets percent-encoding right
 * for every character without a hand-rolled table.
 */
export function parseQueryPair(pair: string): { key: string; value: string } {
  const separator = pair.indexOf('=');

  if (separator === -1) {
    throw new UsageError(
      `--query expects key=value, got "${pair}". For an empty value write ${pair}=.`,
    );
  }

  const key = pair.slice(0, separator);
  if (key.trim().length === 0) {
    throw new UsageError(`--query "${pair}" has an empty parameter name.`);
  }

  // The value is NOT trimmed: a trailing space can be meaningful in a search
  // term, and silently editing a user's query value is worse than passing it
  // through. The key is only trimmed for the emptiness check above.
  return { key, value: pair.slice(separator + 1) };
}

/**
 * `--timeout` in milliseconds.
 *
 * Validated rather than passed through as `Number(...)`, because `Number('30s')`
 * is `NaN`, and a `NaN` timeout reaches `AbortSignal.timeout` as an immediate
 * abort — the request would fail instantly with a timeout message for a value
 * the user believed was thirty seconds.
 */
function parseTimeout(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;

  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new UsageError(`--timeout must be a positive whole number of milliseconds, got "${raw}".`);
  }

  return value;
}
