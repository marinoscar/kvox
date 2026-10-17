import { GraphPreferencesService } from './graph-preferences.service.js';
import { GRAPH_PREFERENCE_DEFAULTS } from './graph-preferences.defaults.js';

// =============================================================================
// GraphPreferencesService (#369, epic #346; over the settings port by #496)
// =============================================================================
//
// The platform-composed PATCH body and the merge rules are specified beside the web edition's
// registration (`apps/api/test/graph/graph-preferences.spec.ts`).
// =============================================================================

const USER = '11111111-1111-4111-8111-111111111111';

describe('GraphPreferencesService', () => {
  it('returns defaults for a user with no graph namespace, through a plain read', async () => {
    const settings = { readUser: jest.fn().mockResolvedValue(undefined), patchUser: jest.fn() };
    const service = new GraphPreferencesService(settings as never);

    await expect(service.get(USER)).resolves.toEqual(GRAPH_PREFERENCE_DEFAULTS);
    expect(settings.readUser).toHaveBeenCalledWith(USER, 'graph');
    expect(settings.patchUser).not.toHaveBeenCalled();
  });

  it('resolves a stored namespace over the defaults', async () => {
    const settings = {
      readUser: jest
        .fn()
        .mockResolvedValue({ resolution: { ...GRAPH_PREFERENCE_DEFAULTS.resolution, autoLinkThreshold: 0.93 } }),
    };
    const service = new GraphPreferencesService(settings as never);

    const resolved = await service.get(USER);
    expect(resolved.resolution.autoLinkThreshold).toBe(0.93);
    expect(resolved.domains.work).toBe(true);
  });
});
