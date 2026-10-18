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
// GitHub-authenticated sessions, which the SDK types document as ON unless the
// session sets `enableSessionTelemetry: false`. Where that goes is not stated
// in the SDK; it is inferred to be one of the hosts below. The transport should
// pass `enableSessionTelemetry: false` where it can.
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
  // Inferred from the runtime's strings ("https://api.githubcopilot.com"); the
  // individual-plan and business-plan variants of this host (proxy.*,
  // api.business.*) were NOT found in 1.0.98.
  'api.githubcopilot.com',

  // Sign-in. The device flow posts to `/login/device/code` and polls
  // `/login/oauth/access_token` (both strings are in the runtime); the user
  // opens `github.com/login/device` in a browser. Also the base of most of the
  // runtime's GitHub links. Inferred.
  'github.com',

  // Account and entitlement calls (`/copilot_internal/...`, the token exchange
  // `copilot_token`, user and managed-settings lookups). Inferred.
  'api.github.com',
]);
