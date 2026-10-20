// =============================================================================
// The hosts the Copilot runtime contacts (issue #630)
// =============================================================================
//
// ONE source for a host that allowlists outbound traffic (KVox Desktop's egress
// allowlist, a corporate proxy rule, a firewall).
//
// HOW THIS LIST WAS BUILT, honestly:
//
//   • NOT measured on the wire. No traffic capture was made against a signed-in
//     runtime. Every entry below is INFERRED from static strings in the
//     Copilot runtime that `@github/copilot-sdk@1.0.22` ships (the
//     `@github/copilot-sdk-linux-x64@1.0.22` package, runtime 1.0.98:
//     `prebuilds/linux-x64/runtime.node`), plus the SDK's own typings.
//   • A string in the binary proves the runtime CAN contact a host, not that it
//     does so for the calls KVox makes. Treat the list as the allowlist to start
//     from, and confirm it with a capture on the platforms you ship (Linux and
//     Windows) before you tighten a firewall to it.
//   • The Windows and macOS runtimes were not inspected.
//
// What the same inspection did NOT find: any dedicated telemetry host. The
// runtime has an OpenTelemetry exporter (`telemetry.endpoint`, `telemetry.*`
// settings) whose endpoint is whatever the user or the host configures, so it
// contacts nothing of its own unless one is set; and "session telemetry" for
// GitHub-authenticated sessions, for which the spike (SPIKE.md) found no
// documented off switch. Where that goes is not stated in the SDK; it is
// inferred to be one of the hosts below, so the egress allowlist is the control.
//
//   • The three per-plan API hosts follow from a mechanism, not from a string
//     for each host: the runtime reads `endpoints.api` from the signed-in
//     account's `copilot_internal/user` answer, so the host depends on the plan
//     (individual, business, enterprise). The three hostnames come from issue
//     #646 (the model listing was refused in KVox Desktop without them); they
//     are not strings read from the runtime.
// =============================================================================

/**
 * The hosts the GitHub Copilot runtime (`@github/copilot-sdk` 1.0.22, runtime
 * 1.0.98) may contact while it is signed in and serving a call, for a host to
 * allowlist from one source. Plain hostnames, no scheme, no wildcard.
 *
 * @remarks
 * INFERRED from the runtime's static strings, NOT measured on the wire (see the
 * header of this file). Each entry says what it is for and how sure we are.
 * Not on the list, deliberately: a GitHub Enterprise Cloud tenant's own
 * `*.ghe.com` hosts (the runtime supports them; a host that serves such tenants
 * adds its tenant host), and any OpenTelemetry endpoint the host itself
 * configures.
 *
 * @example
 * ```ts
 * for (const host of COPILOT_EGRESS_HOSTS) allowOutbound(host);
 * ```
 *
 * @stability experimental
 */
export const COPILOT_EGRESS_HOSTS: readonly string[] = Object.freeze([
  // Model traffic: chat completions and the model listing of the Copilot API.
  // Inferred from the runtime's strings ("https://api.githubcopilot.com"); that
  // is only the DEFAULT base, used before an account is known. A signed-in
  // account is served from its own plan host (the next three entries).
  'api.githubcopilot.com',

  // The API host of an individual plan (Copilot Free, Pro, Pro+). A signed-in
  // runtime takes its API base from `endpoints.api` in the account's answer from
  // `api.github.com/copilot_internal/user`; the strings `endpoints.api`,
  // `endpoints.proxy` and `endpoints.telemetry` are in 1.0.98. Without this host
  // the model listing and every call are refused (seen in KVox Desktop).
  'api.individual.githubcopilot.com',

  // The `endpoints.api` host of a Copilot Business account. Inferred from the
  // same mechanism; the host name follows the individual one.
  'api.business.githubcopilot.com',

  // The `endpoints.api` host of a Copilot Enterprise account. Inferred likewise.
  // Not listed, deliberately: the `endpoints.proxy` hosts (`proxy.*.githubcopilot.com`,
  // inline completions, which KVox never uses) and the `endpoints.telemetry`
  // hosts (KVox sends no telemetry). Exact hostnames, no wildcards.
  'api.enterprise.githubcopilot.com',

  // Sign-in. The device flow posts to `/login/device/code` and polls
  // `/login/oauth/access_token` (both strings are in the runtime); the user
  // opens `github.com/login/device` in a browser. Also the base of most of the
  // runtime's GitHub links. Inferred.
  'github.com',

  // Account and entitlement calls (`/copilot_internal/...`, the token exchange
  // `copilot_token`, user and managed-settings lookups). Inferred.
  'api.github.com',
]);
