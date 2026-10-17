import { describeAskConformance, scriptedAiUnderTest } from '../src/ask/testing/index.js';

// =============================================================================
// The Ask conformance suite over the package's own scripted model (issue #497, epic #491)
// =============================================================================
//
// The slice exports `describeAskConformance` (`@marinoscar/kvox-api/ask/testing`) so a host proves
// that ITS `KVOX_AI` adapter runs an Ask turn unchanged. This is the package's run, over the
// scripted fake: the real `AskRespondHandler` over an in-memory copy of the Ask tables. The web
// application runs the same suite over its platform AI adapter in
// `apps/api/test/platform-kvox/ask-conformance.spec.ts`.
// =============================================================================

describeAskConformance('the scripted model', () => scriptedAiUnderTest(), { describe, it, expect });
