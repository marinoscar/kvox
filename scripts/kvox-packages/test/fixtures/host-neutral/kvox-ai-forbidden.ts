// Fixture for rule `host-neutral`, kvox-ai half: three platform specifiers a
// kvox-ai slice may NOT import (another subpath, the bare package, a path below
// the allowed subpath). The test copies it into packages/kvox-ai/src/runtime.
import { SystemSettingsService } from '@marinoscar/platform-api/settings';
import type { AiCallContext } from '@marinoscar/platform-api/ai/core';
import '@marinoscar/platform-api';

export const SETTINGS = SystemSettingsService;
export type Context = AiCallContext;
