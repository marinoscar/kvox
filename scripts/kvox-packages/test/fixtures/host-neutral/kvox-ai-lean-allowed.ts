// Fixture for rule `host-neutral`: the one platform specifier a kvox-ai slice may
// import, the lean `@marinoscar/platform-ai-providers`, as a value and as a type.
// The test copies it into packages/kvox-ai/src/runtime (and kvox-eval/src/runtime).
import { AiError } from '@marinoscar/platform-ai-providers';
import type { AiResponse } from '@marinoscar/platform-ai-providers';

export const ERROR = AiError;
export type Response = AiResponse;
