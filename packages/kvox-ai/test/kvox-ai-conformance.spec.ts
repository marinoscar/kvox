import { describeKvoxPortsConformance } from '@marinoscar/kvox-api/testing';
import { describeAskConformance } from '@marinoscar/kvox-api/ask/testing';

import { describeKvoxAiConformance } from '../src/testing/index.js';
import { conformanceUnderTest, portsAiUnderTest, providerStep, scriptedBinding } from './helpers/scripted-binding.js';

// =============================================================================
// The three conformance kits over createKvoxAi + the scripted runtime (issue #579)
// =============================================================================
//
// What a host must show to bind KVOX_AI, run against the package's own binding:
//
//   describeKvoxAiConformance     the model rules of the port (structured output, chat events, error
//                                 classes, timeout, no key leak). Nothing is opted out here.
//   describeKvoxPortsConformance  the host-port kit, `ai` section only: every other port is the host's
//                                 own, so it is named in `skip`.
//   describeAskConformance        an Ask turn through the real `AskRespondHandler` over this port.
//
// The web edition runs the same three over `createWebKvoxAi` in `apps/api/test/platform-kvox/`.
// =============================================================================

describeKvoxAiConformance('createKvoxAi over the scripted runtime', (options) => conformanceUnderTest(options), {
  describe,
  it,
  expect,
});

describeKvoxPortsConformance(
  'createKvoxAi over the scripted runtime',
  () => ({ ai: portsAiUnderTest() }),
  { describe, it, expect },
  { skip: ['objectStore', 'jobs', 'identity', 'notify', 'events', 'settings', 'secrets', 'audit'] },
);

describeAskConformance(
  'createKvoxAi over the scripted runtime',
  () => {
    // After the script runs out the kit expects an empty step, not a canned answer.
    const { port, runtime } = scriptedBinding({ defaultStream: [] });
    return {
      port,
      script(turns) {
        runtime.reset();
        for (const turn of turns) runtime.queueStream(providerStep(turn));
      },
    };
  },
  { describe, it, expect },
);
