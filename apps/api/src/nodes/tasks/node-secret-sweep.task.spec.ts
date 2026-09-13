// =============================================================================
// NodeSecretSweepTask — the switch, and the throw that must not escape (#349)
// =============================================================================
//
// The sweep's own logic is covered in `node-secret-broker.service.spec.ts`, arm
// by arm. What is left here is the timer wrapper, and both of its properties
// are ones whose failure is silent:
//
//   * THE SWITCH FAILS OPEN. Only the literal `false` disables the sweep, so a
//     `NODE_SECRET_SWEEP_ENABLED=flase` in an env file keeps sweeping. The
//     failure it protects against is the worst possible kind to diagnose: a
//     deployment whose credential cleanup silently stopped looks exactly like
//     one where it is working, right up until somebody lists the roles on the
//     database.
//   * A THROW NEVER ESCAPES. A rejection out of a `@Cron` handler is an
//     unhandled rejection; a database blip must not be able to take the process
//     down, and must not stop the sweep permanently either — the next tick
//     would have run anyway.
// =============================================================================

import { ConfigService } from '@nestjs/config';

import { NodeSecretBrokerService } from '../node-secret-broker.service';
import { NodeSecretSweepTask } from './node-secret-sweep.task';

describe('NodeSecretSweepTask', () => {
  let sweep: jest.Mock;

  function makeTask(secretSweepEnabled: unknown): NodeSecretSweepTask {
    sweep = jest.fn().mockResolvedValue({ examined: 1, revoked: 1, failed: 0 });

    const config = {
      get: (key: string) =>
        key === 'nodes.secretSweepEnabled' ? secretSweepEnabled : undefined,
    } as unknown as ConfigService;

    return new NodeSecretSweepTask(
      { sweep } as unknown as NodeSecretBrokerService,
      config
    );
  }

  it('sweeps when the switch is on', async () => {
    await makeTask(true).handleCron();

    expect(sweep).toHaveBeenCalledTimes(1);
  });

  it('does not sweep when the switch is literally false', async () => {
    await makeTask(false).handleCron();

    expect(sweep).not.toHaveBeenCalled();
  });

  it.each([
    ['a typo', 'flase'],
    ['the string "false"', 'false'],
    ['undefined', undefined],
    ['null', null],
  ])('keeps sweeping for %s — the switch fails OPEN', async (_label, value) => {
    // ⚠ Note the second case: `configuration.ts` is what converts the
    // ENVIRONMENT string to a boolean, and this task reads the converted value.
    // A truthy string reaching here means somebody bypassed that conversion,
    // and the safe direction is still to sweep.
    await makeTask(value).handleCron();

    expect(sweep).toHaveBeenCalledTimes(1);
  });

  it('swallows a sweep failure rather than becoming an unhandled rejection', async () => {
    const task = makeTask(true);
    sweep.mockRejectedValue(new Error('connection reset'));

    await expect(task.handleCron()).resolves.toBeUndefined();
  });

  it('is NOT gated on `nodes.jobSecretBrokerEnabled`', async () => {
    // Turning brokering OFF is the exact moment outstanding grants most need
    // destroying: an administrator revoking the fleet's authority expects the
    // credentials already handed out to go away, not to survive to their own
    // expiry. A sweep gated on that setting would do nothing on the one day it
    // matters most — so the task never reads it at all.
    const reads: string[] = [];
    const config = {
      get: (key: string) => {
        reads.push(key);
        return true;
      },
    } as unknown as ConfigService;

    sweep = jest.fn().mockResolvedValue({ examined: 0, revoked: 0, failed: 0 });
    await new NodeSecretSweepTask(
      { sweep } as unknown as NodeSecretBrokerService,
      config
    ).handleCron();

    expect(reads).toEqual(['nodes.secretSweepEnabled']);
  });
});
