import { Injectable } from '@nestjs/common';
import type { SettingsDataPort, SettingsOrgTx } from '@marinoscar/platform-api/settings';

import { PrismaService } from '../../prisma/prisma.service';

/**
 * The settings slice's `SETTINGS_DATA` port: how it opens a transaction in one
 * organization's row-level-security scope (issue #466).
 *
 * Bound to `PrismaService.runInOrg`, whose first statement is
 * `set_config(name, value, true)` (transaction-local, never a session `SET`).
 * It is the path `/api/org-settings` takes; in single-organization mode the
 * organization is the default one and its `org_settings` row stays empty.
 */
@Injectable()
export class SettingsDataAdapter implements SettingsDataPort {
  constructor(private readonly prisma: PrismaService) {}

  runInOrg<R>(
    scope: { orgId: string; userId?: string },
    fn: (tx: SettingsOrgTx) => Promise<R>,
  ): Promise<R> {
    return this.prisma.runInOrg(scope, (tx) => fn(tx as unknown as SettingsOrgTx));
  }
}
