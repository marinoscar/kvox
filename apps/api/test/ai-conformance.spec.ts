// =============================================================================
// The platform AI conformance suites, run against this app (issue #477, epic #472)
// =============================================================================
//
// Five suites drive the real router over the AI runtime harness
// (`./ai-conformance/ai-fixture.ts`):
//
//   ai-kill-switch      with `ai.enabled = false` every `/api/ai/*` route except the probe
//                       answers 403 `AI_DISABLED`, `/api/admin/ai/*` stays reachable, and every
//                       `ai.*` job makes zero provider calls.
//   ai-rbac-matrix      every AI route x every role is granted or denied exactly as the seeded
//                       permission set says; a personal access token inherits its owner's grants.
//   ai-secret-egress    no key (a user's, the deployment's, another user's, an organization's)
//                       appears in a response, header, log line, audit row, usage row or run row.
//   ai-key-policy       `byok` never spends the deployment key; `byok_with_org_fallback` does so
//                       only for a caller with no key of their own.
//   ai-jobs-server-only no `ai.*` job type is node-eligible: no vendor offers a job-scoped sub-key.
//
// The two source scans (`ai-no-sdk-leak`, `ai-orchestration-boundary`) need no app and run in
// `conformance.spec.ts` beside the other scans. This file boots the app, so jest runs it alone
// and it is slow; the suites share one fixture app per suite, not one per case.
//
// None is skipped: a skip needs a reason in the options and is printed in the run summary.
// =============================================================================

import '../src/kvox.manifest';
import '../src/app-registrations/registrations';

import { join } from 'node:path';

import '@marinoscar/platform-api/ai/testing';
import { runPlatformConformance } from '@marinoscar/platform-api/testing';

import { aiConformanceFixture } from './ai-conformance/ai-fixture';

// The AI routes the suites find, by the platform's own count: the consumer routes of
// `/api/ai/*` and `/api/admin/ai/*` (policy, catalogue, deployment and organization keys,
// usage). The minimums are the platform's defaults, kept explicit so a discovery that
// quietly finds nothing fails here and not as a vacuous pass.
runPlatformConformance({
  sourceRoots: [join(__dirname, '..', 'src')],
  suites: {
    aiKillSwitch: { fixture: aiConformanceFixture, minAiRoutes: 10, minAdminAiRoutes: 5, minAiJobTypes: 3 },
    aiRbacMatrix: { fixture: aiConformanceFixture, minRoutes: 15, minPermissionedRoutes: 10 },
    aiSecretEgress: { fixture: aiConformanceFixture },
    aiKeyPolicy: { fixture: aiConformanceFixture },
    aiJobsServerOnly: { fixture: aiConformanceFixture, minAiJobTypes: 3 },
  },
});
