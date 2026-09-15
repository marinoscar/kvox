import { PERMISSIONS_KEY } from '../auth/decorators/permissions.decorator';
import { PERMISSIONS } from '../common/constants/roles.constants';
import { ALLOW_DURING_MAINTENANCE_KEY } from '../common/maintenance/allow-during-maintenance.decorator';
import { AboutController } from './about.controller';
import type { AboutService } from './about.service';
import { ABOUT_RESPONSE_EXAMPLE, aboutResponseSchema } from './about.dto';

// =============================================================================
// AboutController — unit tests (issue #124, epic #118)
// =============================================================================
//
// The controller's own contract: what it forwards, and the authorization
// metadata `@Auth()` stamps on it — the same shape as
// `common/maintenance/maintenance.controller.spec.ts`. The route exercised
// through the real request pipeline (401/403/200 by actual status code, the
// enveloped body, the secret scan) is `test/about/about.integration.spec.ts`.
// =============================================================================

describe('AboutController', () => {
  let service: { get: jest.Mock };
  let controller: AboutController;

  beforeEach(() => {
    service = { get: jest.fn().mockResolvedValue(ABOUT_RESPONSE_EXAMPLE.data) };
    controller = new AboutController(service as unknown as AboutService);
  });

  it('returns the service answer unchanged', async () => {
    const body = await controller.getAbout();

    expect(service.get).toHaveBeenCalledTimes(1);
    expect(body).toBe(ABOUT_RESPONSE_EXAMPLE.data);
  });

  it('documents an example that parses through the published schema', () => {
    // The example is what the reference page shows; the schema is what a
    // client generates from. They must be the same shape.
    expect(() => aboutResponseSchema.parse(ABOUT_RESPONSE_EXAMPLE.data)).not.toThrow();
    // …and it is written already enveloped, because `applyDataEnvelope`
    // wraps the schema but not a media-level example.
    expect(Object.keys(ABOUT_RESPONSE_EXAMPLE)).toEqual(['data', 'meta']);
  });

  describe('authorization metadata', () => {
    it('gates the read on system_settings:read and nothing else', () => {
      // NO `about:read`. Epic #118 decision 8: "what is deployed here" is an
      // administrator's configuration read, and a permission no role is
      // seeded with would be a card nobody could open. The web card (#126)
      // carries this exact string (CLAUDE.md Settings UI rule 3).
      expect(
        Reflect.getMetadata(PERMISSIONS_KEY, AboutController.prototype.getAbout),
      ).toEqual([PERMISSIONS.SYSTEM_SETTINGS_READ]);
    });

    it('is NOT exempt from the maintenance window', () => {
      // An admin page: administrators bypass the window already unless
      // `allowAdmins` is false, and then nothing but the switch should answer.
      expect(
        Reflect.getMetadata(ALLOW_DURING_MAINTENANCE_KEY, AboutController),
      ).toBeUndefined();
      expect(
        Reflect.getMetadata(
          ALLOW_DURING_MAINTENANCE_KEY,
          AboutController.prototype.getAbout,
        ),
      ).toBeUndefined();
    });
  });
});
