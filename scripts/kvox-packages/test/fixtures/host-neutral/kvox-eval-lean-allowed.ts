// Fixture for rule `host-neutral`: what a kvox-eval slice may import, the lean
// provider package and its `/openai` subpath. The test copies it into
// packages/kvox-eval/src/runtime.
import { AiError } from '@marinoscar/platform-ai-providers';
import { createOpenAiAdapter } from '@marinoscar/platform-ai-providers/openai';

export const ERROR = AiError;
export const ADAPTER = createOpenAiAdapter;
