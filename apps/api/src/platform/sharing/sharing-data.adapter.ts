import { Injectable } from '@nestjs/common';
import { runAsSystem } from '@marinoscar/platform-api/core';
import type { SharingDataPort, SharingSystemReason } from '@marinoscar/platform-api/sharing';

import { PrismaSystemService } from '../../prisma/prisma-system.service';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * The sharing slice's `SHARING_DATA` port (issue #485).
 *
 * `runInOrg` opens one interactive transaction whose first statement sets the
 * transaction-local `app.org_id` and `app.user_id` (`PrismaService.runInOrg`,
 * never a session `SET`): `grants` and the group tables are under forced
 * row-level security. `runAsSystem` is the bypass client, used only for the user
 * purge, the Doctor, the retention prune and the link-token lookup.
 */
@Injectable()
export class SharingDataAdapter implements SharingDataPort {
  constructor(
    private readonly prisma: PrismaService,
    private readonly system: PrismaSystemService,
  ) {}

  runInOrg<R>(scope: { orgId: string; userId?: string }, fn: (tx: unknown) => Promise<R>): Promise<R> {
    return this.prisma.runInOrg(scope, (tx) => fn(tx));
  }

  runAsSystem<R>(reason: SharingSystemReason, fn: (tx: unknown) => Promise<R>): Promise<R> {
    return runAsSystem(this.system as never, reason, fn as never) as Promise<R>;
  }
}
