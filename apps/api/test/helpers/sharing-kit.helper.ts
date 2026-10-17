// =============================================================================
// Test helper: the platform sharing slice over a bare Prisma client (issue #485)
// =============================================================================
//
// The real-Postgres suites build their services by hand. This builds the REAL
// `AccessPolicy` and `GrantsService` of `@marinoscar/platform-api/sharing` over
// the same client, with the host port (`SHARING_DATA`) bound to the platform's own
// `runInOrg`, so the scope is set with `set_config(..., true)` exactly as in
// production. Only the notifier is a double, so a spec can see what a share sends.
//
// The suites connect as a superuser, to which row-level security does not apply;
// the scope is still opened, so a statement that forgot it would still read the
// wrong organization's rows.
// =============================================================================

import type { PrismaClient } from '@prisma/client';
import {
  AccessPolicy,
  GrantsService,
  MemberLookupThrottle,
  PrincipalGroupsProvider,
  SharingEffects,
  resolveSharingModuleOptions,
  type SharingDataPort,
  type SharingNotifier,
} from '@marinoscar/platform-api/sharing';

import { platformHost } from '../../src/platform/platform-host';
import { TranscriptAccessService } from '@marinoscar/kvox-api/transcripts';
import { PlatformTranscriptSharing } from '../../src/kvox/transcripts/platform-transcript-sharing';
import { asPrismaService } from './db-managed-objects.helper';

export interface SharingKit {
  data: SharingDataPort;
  policy: AccessPolicy;
  grants: GrantsService;
  /** The calls the notifier received, in order: `[eventKey, userId, data]`. */
  notified: Array<[string, string, unknown]>;
}

/** A real `AccessPolicy` and `GrantsService` over `client`. */
export function createSharingKit(client: PrismaClient): SharingKit {
  const prisma = asPrismaService(client);
  const notified: SharingKit['notified'] = [];

  const data: SharingDataPort = {
    runInOrg: (scope, fn) => prisma.runInOrg(scope, (tx) => fn(tx)),
    runAsSystem: () => {
      throw new Error('The sharing test kit has no system client');
    },
  };
  const notifier: SharingNotifier = {
    notify: async (eventKey, userId, payload) => {
      notified.push([eventKey, userId, payload]);
    },
    notifyAddress: async () => undefined,
  };
  const options = resolveSharingModuleOptions({ host: platformHost });
  const principalGroups = new PrincipalGroupsProvider(data, options);
  const policy = new AccessPolicy(data, principalGroups);
  const effects = new SharingEffects(principalGroups, undefined, notifier);
  const grants = new GrantsService(data, policy, principalGroups, new MemberLookupThrottle(), effects, undefined, options);

  return { data, policy, grants, notified };
}

/** The web edition's sharing of a transcript (the slice's `TranscriptSharing`) over `client`, on the platform's real policy and grants. */
export function createPlatformTranscriptSharing(client: PrismaClient, kit: SharingKit = createSharingKit(client)): PlatformTranscriptSharing {
  return new PlatformTranscriptSharing(kit.policy, kit.grants, asPrismaService(client));
}

/** A real `TranscriptAccessService` over `client`: the slice's service on the web edition's sharing. */
export function createTranscriptAccess(client: PrismaClient): TranscriptAccessService {
  return new TranscriptAccessService(asPrismaService(client) as never, createPlatformTranscriptSharing(client));
}
