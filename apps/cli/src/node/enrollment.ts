import { hostname, platform, release, userInfo } from 'node:os';

import { ApiError, CliError, EXIT, type ExitCode } from '../errors.js';
import { CLI_NAME } from '../branding.js';
import { CLI_VERSION } from '../package-info.js';
import { runDeviceLogin, type DeviceLoginOptions, type DeviceLoginResult } from '../device-login.js';
import { HttpNodeApi, type NodeApi, type NodeCredentialApi, type RegisterNodeResult } from './node-api.js';
import {
  assertConcurrency,
  assertKnownTypes,
  defaultNodeName,
  saveNodeConfig,
  saveNodeCredentials,
  type NodeConfig,
  type ResolveNodeConfigOptions,
} from './node-config.js';

// =============================================================================
// `node register` and `node enroll`  (issue #273, epic #254)
// =============================================================================
//
// Getting a worker onto a machine used to be six steps and a copy-paste of a
// secret: log in, find the settings page, create a credential, copy it, put it
// in a config file, register. The copy-paste is the step people do badly — it
// ends up in shell history, in a paste buffer, in a chat message.
//
// `enroll` collapses all six. It runs THE EXISTING device-authorization flow
// (the same one `appctl login` uses — not a second implementation), then uses
// that short-lived session to mint a `nod_` credential and stores it directly.
// The operator never sees the secret unless they ask for it with
// `--show-token`, which stays available for the genuine case of provisioning a
// second machine.
//
// -----------------------------------------------------------------------------
// WHY `register` STAYS A SEPARATE COMMAND
// -----------------------------------------------------------------------------
//
// A container that already HAS a token must register without a browser, and
// headless start depends on that path existing. Folding registration into
// enroll would make a browser a prerequisite for a fleet.
//
// -----------------------------------------------------------------------------
// WHY NOT JUST REUSE THE PAT
// -----------------------------------------------------------------------------
//
// A PAT carries the owner's FULL authority. Handing that to an unattended
// process that runs for months on a machine in someone's rack is exactly what
// `nod_` exists to avoid: a node credential is refused on every route outside
// `/api/nodes/*`, including the route that mints credentials, so a compromised
// worker cannot escalate or mint a second identity (#267).
//
// EVERYTHING HERE IS UI-FREE AND DEPENDENCY-INJECTED — the login function, the
// API factory and the config writer are all parameters. That is what makes
// both flows unit-testable with no network, no browser and no real home
// directory, and it is what lets #279's TUI call the same functions the
// commands call rather than reimplementing them.
// =============================================================================

/**
 * The server predates node credentials.
 *
 * A typed error rather than a bare 404, because the remedy is specific and a
 * stack trace about a missing route does not suggest it: the operator can
 * create a PAT by hand and set the token variable, and their fleet works today
 * while the server is upgraded.
 */
export class NodeCredentialsUnsupportedError extends CliError {
  readonly exitCode: ExitCode = EXIT.PRECONDITION;

  constructor(serverUrl: string) {
    super(
      `${serverUrl} does not support node credentials (POST /api/node-credentials returned 404). ` +
        `Upgrade the server, or fall back to a personal access token: create one in the web UI, ` +
        `run \`${CLI_NAME} login --token <pat>\`, then \`${CLI_NAME} node register\`. ` +
        `A PAT works, but it carries your full account authority — a node credential does not.`,
    );
  }
}

/** Machine facts the server records on the node row. */
export interface MachineInfo {
  hostname: string;
  platform: string;
  cliVersion: string;
}

/** Read once, here, so `register` and `doctor` cannot report different platforms. */
export function readMachineInfo(): MachineInfo {
  let host: string;
  try {
    host = hostname();
  } catch {
    host = 'unknown-host';
  }
  return {
    hostname: host,
    platform: `${platform()} ${release()}`,
    cliVersion: CLI_VERSION,
  };
}

/** A credential name an operator can match to a machine in the web UI. */
export function defaultCredentialName(): string {
  let user: string;
  try {
    user = userInfo().username;
  } catch {
    // Containers running as an arbitrary uid have no passwd entry. Degrade
    // rather than fail enrollment over a label.
    user = 'node';
  }
  let host: string;
  try {
    host = hostname();
  } catch {
    host = 'unknown-host';
  }
  return `${CLI_NAME} node: ${user}@${host}`;
}

// -----------------------------------------------------------------------------
// register
// -----------------------------------------------------------------------------

export interface RegisterNodeOptions {
  api: NodeApi;
  /** The settings to register with. Already defaulted by `resolveNodeConfig`. */
  node: NodeConfig;
  capabilities?: Record<string, unknown> | undefined;
  machine?: MachineInfo | undefined;
  /** Persist the returned node id. Injected so a test writes nowhere. */
  save?: ((nodeId: string, node: NodeConfig) => void) | undefined;
  configContext?: ResolveNodeConfigOptions | undefined;
  /**
   * Skip the round trip that validates `--types`. `node start` sets this: the
   * server re-checks every claim against its own registry anyway, so the
   * client-side check is usability, not enforcement, and a start must not fail
   * because `job-types` was briefly unavailable.
   */
  validateTypes?: boolean | undefined;
}

export interface RegisterOutcome extends RegisterNodeResult {
  /** Where the node id was persisted, when it was. */
  configPath?: string | undefined;
}

/**
 * Register (or re-attach) this machine as a worker node.
 *
 * IDEMPOTENT BY CONSTRUCTION: the server keys on `(owner, name)` and reattaches
 * rather than creating a second row. This function reports WHICH happened
 * instead of flattening the two — an operator who expected a new node and got a
 * reattach has a name collision to resolve, and would never discover it from a
 * uniform "ok".
 */
export async function registerNode(options: RegisterNodeOptions): Promise<RegisterOutcome> {
  const machine = options.machine ?? readMachineInfo();
  assertConcurrency(options.node.concurrency);

  if (options.validateTypes !== false && options.node.eligibleTypes.length > 0) {
    const advertised = await options.api.jobTypes();
    assertKnownTypes(
      options.node.eligibleTypes,
      advertised.map((entry) => entry.type),
    );
  }

  const result = await options.api.register({
    name: options.node.name,
    hostname: machine.hostname,
    platform: machine.platform,
    cliVersion: machine.cliVersion,
    eligibleTypes: options.node.eligibleTypes,
    concurrency: options.node.concurrency,
    ...(options.capabilities !== undefined ? { capabilities: options.capabilities } : {}),
  });

  if (options.save !== undefined) {
    options.save(result.node.id, options.node);
    return result;
  }

  const configPath = saveNodeConfig(
    { nodeId: result.node.id, node: options.node },
    // A container with a read-only home must still be able to register: the
    // node id it could not persist is available through the environment.
    { ...(options.configContext ?? {}), degradeOnFailure: true },
  );

  return { ...result, ...(configPath !== undefined ? { configPath } : {}) };
}

// -----------------------------------------------------------------------------
// enroll
// -----------------------------------------------------------------------------

export interface EnrollOptions {
  serverUrl: string;
  /** The name the `nod_` credential gets in the web UI. */
  credentialName?: string | undefined;
  /** Optional expiry. Omitted means never — the epic's locked decision. */
  expiresInDays?: number | undefined;
  /** Test seam: replaces the device-authorization login. */
  login?: ((options: DeviceLoginOptions) => Promise<DeviceLoginResult>) | undefined;
  /** Test seam: builds the credential-minting client from the session token. */
  createCredentialApi?: ((serverUrl: string, token: string) => NodeCredentialApi) | undefined;
  /** Test seam: replaces the config write. */
  save?: ((token: string, credential: { id: string; name: string; expiresAt: string | null }) => string) | undefined;
  configContext?: ResolveNodeConfigOptions | undefined;
  hooks?: DeviceLoginOptions['hooks'] | undefined;
  openBrowser?: boolean | undefined;
  signal?: AbortSignal | undefined;
}

export interface EnrollResult {
  credentialId: string;
  credentialName: string;
  tokenPrefix: string;
  expiresAt: string | null;
  /** The `nod_` secret. Printed ONLY behind `--show-token`. */
  token: string;
  configPath: string;
}

/**
 * One command from "nothing installed" to "this machine holds a node credential".
 *
 * Note what is NOT here: any registration. Enroll establishes the machine's
 * IDENTITY; `register` establishes its node ROW, and they are separable because
 * a container image bakes in neither and is handed the credential at run time.
 */
export async function enrollNode(options: EnrollOptions): Promise<EnrollResult> {
  const login = options.login ?? runDeviceLogin;

  const session = await login({
    serverUrl: options.serverUrl,
    ...(options.hooks !== undefined ? { hooks: options.hooks } : {}),
    ...(options.openBrowser !== undefined ? { openBrowser: options.openBrowser } : {}),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  });

  const credentialApi =
    options.createCredentialApi?.(options.serverUrl, session.credential.accessToken) ??
    HttpNodeApi.create(options.serverUrl, session.credential.accessToken);

  const name = options.credentialName ?? defaultCredentialName();

  let credential;
  try {
    credential = await credentialApi.createCredential({
      name,
      ...(options.expiresInDays !== undefined ? { expiresInDays: options.expiresInDays } : {}),
    });
  } catch (error) {
    // 404 is the ONE status with a different meaning here. Everything else —
    // 403 (the account lacks `nodes:write`), 400, a network failure — already
    // carries a message that names the real problem.
    if (error instanceof ApiError && error.status === 404) {
      throw new NodeCredentialsUnsupportedError(options.serverUrl);
    }
    throw error;
  }

  const configPath =
    options.save?.(credential.token, credential) ??
    saveNodeCredentials(
      {
        serverUrl: options.serverUrl,
        token: credential.token,
        // Explicitly forwarded, INCLUDING when it is null — that is what
        // clears a previous PAT's expiry. See `saveNodeCredentials`.
        expiresAt: credential.expiresAt,
        tokenId: credential.id,
        tokenName: credential.name,
      },
      options.configContext,
    );

  return {
    credentialId: credential.id,
    credentialName: credential.name,
    tokenPrefix: credential.tokenPrefix,
    expiresAt: credential.expiresAt,
    token: credential.token,
    configPath,
  };
}

/** The default node name, re-exported so commands need one import. */
export { defaultNodeName };
