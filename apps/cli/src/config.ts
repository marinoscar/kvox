import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { CLI_NAME, CONFIG_DIR_NAME, CONFIG_FILE_NAME, envVar } from './branding.js';
import { AuthRequiredError, ConfigError } from './errors.js';

// =============================================================================
// Credential and server-URL storage  (issue #143, epic #110)
// =============================================================================
//
// Three places a credential can come from, in this precedence order:
//
//   1. `APPCTL_TOKEN` / `APPCTL_SERVER_URL` in the environment
//   2. `~/.appctl/config.json`
//   3. nowhere — which is a first-class outcome, not an error to stumble into
//
// WHY THE ENVIRONMENT WINS. It is the only thing that makes the CLI usable in
// CI, and CI is the case with the least room to improvise: there is no
// browser to complete a device flow in, no TTY to prompt on, and no writable
// (or persistent) home directory to have logged in to earlier. Secrets arrive
// as environment variables because that is what every CI system provides, so
// the environment must be able to fully supply a credential with no file
// present at all. Putting the file first would mean a developer's stale
// personal token silently beating the pipeline's service token on a
// self-hosted runner — the kind of bug that only ever reproduces on the one
// machine nobody can debug on.
//
// WHY A `0600` FILE AND NOT AN OS KEYCHAIN. A keychain is genuinely better on
// a desktop and unavailable everywhere else this runs: it needs a native
// module (so a compiler, or a prebuilt for every platform), it has nothing to
// talk to in a container, and it fails over SSH where no session bus exists —
// which is precisely where a CLI gets used. A fallback would be required
// regardless, and it is the fallback that would end up carrying the traffic.
// See `writeConfigFile` for how `0600` is actually guaranteed, which is the
// part that is easy to get subtly, invisibly wrong.
//
// WHY NOT ENCRYPT THE FILE. The key would have to sit next to the ciphertext,
// which is not encryption, it is obfuscation with a maintenance cost. Issue
// #108 encrypts *server-side* secrets because a server has somewhere else to
// keep a key; a CLI on a laptop does not.
//
// THE TOKEN IS NEVER PRINTED BY ANYTHING IN THIS FILE. `describeConfig()` is
// the only display path and it cannot return the token — see `maskToken`.
// =============================================================================

/**
 * The shape persisted to `~/.appctl/config.json`.
 *
 * EVERY FIELD IS OPTIONAL AT READ TIME, deliberately. This file is on a user's
 * disk: it survives CLI upgrades, gets hand-edited, gets partially restored
 * from a backup, and gets written by a version that knew different fields. A
 * reader that demands a complete record turns any of that into a hard failure
 * for commands that did not need the missing piece. Completeness is asserted
 * where it is actually required — `requireCredentials()` — and nowhere else.
 */
export interface StoredConfig {
  /** What the user typed, e.g. `https://app.example.com`. NOT the `/api` root. */
  serverUrl?: string;
  /** The bearer credential. A `pat_...` token from the device flow (#141). */
  token?: string;
  /** Absolute ISO-8601 expiry of `token`, when the server told us one. */
  expiresAt?: string;
  /** PAT row id, so the user can find it in the web Access Tokens page. */
  tokenId?: string;
  /** PAT display name, same purpose. */
  tokenName?: string;
  /** When this file was last written, for `config` output. */
  updatedAt?: string;
  /**
   * The `worker_nodes` row this machine registered (#272, epic #254).
   *
   * Stored so a restart RE-ATTACHES to its existing node rather than leaking a
   * new row on every start — which is what a container without it would do,
   * once per crash-loop iteration.
   */
  nodeId?: string;
  /** Worker-node settings. Absent on every machine that never ran `node register`. */
  node?: StoredNodeConfig;
}

/**
 * The persisted half of a worker node's settings (#272).
 *
 * Every field optional for the same reason every field of `StoredConfig` is:
 * this file is on a user's disk and gets hand-edited, partially restored and
 * written by other versions. Defaults are applied in `node-config.ts`, once,
 * where the environment overlay is also applied.
 */
export interface StoredNodeConfig {
  name?: string;
  concurrency?: number;
  eligibleTypes?: string[];
  pollIntervalMs?: number;
}

/** Where a resolved field came from. Shown by `config`; used by diagnostics. */
export type ConfigSource = 'env' | 'file';

/** The merged view of environment and file, with nothing required. */
export interface ResolvedConfig {
  serverUrl: string | undefined;
  token: string | undefined;
  expiresAt: string | undefined;
  tokenId: string | undefined;
  tokenName: string | undefined;
  updatedAt: string | undefined;
  /** Which layer supplied each credential field, when one did. */
  serverUrlSource: ConfigSource | undefined;
  tokenSource: ConfigSource | undefined;
  /** Absolute path of the config file, whether or not it exists. */
  path: string;
  /** True when a readable config file was found. */
  fileExists: boolean;
}

/** A complete credential. Only `requireCredentials()` can produce one. */
export interface Credentials {
  serverUrl: string;
  token: string;
  expiresAt: string | undefined;
  serverUrlSource: ConfigSource;
  tokenSource: ConfigSource;
}

/**
 * Injection seam for tests and for a caller that must not read the real
 * environment. Everything in this module takes it as an optional last
 * argument and defaults to the real process — so production code never has to
 * thread it through, and a test never has to mutate `process.env` or
 * `os.homedir` globally (which leaks across test files and produces failures
 * that depend on execution order).
 */
export interface ConfigContext {
  env?: NodeJS.ProcessEnv;
  home?: string;
}

/** `APPCTL_SERVER_URL` — resolved once so help text and lookups cannot drift. */
export const SERVER_URL_ENV_VAR = envVar('SERVER_URL');

/** `APPCTL_TOKEN`. */
export const TOKEN_ENV_VAR = envVar('TOKEN');

function contextEnv(ctx: ConfigContext | undefined): NodeJS.ProcessEnv {
  return ctx?.env ?? process.env;
}

/** The config directory, `~/.appctl`. */
export function configDirPath(ctx?: ConfigContext): string {
  return join(ctx?.home ?? homedir(), CONFIG_DIR_NAME);
}

/** The config file, `~/.appctl/config.json`. */
export function configFilePath(ctx?: ConfigContext): string {
  return join(configDirPath(ctx), CONFIG_FILE_NAME);
}

/**
 * Read and validate the config file.
 *
 * Returns `undefined` when there is no file — an expected state, not an
 * error, and the reason ENOENT is the one errno swallowed here. Everything
 * else (EACCES on a file someone chowned, EISDIR on a path someone made a
 * directory) becomes a ConfigError naming the path, because those are real
 * problems that a silent `undefined` would convert into a misleading "not
 * logged in".
 */
export function readConfigFile(ctx?: ConfigContext): StoredConfig | undefined {
  const path = configFilePath(ctx);

  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException | null)?.code === 'ENOENT') return undefined;
    throw new ConfigError(
      `Could not read ${path}: ${(cause as Error).message}`,
      { cause },
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    // Naming the remedy matters more than naming the parse position. The file
    // is disposable — every field in it is re-obtainable by logging in again —
    // so "delete it and re-login" is always correct and always sufficient.
    throw new ConfigError(
      `${path} is not valid JSON. Delete it and run \`${CLI_NAME} login\` again.`,
      { cause },
    );
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ConfigError(
      `${path} does not contain a JSON object. Delete it and run \`${CLI_NAME} login\` again.`,
    );
  }

  const body = parsed as Record<string, unknown>;

  // Every field is read through `readString`, which drops anything that is not
  // a non-empty string. A `token: null` left behind by a hand-edit therefore
  // reads as "no token" and produces the run-login message, rather than being
  // sent to the server as the literal text `null` and coming back as a 401
  // that blames the user's credentials.
  return {
    ...optionalField('serverUrl', readString(body.serverUrl)),
    ...optionalField('token', readString(body.token)),
    ...optionalField('expiresAt', readString(body.expiresAt)),
    ...optionalField('tokenId', readString(body.tokenId)),
    ...optionalField('tokenName', readString(body.tokenName)),
    ...optionalField('updatedAt', readString(body.updatedAt)),
    ...optionalField('nodeId', readString(body.nodeId)),
    ...optionalField('node', readStoredNodeConfig(body.node)),
  };
}

/**
 * Read the `node` block, dropping anything of the wrong type.
 *
 * Same contract as `readString`: a hand-edited `concurrency: "4"` reads as
 * absent and the default applies, rather than propagating a string into
 * arithmetic and producing a claim limit of `NaN` — which the server would
 * reject with a validation error naming a field the user never set.
 */
function readStoredNodeConfig(value: unknown): StoredNodeConfig | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const body = value as Record<string, unknown>;

  const types = Array.isArray(body.eligibleTypes)
    ? body.eligibleTypes.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    : undefined;

  const block: StoredNodeConfig = {
    ...optionalField('name', readString(body.name)),
    ...optionalField('concurrency', readFiniteNumber(body.concurrency)),
    ...optionalField('eligibleTypes', types),
    ...optionalField('pollIntervalMs', readFiniteNumber(body.pollIntervalMs)),
  };

  return Object.keys(block).length > 0 ? block : undefined;
}

/** A finite number, or `undefined`. `NaN` and `Infinity` are not numbers a config may hold. */
function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Persist the config, replacing whatever was there.
 *
 * ---------------------------------------------------------------------------
 * HOW `0600` IS ACTUALLY GUARANTEED — the part with a trap in it
 * ---------------------------------------------------------------------------
 * The obvious implementation is `writeFileSync(path, json, { mode: 0o600 })`,
 * and it is WRONG in a way that never shows up in a passing test.
 *
 * `mode` is the mode passed to `open(2)`, and `open(2)` APPLIES IT ONLY WHEN
 * IT CREATES THE FILE. Writing over an existing `config.json` ignores `mode`
 * entirely and leaves whatever permissions the file already had. So the first
 * login on a clean machine produces a correct `0600` file and every test
 * asserting the mode passes — while a user whose config was ever created by
 * something else (an older build without the mode, a `cp` from a dotfiles
 * repo, an editor that rewrote it, a restore from an archive that dropped
 * modes) keeps a world-readable token forever, and re-running `login` does not
 * fix it because that is exactly the path that ignores the mode.
 *
 * The other obvious implementation — write, then `chmod` — closes that gap but
 * opens a window: between the write and the chmod the token is on disk under
 * the process umask, typically `0644`. On a shared machine that window is all
 * an attacker needs, and it is reopened on every single login. #143 asks for
 * the mode AT CREATION for precisely this reason.
 *
 * So: create a BRAND NEW file with `flag: 'wx'` (O_CREAT|O_EXCL — the open
 * fails rather than reusing anything, which makes `mode` unconditionally
 * apply), then `rename(2)` it over the target. Rename moves the inode, so the
 * destination ends up with the new file's `0600` no matter what the old one
 * had, and it is atomic within a filesystem — a crash or a full disk mid-write
 * leaves the previous config intact instead of a truncated file that reads as
 * corrupt. The temp file is created in the SAME DIRECTORY because `rename`
 * across filesystems fails with EXDEV, and `~` can easily be a different mount
 * from the system temp directory.
 *
 * ON UMASK: `mode` is masked by the process umask, and a umask can only CLEAR
 * permission bits, never set them. So `0o600 & ~umask` is at most `0o600` for
 * every possible umask — the file can end up more restrictive (a `0o077`
 * umask yields `0o600`, a `0o277` umask yields `0o400`) but never more
 * permissive. That one-directional property is what makes "no window where it
 * is world-readable" a guarantee rather than a hope.
 * ---------------------------------------------------------------------------
 */
export function writeConfigFile(config: StoredConfig, ctx?: ConfigContext): string {
  const dir = configDirPath(ctx);
  const target = configFilePath(ctx);

  // `0o700` on the directory is defence in depth, not the control: the file
  // mode above is what protects the token. Like the file, the mode applies
  // only on creation, and an existing directory is deliberately left alone —
  // silently chmod-ing a directory a user created themselves is a surprise,
  // and `~/.appctl` may legitimately hold other things by then.
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  const payload = `${JSON.stringify({ ...config, updatedAt: new Date().toISOString() }, null, 2)}\n`;

  // Randomised so two concurrent logins cannot collide on the temp name and
  // have one of them fail the O_EXCL open. The `.tmp` suffix keeps it clearly
  // disposable, and the basename deliberately stays derived from
  // CONFIG_FILE_NAME rather than being something like `credentials.tmp` — see
  // the note on CONFIG_FILE_NAME in branding.ts about globally-ignored names.
  const tmp = join(dir, `${CONFIG_FILE_NAME}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);

  try {
    writeFileSync(tmp, payload, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    renameSync(tmp, target);
  } catch (cause) {
    // Best-effort cleanup so a failed login does not litter `~/.appctl` with
    // temp files that each contain a valid token. `force` because the file may
    // never have been created (that is one of the ways we get here).
    try {
      rmSync(tmp, { force: true });
    } catch {
      // Nothing useful to do, and the real error below is the one to report.
    }
    throw new ConfigError(`Could not write ${target}: ${(cause as Error).message}`, { cause });
  }

  return target;
}

/**
 * Convenience for the one write both login paths perform (#142): store the
 * server URL and the credential together.
 *
 * Both paths go through here rather than each assembling a StoredConfig, so
 * there is one place that decides what a successful login persists.
 */
export function saveCredentials(
  input: {
    serverUrl: string;
    token: string;
    expiresAt?: string | undefined;
    tokenId?: string | undefined;
    tokenName?: string | undefined;
  },
  ctx?: ConfigContext,
): string {
  return writeConfigFile(
    {
      serverUrl: input.serverUrl,
      token: input.token,
      ...optionalField('expiresAt', input.expiresAt),
      ...optionalField('tokenId', input.tokenId),
      ...optionalField('tokenName', input.tokenName),
    },
    ctx,
  );
}

/** Remove the config file. No-op when there is none. For a future `logout`. */
export function deleteConfigFile(ctx?: ConfigContext): boolean {
  const path = configFilePath(ctx);
  try {
    statSync(path);
  } catch {
    return false;
  }
  rmSync(path, { force: true });
  return true;
}

/**
 * Merge environment over file. Never throws for "nothing configured".
 *
 * The merge is PER FIELD rather than all-or-nothing: `APPCTL_TOKEN` alone is a
 * legitimate way to run one command as a different principal against the
 * server already in the config file, and `APPCTL_SERVER_URL` alone is how you
 * point an existing login at a different host. Requiring both to be set to use
 * either would break both of those for no gain — and the case where a partial
 * environment is genuinely a mistake is caught with a specific message in
 * `requireCredentials()`, where the missing half is actually known.
 */
export function resolveConfig(ctx?: ConfigContext): ResolvedConfig {
  const env = contextEnv(ctx);
  const file = readConfigFile(ctx);

  const envServerUrl = readString(env[SERVER_URL_ENV_VAR]);
  const envToken = readString(env[TOKEN_ENV_VAR]);

  const serverUrl = envServerUrl ?? file?.serverUrl;
  const token = envToken ?? file?.token;

  return {
    serverUrl,
    token,
    // Expiry belongs to the token, so it is only meaningful when the token
    // came from the file. An `APPCTL_TOKEN` from CI has no expiry we know of,
    // and pairing it with the file's leftover `expiresAt` would let the CLI
    // announce that a perfectly valid pipeline token expired last week.
    expiresAt: envToken === undefined ? file?.expiresAt : undefined,
    tokenId: envToken === undefined ? file?.tokenId : undefined,
    tokenName: envToken === undefined ? file?.tokenName : undefined,
    updatedAt: file?.updatedAt,
    serverUrlSource: envServerUrl !== undefined ? 'env' : file?.serverUrl !== undefined ? 'file' : undefined,
    tokenSource: envToken !== undefined ? 'env' : file?.token !== undefined ? 'file' : undefined,
    path: configFilePath(ctx),
    fileExists: file !== undefined,
  };
}

/**
 * The accessor every authenticated command uses (#144 onwards).
 *
 * THE WHOLE POINT IS THE FAILURE MESSAGE. Without this, a command reads an
 * undefined token, sends `Authorization: Bearer undefined`, and reports the
 * server's 401 — telling a user who has never logged in that their
 * credentials were rejected. They were not rejected; they were never sent.
 * That message sends people to revoke and re-issue tokens that were never the
 * problem, and it is exactly the outcome #143 calls out.
 *
 * The three "nothing usable" cases get three different sentences, because
 * they have three different fixes:
 *   - a half-set environment: name the variable that is missing (a CI
 *     misconfiguration, where "run login" is useless advice — there is no
 *     browser on the runner)
 *   - no server URL: say so
 *   - no token: run `login`
 */
export function requireCredentials(ctx?: ConfigContext): Credentials {
  const resolved = resolveConfig(ctx);

  // Checked FIRST, before the generic messages, because "you set one of the
  // two variables" is a much more specific diagnosis than "not logged in" and
  // it is the single most likely way a pipeline is broken. Only reported when
  // the file cannot cover the gap — a developer with a config file who
  // exports one variable to override a single field is doing something
  // supported, not something broken.
  if (resolved.serverUrl === undefined && resolved.token !== undefined && resolved.tokenSource === 'env') {
    throw new AuthRequiredError(
      `${TOKEN_ENV_VAR} is set but ${SERVER_URL_ENV_VAR} is not, and no server URL is stored in ${resolved.path}. Set both, or run \`${CLI_NAME} login\`.`,
    );
  }

  if (resolved.token === undefined && resolved.serverUrl !== undefined && resolved.serverUrlSource === 'env') {
    throw new AuthRequiredError(
      `${SERVER_URL_ENV_VAR} is set but ${TOKEN_ENV_VAR} is not, and no token is stored in ${resolved.path}. Set both, or run \`${CLI_NAME} login\`.`,
    );
  }

  if (resolved.serverUrl === undefined || resolved.token === undefined) {
    throw new AuthRequiredError(
      `Not logged in. Run \`${CLI_NAME} login\` first, or set ${SERVER_URL_ENV_VAR} and ${TOKEN_ENV_VAR}.`,
    );
  }

  return {
    serverUrl: resolved.serverUrl,
    token: resolved.token,
    expiresAt: resolved.expiresAt,
    // Both sources are known to be defined here: a field cannot have a value
    // and no source. The non-null assertions state that rather than inventing
    // a fallback that would be a lie if it ever ran.
    serverUrlSource: resolved.serverUrlSource!,
    tokenSource: resolved.tokenSource!,
  };
}

// -----------------------------------------------------------------------------
// Display
// -----------------------------------------------------------------------------

/** What replaces the unreadable part of a token. Matches #115's credential store. */
const HINT_MASK = '••••••••';

/**
 * How many leading characters of a `pat_` token are shown.
 *
 * EIGHT, and it is the LEADING characters — which is the opposite of #115's
 * credential hints, on purpose. Two reasons, both specific to this token kind:
 *
 *   1. Those eight characters are ALREADY PUBLIC by the API's own design.
 *      `PatService` stores `tokenPrefix = 'pat_' + the first 4 hex characters`
 *      as a separate, non-secret column and `GET /api/pat` returns it. So the
 *      hint reveals nothing that the Access Tokens page does not already show
 *      the same user.
 *
 *   2. It is the only hint that does the job. A hint exists so a user can
 *      match what is on their machine against a row in the web UI and know
 *      which one to revoke — and the string the web UI displays is exactly
 *      this prefix. Revealing the last four characters instead would expose
 *      four genuinely secret bytes and still not match anything on screen.
 *
 * A token that is not a PAT (a session JWT supplied through the environment)
 * gets NOTHING revealed: its leading characters are the base64 of a constant
 * JOSE header, identical for every token ever issued, so revealing them would
 * be a useless hint — and "useless" is not a reason to start revealing bytes
 * of a credential.
 */
const PAT_PREFIX_HINT_LENGTH = 8;

/** Below this, reveal nothing: the prefix would be most of the value. */
const MIN_LENGTH_TO_REVEAL = 16;

/**
 * Turn a token into something safe to print.
 *
 * THIS FUNCTION CAN NEVER RETURN THE TOKEN. Every branch either returns a
 * constant mask or a slice bounded by PAT_PREFIX_HINT_LENGTH, which is checked
 * against MIN_LENGTH_TO_REVEAL first — so there is no input, including an
 * empty string or a hand-crafted short value, for which the output equals the
 * input. That property is the whole contract; anything added here must
 * preserve it.
 */
export function maskToken(token: string | undefined): string {
  if (token === undefined || token.length === 0) return '(none)';
  if (token.startsWith('pat_') && token.length >= MIN_LENGTH_TO_REVEAL) {
    return `${token.slice(0, PAT_PREFIX_HINT_LENGTH)}${HINT_MASK}`;
  }
  return HINT_MASK;
}

/** A display-safe summary. Structurally incapable of carrying the token. */
export interface ConfigSummary {
  serverUrl: string | undefined;
  serverUrlSource: ConfigSource | undefined;
  /** Masked. See `maskToken` — this field never holds a usable credential. */
  tokenHint: string;
  tokenSource: ConfigSource | undefined;
  tokenName: string | undefined;
  tokenId: string | undefined;
  expiresAt: string | undefined;
  /** True when `expiresAt` is in the past. `undefined` when there is no expiry. */
  expired: boolean | undefined;
  updatedAt: string | undefined;
  path: string;
  fileExists: boolean;
}

/**
 * Build the summary a `config` command prints.
 *
 * The return type is the enforcement mechanism, not a convention: there is no
 * field on ConfigSummary that a token could be assigned to without a type
 * error, so a future edit cannot casually add one to the output. A function
 * returning `Record<string, unknown>` would have made "never print the token"
 * a rule somebody has to remember.
 */
export function describeConfig(ctx?: ConfigContext, now: Date = new Date()): ConfigSummary {
  const resolved = resolveConfig(ctx);
  return {
    serverUrl: resolved.serverUrl,
    serverUrlSource: resolved.serverUrlSource,
    tokenHint: maskToken(resolved.token),
    tokenSource: resolved.tokenSource,
    tokenName: resolved.tokenName,
    tokenId: resolved.tokenId,
    expiresAt: resolved.expiresAt,
    expired: isExpired(resolved.expiresAt, now),
    updatedAt: resolved.updatedAt,
    path: resolved.path,
    fileExists: resolved.fileExists,
  };
}

/**
 * Has the stored token expired?
 *
 * `undefined` means UNKNOWN, and is returned both when no expiry was recorded
 * and when the recorded one is unparseable. It deliberately does not collapse
 * to `false`: a caller that wants to warn should not warn on a value it could
 * not read, and a caller that wants to block must not treat "I cannot tell"
 * as "it is fine". The server remains the authority either way — this is a
 * courtesy check so the CLI can say "your token expired, run login" instead of
 * relaying a bare 401.
 */
export function isExpired(expiresAt: string | undefined, now: Date = new Date()): boolean | undefined {
  if (expiresAt === undefined) return undefined;
  const parsed = Date.parse(expiresAt);
  if (Number.isNaN(parsed)) return undefined;
  return parsed <= now.getTime();
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/**
 * A non-empty string, or `undefined`.
 *
 * Empty and whitespace-only both become `undefined` because that is what they
 * mean in practice: `APPCTL_TOKEN=` in a CI file is an UNSET variable that the
 * shell happens to export as empty, and treating it as a credential produces
 * `Authorization: Bearer ` — a malformed header and a 401 whose message tells
 * the user their token was rejected rather than that it was blank.
 */
function readString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * `{ key: value }` when defined, `{}` when not.
 *
 * Required by `exactOptionalPropertyTypes`, which is on for this package: it
 * makes `{ expiresAt: undefined }` a type error where `expiresAt?: string` is
 * declared, precisely so that "absent" and "explicitly nothing" cannot be
 * confused. It also keeps the written JSON clean — `JSON.stringify` drops
 * undefined values, but only after they have been allowed into the object.
 */
function optionalField<K extends string, V>(
  key: K,
  value: V | undefined,
): Record<K, V> | Record<string, never> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}
