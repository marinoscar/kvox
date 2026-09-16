import { HTTP_CODE_METADATA } from '@nestjs/common/constants';

import { PERMISSIONS_KEY } from '../../auth/decorators/permissions.decorator';
import { ROLES_KEY } from '../../auth/decorators/roles.decorator';
import { SearchIndexController } from './search-index.controller';
import { SearchIndexStatusService } from './search-index-status.service';

// =============================================================================
// SearchIndexController (issue #191, epic #165)
// =============================================================================
//
// Both routes are `@Auth()` with NO permission string and NO role list, and
// this file pins that ABSENCE the same way `user-data.controller.spec.ts` pins
// its own — so a later, well-meant `@Permissions('transcripts:read')` fails a
// test rather than merging quietly. The resource is the caller's own content
// and the caller's own vendor account; the id comes off the verified JWT and
// nothing in either signature can name a different user.
// =============================================================================

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
    it("asks for the CALLER'S OWN status, by the id off the verified JWT", async () => {
      await controller.indexStatus('user-1');

      expect(service.status).toHaveBeenCalledWith('user-1');
    });

    it('returns whatever the service reports', async () => {
      const status = { types: [], failures: [], model: null };
      service.status.mockResolvedValue(status);

      await expect(controller.indexStatus('user-1')).resolves.toBe(status);
    });
  });

  describe('POST /api/search/index', () => {
    it('forwards only the caller id — there is no body and no user parameter', async () => {
      await controller.requestIndex('user-1');

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
      '%s declares NO permission and NO role — ownership is enforced in the query',
      (method) => {
        const handler = SearchIndexController.prototype[method];

        expect(Reflect.getMetadata(PERMISSIONS_KEY, handler)).toBeUndefined();
        expect(Reflect.getMetadata(ROLES_KEY, handler)).toBeUndefined();
      },
    );

    it('declares no class-level permission or role either', () => {
      expect(Reflect.getMetadata(PERMISSIONS_KEY, SearchIndexController)).toBeUndefined();
      expect(Reflect.getMetadata(ROLES_KEY, SearchIndexController)).toBeUndefined();
    });
  });
});
