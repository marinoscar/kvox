// =============================================================================
// describeAskConformance against the web edition's AI binding (issue #497, epic #491; #579)
// =============================================================================
//
// The same suite `packages/kvox-api/test/ask-conformance.spec.ts` runs against the scripted fake,
// run against the REAL web `KVOX_AI` binding (`createWebKvoxAi`: `createKvoxAi` over the real
// `PlatformAiRuntime`, #579), whose platform stream is scripted (`FakeAskStream`:
// `AiService.forUser(...).stream()` is the one thing faked).
// So a turn is proven with the web edition's feature mapping, its event mapping
// (`output_text.delta`, `function_call`, `response.completed`, the platform's `error` event), its
// error translation (a provider 429 becomes a `KvoxAiError` of class `rate_limit`) and its step
// handling, end to end through the real handler: any `KVOX_AI` that passes the ports kit and this
// suite runs Ask, which is what KVox Desktop's Copilot adapter must show.
// =============================================================================

import '../../src/kvox.manifest';

import { join } from 'node:path';

import { KvoxAiError } from '@marinoscar/kvox-api/ports';
import { describeAskConformance, type AskAiUnderTest, type ScriptedTurn } from '@marinoscar/kvox-api/ask/testing';

import { createFakeAskPort, done, failure, FakeAskStream, text, toolCall } from '../../scripts/ask-eval/fake-provider';

/** One scripted step as the platform's own stream events. */
function platformEvents(turn: ScriptedTurn) {
  const events = [];

  for (const event of turn.events) {
    if (event.type === 'delta') events.push(text(event.text));
    else if (event.type === 'tool_call') events.push(toolCall(event.id, event.name, JSON.stringify(event.arguments)));
    else if (event.error instanceof KvoxAiError && event.error.errorClass === 'rate_limit') {
      events.push(failure('AI_RATE_LIMITED', event.error.message));
    } else {
      throw new Error(`the web edition's scripting does not translate ${event.error.message}`);
    }
  }
  // A step that failed has no completion.
  if (!turn.events.some((event) => event.type === 'fail')) {
    events.push(done(turn.finishReason ?? 'stop', turn.usage?.inputTokens ?? 100, turn.usage?.outputTokens ?? 20));
  }

  return events;
}

function webEditionAi(): AskAiUnderTest {
  const stream = new FakeAskStream();
  const { ai: port } = createFakeAskPort(stream, { model: 'scripted-model' });

  return {
    port,
    script(turns) {
      stream.reset();
      for (const turn of turns) stream.enqueue(platformEvents(turn));
    },
  };
}

describeAskConformance('the web edition AI binding', webEditionAi, { describe, it, expect }, {
  sourceRoot: join(__dirname, '..', '..', '..', '..', 'packages', 'kvox-api', 'src'),
});
