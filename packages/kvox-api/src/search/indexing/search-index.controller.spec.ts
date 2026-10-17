import { HTTP_CODE_METADATA } from '@nestjs/common/constants';

import {
  KVOX_PERMISSIONS_KEY,
  KVOX_PERMISSION_KEYS_KEY,
  KvoxAuthGuard,
} from '../../core/index.js';
import type { KvoxPrincipal } from '../../ports/index.js';
import { SearchIndexController } from './search-index.controller.js';
import { SearchIndexStatusService } from './search-index-status.service.js';

// =============================================================================
// SearchIndexController (issue #191, epic #165)
// =============================================================================
//
// Both routes are `@KvoxAuth()` with NO permission string, and this file pins
// that ABSENCE — so a later, well-meant `@KvoxAuth('transcripts:read')` fails a
// test rather than merging quietly. The resource is the caller's own content
// and the caller's own vendor account; the id comes off the verified principal
// and nothing in either signature can name a different user.
// =============================================================================

const principal = (userId: string): KvoxPrincipal => ({
  userId,
  orgId: null,
  roles: [],
  permissions: new Set(),
});

describe('SearchIndexController', () => {
  let service: { status: jest.Mock; requestIndex: jest.Mock };
  let controller: SearchIndexController;

  beforeEach(() => {
    service = {
      status: jest.fn().mockResolvedValue({ types: [], failures: [] }),
      requestIndex: jest.fn().mockResolvedValue({ queued: 3, remaining: 0, cap: 200 }),
    };

    controller = new SearchIndexController(service as unknown as SearchIndexStatusService);
  });

  describe('GET /api/search/index-status', () => {
    it("asks for the CALLER'S OWN status, by the id off the verified principal", async () => {
      await controller.indexStatus(principal('user-1'));

      expect(service.status).toHaveBeenCalledWith('user-1');
    });

    it('returns whatever the service reports', async () => {
      const status = { types: [], failures: [], model: null };
      service.status.mockResolvedValue(status);

      await expect(controller.indexStatus(principal('user-1'))).resolves.toBe(status);
    });
  });

  describe('POST /api/search/index', () => {
    it('forwards only the caller id — there is no body and no user parameter', async () => {
      await controller.requestIndex(principal('user-1'));

      expect(service.requestIndex).toHaveBeenCalledWith('user-1');
      // One argument, which is the whole safety property: "index somebody
      // else's library" is not a request this route refuses, it is a request it
      // cannot express.
      expect(service.requestIndex.mock.calls[0]).toHaveLength(1);
    });

    it('answers 202 — the work is queued, not done', () => {
      expect(
        Reflect.getMetadata(HTTP_CODE_METADATA, SearchIndexController.prototype.requestIndex),
      ).toBe(202);
    });
  });

  describe('authorization posture', () => {
    it.each(['indexStatus', 'requestIndex'] as const)(
      '%s is authenticated, declares NO permission and none by option — ownership is enforced in the query',
      (method) => {
        const handler = SearchIndexController.prototype[method];

        // `@KvoxAuth()` records an EMPTY requirement: authenticated, nothing more.
        expect(Reflect.getMetadata(KVOX_PERMISSIONS_KEY, handler)).toEqual([]);
        expect(Reflect.getMetadata(KVOX_PERMISSION_KEYS_KEY, handler)).toBeUndefined();
        expect(Reflect.getMetadata('__guards__', handler)).toContain(KvoxAuthGuard);
      },
    );

    it('declares no class-level permission either', () => {
      expect(Reflect.getMetadata(KVOX_PERMISSIONS_KEY, SearchIndexController)).toBeUndefined();
      expect(Reflect.getMetadata(KVOX_PERMISSION_KEYS_KEY, SearchIndexController)).toBeUndefined();
    });
  });
});
