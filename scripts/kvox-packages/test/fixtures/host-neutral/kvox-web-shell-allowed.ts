// Fixture for rule `host-neutral`: the platform specifiers the kvox-web shell slice may import.
import { RequirePermission } from '@marinoscar/platform-web/identity/headless';
import type { ShellNavigation } from '@marinoscar/platform-web/shell/headless';
import { ShellLayout } from '@marinoscar/platform-web/shell/ui';

export const SHELL = [RequirePermission, ShellLayout] as const;
export type Nav = ShellNavigation;
