// =============================================================================
// Public surface of the CLI package  (issue #140, epic #110)
// =============================================================================
//
// Separate from `cli.ts` on purpose. `cli.ts` is the executable: it parses
// argv, writes to stderr and sets an exit code, and importing it should never
// be a way to get at the client. This module is the importable half — the
// pieces #141–#145 build on, and the pieces tests exercise directly.
// =============================================================================

export {
  API_PATH_PREFIX,
  CLI_DISPLAY_NAME,
  CLI_NAME,
  CONFIG_DIR_NAME,
  CONFIG_FILE_NAME,
  ENV_PREFIX,
  envVar,
} from './branding.js';

export { CLI_VERSION } from './package-info.js';

export {
  ApiClient,
  DEFAULT_TIMEOUT_MS,
  buildUrl,
  resolveApiBaseUrl,
  unwrapEnvelope,
} from './api-client.js';
export type {
  ApiClientOptions,
  ApiResponse,
  FetchLike,
  QueryValue,
  RequestOptions,
} from './api-client.js';

export { buildProgram, run } from './program.js';
export type { RunOptions } from './program.js';

// The TTY GATE ONLY — never `startTui`, and never anything else from
// `src/tui/`. Re-exporting the ink app here would put a reconciler on the
// import graph of every consumer of this module, including `program.ts`, which
// is precisely the coupling #145's gate exists to prevent. The gate itself is
// a pure predicate over two streams and an environment, imports neither react
// nor ink, and is the piece worth testing exhaustively — so it is the piece
// exported. Reach the app through `await import('./tui/index.js')`, as
// `program.ts` does.
export { NO_TUI_ENV_VAR, evaluateTuiGate } from './tui/tty.js';
export type { TtyContext, TuiGateDecision, TuiRefusal } from './tui/tty.js';

// The terminal-restore safety net, for the same reason: it is plain Node stream
// handling with no ink import, and "Ctrl-C leaves the terminal usable" is one
// of #145's stated acceptance properties, so it has to be reachable from a test.
export { installTerminalRestore, restoreTerminal } from './tui/terminal.js';
export type { TerminalRestoreContext } from './tui/terminal.js';

// The generic `api` command (#144). The two parsers are exported because they
// are the local-validation half of the command — a bad method, a path without
// a leading slash, a malformed --query — and they are pure functions, so they
// are exercised directly rather than through a spawned process.
export {
  ALLOWED_METHODS,
  BODYLESS_METHODS,
  parseMethod,
  parseQueryPair,
  parseRequestPath,
  registerApiCommand,
} from './commands/api.js';
export type { AllowedMethod } from './commands/api.js';

// Rendering, kept separate from the command so #145's TUI reuses the JSON
// formatter and the colour decision without inheriting the stdout writes.
export { createSpinner, formatJson, formatStatusLine, shouldUseColour } from './output.js';
export type { ColourDecisionInput, FormatJsonOptions } from './output.js';

export { resolveRequestBody } from './request-body.js';
export type { BodyResolutionContext, BodySourceKind, ResolvedBody } from './request-body.js';

export {
  SERVER_URL_ENV_VAR,
  TOKEN_ENV_VAR,
  configDirPath,
  configFilePath,
  deleteConfigFile,
  describeConfig,
  isExpired,
  maskToken,
  readConfigFile,
  requireCredentials,
  resolveConfig,
  saveCredentials,
  writeConfigFile,
} from './config.js';
export type {
  ConfigContext,
  ConfigSource,
  ConfigSummary,
  Credentials,
  ResolvedConfig,
  StoredConfig,
} from './config.js';

export {
  DEVICE_POLL_ERROR_CODES,
  DeviceLoginError,
  MAX_POLL_INTERVAL_SECONDS,
  POLL_MARGIN_MS,
  SLOW_DOWN_INCREMENT_SECONDS,
  UNCLASSIFIED_POLL_POLICY,
  classifyPollFailure,
  pollForDeviceToken,
  pollOnce,
  requestDeviceCode,
} from './device-auth.js';
export type {
  DeviceCodeGrant,
  DeviceCredential,
  DeviceLoginFailureReason,
  DevicePollErrorCode,
  DevicePollSignal,
  DevicePollState,
  PollForTokenOptions,
} from './device-auth.js';

// The reusable half of `login`, which #145's TUI drives directly.
export {
  completeLogin,
  defaultDeviceName,
  runDeviceLogin,
  validateToken,
} from './device-login.js';
export type {
  CompleteLoginInput,
  CompleteLoginResult,
  CurrentUser,
  DeviceLoginHooks,
  DeviceLoginOptions,
  DeviceLoginResult,
} from './device-login.js';

export { openInBrowser } from './browser.js';
export type { BrowserOpenResult } from './browser.js';

export { canPrompt, prompt, promptForServerUrl } from './prompt.js';
export type { PromptContext } from './prompt.js';

export {
  ApiError,
  AuthRequiredError,
  CliError,
  ConfigError,
  EXIT,
  NetworkError,
  UsageError,
  exitCodeFor,
  extractServerMessage,
  formatError,
} from './errors.js';
export type { ApiErrorFields, ExitCode, NetworkFailureKind } from './errors.js';

// ---------------------------------------------------------------------------
// Deployment (epic #168)
// ---------------------------------------------------------------------------
// The foundations the deploy pipelines are built from (#173). Exported because
// they are the parts with behaviour worth exercising directly: the executor's
// line assembly and exit-code handling, the journal's redaction, and the state
// file's read/write contract. `DeployHooks` is exported because it is the seam
// the subcommands and the ink screens both render.
export {
  CommandFailedError,
  describeFailure,
  runCommand,
  stripAnsi,
} from './deploy/executor.js';
export type {
  CommandResult,
  OutputStream,
  RunCommandOptions,
} from './deploy/executor.js';

export { createRedactor, openJournal, pruneOldRuns, timestampSlug } from './deploy/journal.js';
export type { Journal, OpenJournalOptions, Redactor, SecretEntry } from './deploy/journal.js';

export {
  DEPLOY_STATE_FILENAME,
  DEPLOY_STATE_VERSION,
  DeployStateError,
  NotInstalledError,
  deployStatePath,
  readState,
  requireState,
  writeState,
} from './deploy/state.js';
export type { DeployState } from './deploy/state.js';

export type { DeployHooks, StepOutcome, StepResult } from './deploy/hooks.js';

// The wizard's questions come from infra/compose/.env.example rather than a
// hardcoded list (#174) - the property that keeps this CLI correct in a fork
// that adds, removes or renames variables. Exported because the parsers and
// validators are pure and are exercised directly.
export {
  diffEnv,
  parseEnvExample,
  parseEnvFile,
  serializeEnvFile,
  stripInlineComment,
  unquote,
} from './deploy/env-spec.js';
export type { EnvDiff, EnvVarSpec } from './deploy/env-spec.js';

export {
  ENV_METADATA,
  generateBase64Key,
  metadataFor,
  validateBase64Key32,
  validateEmail,
  validatePort,
} from './deploy/env-metadata.js';
export type { DeriveContext, EnvGroup, EnvVarMetadata } from './deploy/env-metadata.js';

// The wizard, and the three prompt primitives it needed (#175). `confirm`,
// `promptSecret` and `select` live in prompt.ts beside the one-question helper
// the login flow already used.
export { confirm, promptSecret, select } from './prompt.js';
export type { SelectChoice } from './prompt.js';

export { runEnvWizard } from './deploy/env-wizard.js';
export type {
  WizardOptions,
  WizardResult,
  WizardSummaryRow,
} from './deploy/env-wizard.js';

// The LOCAL half of that same wizard (#344): `appctl init` bootstraps a fresh
// checkout by pointing the deploy machinery at this machine instead of a VPS.
// Exported because the profile is pure - the metadata resolver, the spec
// adjustments and the next-step rendering are all decidable without a
// filesystem.
export { runInit, formatNextSteps } from './init/run-init.js';
export type { InitOptions, InitResult } from './init/run-init.js';
export {
  BLANK_OK_KEYS,
  COMPOSE_DB_HOST,
  ENV_FILE_RELATIVE_PATH,
  ENV_TEMPLATE_RELATIVE_PATH,
  GENERATED_KEYS,
  PROMPTED_KEYS,
  REQUIRED_TO_RUN,
  callbackUrlFor,
  findRepoRoot,
  isComposeInternalHost,
  localMetadataFor,
  localSpecs,
  unattendedLocalAnswers,
} from './init/local-profile.js';

// The doctor check registry (#176). One ordered list: `doctor` renders it and
// install/update run its `required` subset as preflight, rather than each
// keeping a second list that drifts.
export {
  ALL_CHECKS,
  HOST_CHECKS,
  checksPassed,
  isLoopbackPortFree,
  isPortListening,
  requiredChecks,
  runChecks,
  summarise,
} from './deploy/checks/index.js';
export type {
  Check,
  CheckContext,
  CheckFs,
  CheckResult,
  CheckStatus,
  CheckSummary,
  CompletedCheck,
} from './deploy/checks/index.js';

// Working out what to deploy without naming a repository (#179) - the other
// half of the template-safety property, alongside the env spec.
export {
  displayRepoUrl,
  ensureCheckout,
  findGitRoot,
  hasEmbeddedCredentials,
  normaliseRepoUrl,
  resolveRepoTarget,
} from './deploy/repo.js';
export type {
  CheckoutOptions,
  CheckoutResult,
  RepoTarget,
  ResolveRepoOptions,
} from './deploy/repo.js';

// Publishing the app through the shared host proxy (#181). The rollback in
// installVhost is the reason this is a module and not a writeFileSync at the
// call site: the proxy is shared, so a bad vhost breaks every site on the box.
export {
  assertValidDomain,
  certificateStatus,
  installVhost,
  issueCertificate,
  livePath,
  reloadProxy,
  removeVhost,
  renderVhost,
  validateProxy,
  vhostPath,
} from './deploy/proxy.js';
export type {
  CertInfo,
  CertificateOptions,
  InstallVhostResult,
  ProxyOptions,
  ProxyTarget,
  ValidationResult,
} from './deploy/proxy.js';

// Health and the `status` command (#183). waitForHealthy is shared by install
// and update rather than reimplemented in each.
export {
  collectHealth,
  containerStates,
  describeFetchFailure,
  isHealthy,
  migrationState,
  probe,
  waitForHealthy,
} from './deploy/health.js';
export type {
  ContainerState,
  HealthOptions,
  HealthReport,
  MigrationState,
  ProbeResult,
  WaitOptions,
} from './deploy/health.js';

export { registerDeployCommand, renderHealth, renderResult, renderSummary } from './commands/deploy.js';
export type { DeployContext, DoctorReport } from './commands/deploy.js';

// The install pipeline (#180). Steps are DATA so the --skip flags, --resume,
// and the TUI's progress view all read one sequence.
export { runPipeline } from './deploy/steps/pipeline.js';
export type { DeployStep, PipelineResult, StepContext } from './deploy/steps/pipeline.js';

export {
  buildInstallSteps,
  composeArgv,
  composeCwd,
  defaultRootFor,
  runInstall,
  secretsFrom,
} from './deploy/install.js';
export type { InstallOptions, InstallResult } from './deploy/install.js';

// The update pipeline (#182). Its preconditions are the opposite of install's,
// which is why it is its own command rather than a flag.
export { buildUpdateSteps, runUpdate } from './deploy/update.js';
export type { UpdateOptions, UpdateResult } from './deploy/update.js';
