// Fixture for rule `host-neutral`: the `/openai` subpath is allowed to kvox-eval
// only; kvox-ai importing it is a violation. The test copies it into
// packages/kvox-ai/src/runtime.
import { createOpenAiAdapter } from '@marinoscar/platform-ai-providers/openai';

export const ADAPTER = createOpenAiAdapter;
