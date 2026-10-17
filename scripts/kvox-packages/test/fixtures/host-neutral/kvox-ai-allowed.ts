// Fixture for rule `host-neutral`, kvox-ai half: the one platform specifier a
// kvox-ai slice may import, `@marinoscar/platform-api/ai`, as a value and as a type.
// The test copies it into packages/kvox-ai/src/runtime.
import { AiError } from '@marinoscar/platform-api/ai';
import type { AiResponse } from '@marinoscar/platform-api/ai';

export const ERROR = AiError;
export type Response = AiResponse;
