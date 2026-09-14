import { HTTP_CODE_METADATA } from '@nestjs/common/constants';

import { PERMISSIONS_KEY } from '../auth/decorators/permissions.decorator';
import { ROLES_KEY } from '../auth/decorators/roles.decorator';
import { UserDataController } from './user-data.controller';
import { UserDataService } from './user-data.service';

// =============================================================================
// UserDataController (issue #80) — the Danger Zone
// =============================================================================
//
// Both routes are `@Auth()` with NO permission string and NO role list —
// deliberately, per the controller's own header: the resource is the
// caller's own data, scoped by `userId` in the query itself, not a feature an
// RBAC permission gates. This file pins that absence the same way
// `maintenance.controller.spec.ts` pins its PRESENCE, so a later "helpfully"
// added `@Permissions(...)` — which would strand exactly the offboarded user
// this design exists to protect — fails a test rather than merging quietly.
// =============================================================================

describe('UserDataController', () => {
  let service: { summary: jest.Mock; requestDeletion: jest.Mock };
  let controller: UserDataController;

  beforeEach(() => {
    service = {
      summary: jest.fn().mockResolvedValue({ transcripts: { count: 0, bytes: '0' } }),
      requestDeletion: jest.fn().mockResolvedValue({
        id: 'job-1',
        scope: 'everything',
        status: 'pending',
        requestedAt: '2026-01-01T00:00:00.000Z',
      }),
    };

    controller = new UserDataController(service as unknown as UserDataService);
  });

  describe('GET /api/user-data/summary', () => {
    it("asks the service for the CALLER'S OWN summary, by the id off the verified JWT", async () => {
      await controller.summary('user-1');

      expect(service.summary).toHaveBeenCalledWith('user-1');
    });

    it('returns whatever the service reports', async () => {
      const summary = { transcripts: { count: 3, bytes: '900' } };
      service.summary.mockResolvedValue(summary);

      await expect(controller.summary('user-1')).resolves.toBe(summary);
    });
  });

  describe('POST /api/user-data/deletions', () => {
    it('forwards the scope and confirmation, plus the caller id — never a body field naming a user', async () => {
      await controller.requestDeletion(
        { scope: 'notes', confirmation: 'NOTES' } as never,
        'user-1',
      );

      expect(service.requestDeletion).toHaveBeenCalledWith('user-1', {
        scope: 'notes',
        confirmation: 'NOTES',
      });
    });

    it('returns the queued deletion the service reports', async () => {
      const response = {
        id: 'job-2',
        scope: 'files',
        status: 'pending',
        requestedAt: '2026-01-02T00:00:00.000Z',
      };
      service.requestDeletion.mockResolvedValue(response);

      await expect(
        controller.requestDeletion({ scope: 'files', confirmation: 'FILES' } as never, 'user-1'),
      ).resolves.toBe(response);
    });

    it('answers 202 — nothing is deleted synchronously', () => {
      expect(
        Reflect.getMetadata(HTTP_CODE_METADATA, UserDataController.prototype.requestDeletion),
      ).toBe(202);
    });
  });

  describe('authorization metadata — ownership-scoped, not permission-gated', () => {
    it('GET summary carries NO permission string', () => {
      expect(
        Reflect.getMetadata(PERMISSIONS_KEY, UserDataController.prototype.summary),
      ).toBeUndefined();
    });

    it('GET summary carries NO role restriction', () => {
      expect(
        Reflect.getMetadata(ROLES_KEY, UserDataController.prototype.summary),
      ).toBeUndefined();
    });

    it('POST deletions carries NO permission string', () => {
      expect(
        Reflect.getMetadata(PERMISSIONS_KEY, UserDataController.prototype.requestDeletion),
      ).toBeUndefined();
    });

    it('POST deletions carries NO role restriction', () => {
      expect(
        Reflect.getMetadata(ROLES_KEY, UserDataController.prototype.requestDeletion),
      ).toBeUndefined();
    });
  });
});
