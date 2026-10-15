import { ConfigService } from '@nestjs/config';
import { EventEmitter2, EventEmitterModule } from '@nestjs/event-emitter';
import { Test, TestingModule } from '@nestjs/testing';
import { NODE_OFFLINE_EVENT, NodeOfflineEvent } from '@marinoscar/platform-api/nodes';

import { NodeOfflineNotifier } from './node-offline-notifier';
import { NotificationsService } from '../notifications.service';

// PLATFORM-ADOPTION-SHIM(2.3): the listener that turns the platform fleet sweep's
// `NODE_OFFLINE_EVENT` into this app's `nodes.node_offline` notification. The
// platform notifications slice owns it after #470; this suite goes with it.

describe('NodeOfflineNotifier', () => {
  let module: TestingModule;
  let emitter: EventEmitter2;
  let notifyPermissionHolders: jest.Mock;

  beforeEach(async () => {
    notifyPermissionHolders = jest.fn().mockResolvedValue(undefined);
    module = await Test.createTestingModule({
      imports: [EventEmitterModule.forRoot()],
      providers: [
        NodeOfflineNotifier,
        { provide: NotificationsService, useValue: { notifyPermissionHolders } },
        {
          provide: ConfigService,
          useValue: { get: (key: string) => (key === 'appUrl' ? 'https://app.example.com/' : undefined) },
        },
      ],
    }).compile();
    await module.init();
    emitter = module.get(EventEmitter2);
  });

  afterEach(async () => {
    await module.close();
  });

  const offline = () =>
    new NodeOfflineEvent('node-1', 'build-box', new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:20:00Z'), 20);

  it('raises nodes.node_offline to the nodes:read audience with the template payload', () => {
    emitter.emit(NODE_OFFLINE_EVENT, offline());

    expect(notifyPermissionHolders).toHaveBeenCalledTimes(1);
    const [key, permission, payload] = notifyPermissionHolders.mock.calls[0];
    expect(key).toBe('nodes.node_offline');
    expect(permission).toBe('nodes:read');
    expect(payload).toMatchObject({
      nodeId: 'node-1',
      nodeName: 'build-box',
      staleAfterMinutes: 20,
      appUrl: 'https://app.example.com',
    });
  });

  it('does not throw when the dispatcher throws or rejects', async () => {
    notifyPermissionHolders.mockImplementationOnce(() => {
      throw new Error('boom');
    });
    expect(() => emitter.emit(NODE_OFFLINE_EVENT, offline())).not.toThrow();

    notifyPermissionHolders.mockRejectedValueOnce(new Error('rejected'));
    expect(() => emitter.emit(NODE_OFFLINE_EVENT, offline())).not.toThrow();
    await Promise.resolve();
  });
});
