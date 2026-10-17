// =============================================================================
// describeKvoxAiConformance against the web edition's AI binding (issue #579)
// =============================================================================
//
// The same model rules `packages/kvox-ai/test/kvox-ai-conformance.spec.ts` proves for
// `createKvoxAi` over a scripted runtime, run against the REAL web `KVOX_AI` binding
// (`createWebKvoxAi`: `createKvoxAi` over the real `PlatformAiRuntime`, wrapped for spans)
// whose platform `AiService.forUser(...)` client is scripted
// (`test/helpers/web-kvox-ai.helper.ts`). So the platform's own error vocabulary
// (`AiError` codes, `RateLimitError`, the target resolver's 409 bodies) reaches the port
// through the runtime's translation, exactly as in production.
//
// No case is opted out: the platform client is a stand-in, so every provider behaviour
// (a hang that ends on the call's signal, a structured answer that finishes `length`) can
// be produced.
// =============================================================================

import '../../src/kvox.manifest';

import { describeKvoxAiConformance, type KvoxAiConformanceUnderTest } from '@marinoscar/kvox-ai/testing';

import { createWebAiUnderTest } from '../helpers/web-kvox-ai.helper';

function webUnderTest(options: { requestTimeoutMs?: number }): KvoxAiConformanceUnderTest {
  const web = createWebAiUnderTest(options.requestTimeoutMs !== undefined ? { timeoutMs: options.requestTimeoutMs } : {});

  return {
    port: web.port,
    provider: {
      structuredAnswer: ({ value, finishReason }) => {
        web.structured.value = value;
        if (finishReason !== undefined) web.structured.finishReason = finishReason;
      },
      streamAnswer: (events) => web.script(events),
      failNext: (error) => web.arm(error),
      hangNext: () => web.hang(),
      lastStructuredRequest: () => {
        const calls = web.client.respond.mock.calls as unknown as Array<[{ structuredOutput?: { name: string; schema: unknown; strict: boolean } }]>;
        return calls[calls.length - 1]?.[0]?.structuredOutput;
      },
    },
  };
}

describeKvoxAiConformance('the web edition AI binding', (options) => webUnderTest(options), { describe, it, expect });
