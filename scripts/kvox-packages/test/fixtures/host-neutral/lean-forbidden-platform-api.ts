// Fixture for rule `host-neutral`: importing @marinoscar/platform-api, bare or the
// old /ai subpath, from kvox-ai or kvox-eval is a violation. The test copies it
// into packages/<kvox-ai|kvox-eval>/src/runtime.
import { AiError } from '@marinoscar/platform-api/ai';
import '@marinoscar/platform-api';

export const ERROR = AiError;
