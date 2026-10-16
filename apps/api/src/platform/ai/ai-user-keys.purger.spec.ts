import { UserAiKeysService } from '@marinoscar/platform-api/ai';

import { AiUserKeysPurger } from './ai-user-keys.purger';

// =============================================================================
// AiUserKeysPurger (issue #475)
// =============================================================================
//
// The user-data purge erases a user's AI keys through the platform's
// `UserAiKeysService`: one `remove` per provider the user has a key for, and
// nothing for a provider they never configured.
// =============================================================================

const USER_ID = 'user-1';

function harness(views: Array<{ provider: string; configured: boolean }>) {
  const keys = {
    list: jest.fn().mockResolvedValue(views),
    remove: jest.fn().mockResolvedValue(undefined),
  };
  const moduleRef = { get: jest.fn().mockReturnValue(keys) };
  const purger = new AiUserKeysPurger(moduleRef as never);

  return { purger, keys, moduleRef };
}

describe('AiUserKeysPurger', () => {
  it('resolves the platform service anywhere in the application graph', async () => {
    const { purger, moduleRef } = harness([]);

    await purger.removeAll(USER_ID);

    expect(moduleRef.get).toHaveBeenCalledWith(UserAiKeysService, { strict: false });
  });

  it('removes one key per configured provider and returns how many', async () => {
    const { purger, keys } = harness([
      { provider: 'openai', configured: true },
      { provider: 'anthropic', configured: true },
    ]);

    await expect(purger.removeAll(USER_ID)).resolves.toBe(2);

    expect(keys.remove).toHaveBeenCalledWith(USER_ID, 'openai');
    expect(keys.remove).toHaveBeenCalledWith(USER_ID, 'anthropic');
  });

  it('skips a provider the user never configured', async () => {
    const { purger, keys } = harness([
      { provider: 'openai', configured: true },
      { provider: 'anthropic', configured: false },
    ]);

    await expect(purger.removeAll(USER_ID)).resolves.toBe(1);

    expect(keys.remove).toHaveBeenCalledTimes(1);
    expect(keys.remove).not.toHaveBeenCalledWith(USER_ID, 'anthropic');
  });

  it('counts only configured providers', async () => {
    const { purger } = harness([
      { provider: 'openai', configured: true },
      { provider: 'anthropic', configured: false },
    ]);

    await expect(purger.count(USER_ID)).resolves.toBe(1);
  });

  it('removes nothing for a user with no keys', async () => {
    const { purger, keys } = harness([]);

    await expect(purger.removeAll(USER_ID)).resolves.toBe(0);
    expect(keys.remove).not.toHaveBeenCalled();
  });
});
