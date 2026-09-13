// =============================================================================
// NodeSecretRevoker — the properties that make it a BYSTANDER (issue #349)
// =============================================================================
//
// There are only four assertions worth making about this listener, and none of
// them is "it revokes" — that is `NodeSecretBrokerService`'s business and is
// covered there. What matters here is everything the listener must NOT do,
// because `EventEmitter2` dispatches synchronously INSIDE the worker's
// completion path: whatever happens here happens before the worker frees its
// slot, and a throw or a hang reaches a worker that has just written a
// perfectly correct terminal row.
//
// So: it returns synchronously, it never throws, it never lets a rejected
// promise escape, and it does not touch the database for a type that could not
// possibly hold a grant. Each of those failures is invisible in production
// until it is catastrophic, which is why they are asserted rather than assumed.
// =============================================================================

import { JobSettledEvent } from '../../jobs/events/job-settled.event';
import { NodeSecretBrokerService } from '../node-secret-broker.service';
import { NodeSecretRevoker } from './node-secret-revoker';

describe('NodeSecretRevoker', () => {
  const JOB_ID = '22222222-2222-4222-8222-222222222222';
  const TYPE = 'test.needs-credential';

  let couldHoldGrant: jest.Mock;
  let revokeForJob: jest.Mock;
  let revoker: NodeSecretRevoker;

  beforeEach(() => {
    couldHoldGrant = jest.fn().mockReturnValue(true);
    revokeForJob = jest.fn().mockResolvedValue(1);

    revoker = new NodeSecretRevoker({
      couldHoldGrant,
      revokeForJob,
    } as unknown as NodeSecretBrokerService);
  });

  function settled(status: 'succeeded' | 'failed', type = TYPE): JobSettledEvent {
    return new JobSettledEvent({ id: JOB_ID, type, status } as never);
  }

  /** Lets the detached promise inside the handler settle. */
  const drain = () => new Promise((resolve) => setImmediate(resolve));

  it('revokes on a settle, whatever the outcome was', async () => {
    // NO STATUS FILTER, unlike `JobFailureNotifier`. A credential is not news,
    // it is a capability, and a job that SUCCEEDED has exactly as much business
    // still holding one as a job that failed: none.
    revoker.handleJobSettled(settled('succeeded'));
    revoker.handleJobSettled(settled('failed'));
    await drain();

    expect(revokeForJob).toHaveBeenCalledTimes(2);
    expect(revokeForJob).toHaveBeenCalledWith(JOB_ID);
  });

  it('returns synchronously — it never awaits the revocation', () => {
    // The worker must not wait on a `DROP ROLE`. A handler that returned a
    // promise here would put one in the emit path, where nothing awaits it and
    // an `{ async: true }` registration would make the queue block on a remote
    // system.
    let resolveRevoke: () => void = () => undefined;
    revokeForJob.mockReturnValue(
      new Promise<number>((resolve) => {
        resolveRevoke = () => resolve(0);
      })
    );

    expect(revoker.handleJobSettled(settled('succeeded'))).toBeUndefined();

    resolveRevoke();
  });

  it('does not touch the broker at all for a type that cannot hold a grant', async () => {
    // The Map-lookup short circuit: in the ~100% of deployments where no type
    // declares a broker, this listener costs one comparison per settled job and
    // no query at all.
    couldHoldGrant.mockReturnValue(false);

    revoker.handleJobSettled(settled('succeeded', 'example.checksum'));
    await drain();

    expect(revokeForJob).not.toHaveBeenCalled();
  });

  it('swallows a SYNCHRONOUS throw — a settled row must be unaffected', () => {
    // `emitSettled` already catches, and logs "a listener threw"; this catch
    // exists so it never has to.
    couldHoldGrant.mockImplementation(() => {
      throw new Error('registry exploded');
    });

    expect(() => revoker.handleJobSettled(settled('failed'))).not.toThrow();
  });

  it('swallows a REJECTED detached promise, which try/catch cannot see', async () => {
    // The failure this listener's whole shape exists to make impossible: an
    // unhandled rejection raised inside a synchronous emitter dispatch, with a
    // stack pointing at a worker that did nothing wrong.
    const unhandled = jest.fn();
    process.on('unhandledRejection', unhandled);

    revokeForJob.mockRejectedValue(new Error('database unreachable'));

    expect(() => revoker.handleJobSettled(settled('failed'))).not.toThrow();
    await drain();

    process.off('unhandledRejection', unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });
});
