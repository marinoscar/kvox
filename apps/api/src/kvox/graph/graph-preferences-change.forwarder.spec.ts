import { BadRequestException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { lastValueFrom, from } from 'rxjs';
import { GRAPH_PREFERENCE_DEFAULTS, GRAPH_PREFERENCES_CHANGED_EVENT, type GraphPreferencesChangedEvent } from '@marinoscar/kvox-api/graph';
import type { KvoxEventsPort } from '@marinoscar/kvox-api/ports';
import { PLATFORM_PRISMA } from '@marinoscar/platform-api/core';
import { PrincipalCache } from '@marinoscar/platform-api/identity';

import { normalizeProfileSettings } from '@marinoscar/platform-api/storage';
import { UserSettingsChangeInterceptor } from '../../platform/settings/user-settings-change.interceptor';
import {
  USER_SETTINGS_NAMESPACE_CHANGED_EVENT,
  type UserSettingsNamespaceChangedEvent,
} from '../../platform/settings/user-settings.events';
import { SETTINGS_PROFILE_IMAGES, UserSettingsService } from '@marinoscar/platform-api/settings';
import {
  createMockPrismaService,
  type MockPrismaService,
} from '../../../test/mocks/prisma.mock';
import { GraphPreferencesChangeForwarder } from './graph-preferences-change.forwarder';

// =============================================================================
// GraphPreferencesChangeForwarder (issue #459, #369)
// =============================================================================
//
// The settings module announces `user-settings.namespace-changed` for every
// namespace a write changed; this forwarder is the application's side of that, publishing the slice's event on the event port.
// The cases here are the graph-specific emission cases that used to live in
// `user-settings.service.spec.ts` (when the service itself emitted
// `graph.preferences_changed`): the same payloads, the same "only when the
// EFFECTIVE preferences changed" rule, the same silence otherwise.
//
// Two layers:
//   1. the forwarder alone, fed namespace-changed events directly;
//   2. the platform's real `UserSettingsService` behind KVox's
//      `UserSettingsChangeInterceptor` (which announces the namespace changes
//      the platform service does not) and a real `EventEmitter2` with the
//      forwarder subscribed, driven by PATCH/PUT calls - the acceptance
//      criterion "changing `graph.resolution` through PATCH /api/user-settings
//      still emits `graph.preferences_changed` once with the same payload, and
//      an out-of-order threshold still answers 400".
// =============================================================================

const USER_ID = 'user-123';

const DEFAULT_RESOLUTION = {
  mode: 'precheck_confident',
  autoLinkThreshold: 0.9,
  newThreshold: 0.55,
  adjudication: 'llm',
};

function namespaceChanged(
  previous: unknown,
  next: unknown,
  key = 'graph',
): UserSettingsNamespaceChangedEvent {
  return { userId: USER_ID, key, previous, next };
}

describe('GraphPreferencesChangeForwarder', () => {
  describe('subscription', () => {
    it('listens for the generic user-settings namespace-changed event', () => {
      const listeners = Reflect.getMetadata(
        'EVENT_LISTENER_METADATA',
        GraphPreferencesChangeForwarder.prototype.forward,
      );

      expect(listeners).toEqual([
        expect.objectContaining({ event: USER_SETTINGS_NAMESPACE_CHANGED_EVENT }),
      ]);
    });
  });

  describe('forward()', () => {
    let emit: jest.Mock;
    let forwarder: GraphPreferencesChangeForwarder;

    beforeEach(() => {
      emit = jest.fn();
      forwarder = new GraphPreferencesChangeForwarder({ emit } as unknown as KvoxEventsPort);
    });

    it('ignores every namespace but graph', () => {
      forwarder.forward(namespaceChanged(undefined, { railCollapsed: true }, 'navigation'));
      forwarder.forward(namespaceChanged(undefined, { jobs: { pageSize: 25 } }, 'dataTables'));

      expect(emit).not.toHaveBeenCalled();
    });

    it('emits graph.preferences_changed naming the changed sub-objects, with resolved values', () => {
      forwarder.forward(
        namespaceChanged(undefined, {
          resolution: { autoLinkThreshold: 0.93 },
          domains: { work: false },
        }),
      );

      expect(emit).toHaveBeenCalledTimes(1);
      const [name, payload] = emit.mock.calls[0];
      expect(name).toBe(GRAPH_PREFERENCES_CHANGED_EVENT);
      expect(payload).toEqual({
        userId: USER_ID,
        changed: ['resolution', 'domains'],
        previous: {
          extraction: { autoExtract: true },
          resolution: DEFAULT_RESOLUTION,
          domains: { core: true, work: true, personal: false },
        },
        next: {
          extraction: { autoExtract: true },
          resolution: { ...DEFAULT_RESOLUTION, autoLinkThreshold: 0.93 },
          domains: { core: true, work: false, personal: false },
        },
      });
    });

    it('resolves absent sides against the defaults', () => {
      forwarder.forward(namespaceChanged({ extraction: { autoExtract: false } }, undefined));

      expect(emit).toHaveBeenCalledTimes(1);
      const payload = emit.mock.calls[0][1] as GraphPreferencesChangedEvent;
      expect(payload.changed).toEqual(['extraction']);
      expect(payload.previous.extraction.autoExtract).toBe(false);
      expect(payload.next).toEqual(GRAPH_PREFERENCE_DEFAULTS);
    });

    it('reports domains.personal turning on (#383)', () => {
      forwarder.forward(
        namespaceChanged(
          { domains: { work: false, personal: false } },
          { domains: { work: false, personal: true } },
        ),
      );

      const [name, payload] = emit.mock.calls[0];
      expect(name).toBe(GRAPH_PREFERENCES_CHANGED_EVENT);
      expect(payload.changed).toEqual(['domains']);
      expect(payload.next.domains).toEqual({ core: true, work: false, personal: true });
    });

    it('does not emit when the effective values are unchanged (explicit default over absent)', () => {
      forwarder.forward(namespaceChanged(undefined, { extraction: { autoExtract: true } }));

      expect(emit).not.toHaveBeenCalled();
    });

    it('does not emit when a restated namespace resolves to the same preferences', () => {
      const same = { resolution: { ...DEFAULT_RESOLUTION, autoLinkThreshold: 0.93 } };

      forwarder.forward(namespaceChanged(same, { ...same }));

      expect(emit).not.toHaveBeenCalled();
    });

    it('lets a throwing downstream listener propagate: the settings service owns the guard', () => {
      emit.mockImplementation(() => {
        throw new Error('listener boom');
      });

      expect(() =>
        forwarder.forward(namespaceChanged(undefined, { extraction: { autoExtract: false } })),
      ).toThrow('listener boom');
    });
  });

  // ---------------------------------------------------------------------------
  // End to end through the real settings service (no database, no Nest app)
  // ---------------------------------------------------------------------------
  describe('through UserSettingsService PATCH/PUT', () => {
    let userSettings: UserSettingsService;
    let interceptor: UserSettingsChangeInterceptor;
    let mockPrisma: MockPrismaService;
    let graphChanged: jest.Mock;

    /**
     * What `PATCH|PUT /api/user-settings` does: the interceptor reads the
     * settings before, runs the platform service, and announces each namespace
     * that differs. An error from the service propagates out of the observable.
     */
    function through(method: 'PATCH' | 'PUT', write: () => Promise<unknown>): Promise<unknown> {
      const context = {
        getType: () => 'http',
        switchToHttp: () => ({
          getRequest: () => ({ method, url: '/api/user-settings', requestUser: { id: USER_ID } }),
        }),
      };
      const handler = { handle: () => from(write().then((data) => ({ data }))) };
      return lastValueFrom(interceptor.intercept(context as never, handler as never)).then(
        (r) => (r as { data: unknown }).data,
      );
    }

    const service = {
      patchSettings: (userId: string, dto: unknown) =>
        through('PATCH', () => userSettings.patchSettings(userId, dto as never)),
      replaceSettings: (userId: string, dto: unknown) =>
        through('PUT', () => userSettings.replaceSettings(userId, dto as never)),
    };

    const BASE = { theme: 'system', profile: { imageSource: 'provider' } };
    const row = (value: Record<string, unknown>) => ({
      id: 'settings-1',
      userId: USER_ID,
      value,
      version: 1,
      updatedAt: new Date(),
    });

    function stored(namespaces: Record<string, unknown>) {
      mockPrisma.userSettings.findUnique.mockResolvedValue(
        row({ ...BASE, ...namespaces }) as any,
      );
    }

    function echoWrites() {
      (mockPrisma.userSettings.update as any).mockImplementation(async ({ data }: any) =>
        row(data.value),
      );
      (mockPrisma.userSettings.upsert as any).mockImplementation(async ({ update }: any) =>
        row(update.value),
      );
      mockPrisma.user.update.mockResolvedValue({} as any);
    }

    beforeEach(async () => {
      mockPrisma = createMockPrismaService();
      const events = new EventEmitter2();
      // The event port over the same emitter, as the web edition binds it.
      const port: KvoxEventsPort = {
        emit: (name, payload) => void events.emit(name, payload),
        subscribe: (name, handler) => {
          events.on(name, handler);
          return () => void events.off(name, handler);
        },
      };
      const forwarder = new GraphPreferencesChangeForwarder(port);
      events.on(USER_SETTINGS_NAMESPACE_CHANGED_EVENT, (event: UserSettingsNamespaceChangedEvent) =>
        forwarder.forward(event),
      );
      graphChanged = jest.fn();
      events.on(GRAPH_PREFERENCES_CHANGED_EVENT, graphChanged);

      const module = await Test.createTestingModule({
        providers: [
          UserSettingsService,
          UserSettingsChangeInterceptor,
          { provide: PLATFORM_PRISMA, useValue: mockPrisma },
          { provide: PrincipalCache, useValue: { invalidate: jest.fn() } },
          {
            provide: SETTINGS_PROFILE_IMAGES,
            useValue: { normalize: normalizeProfileSettings, isUploadedAvatar: async () => false },
          },
          { provide: EventEmitter2, useValue: events },
        ],
      }).compile();
      userSettings = module.get(UserSettingsService);
      interceptor = module.get(UserSettingsChangeInterceptor);
      echoWrites();
    });

    it('PATCH of graph.resolution emits once, naming resolution, with resolved values', async () => {
      stored({});

      await service.patchSettings(USER_ID, {
        graph: { resolution: { autoLinkThreshold: 0.93 } },
      } as any);

      expect(graphChanged).toHaveBeenCalledTimes(1);
      expect(graphChanged).toHaveBeenCalledWith({
        userId: USER_ID,
        changed: ['resolution'],
        previous: GRAPH_PREFERENCE_DEFAULTS,
        next: {
          ...GRAPH_PREFERENCE_DEFAULTS,
          resolution: { ...DEFAULT_RESOLUTION, autoLinkThreshold: 0.93 },
        },
      });
    });

    it('PATCH of several sub-objects emits once naming all of them, in a stable order', async () => {
      stored({});

      await service.patchSettings(USER_ID, {
        graph: {
          resolution: { autoLinkThreshold: 0.93 },
          domains: { work: false },
        },
      } as any);

      expect(graphChanged).toHaveBeenCalledTimes(1);
      expect(graphChanged.mock.calls[0][0].changed).toEqual(['resolution', 'domains']);
    });

    it('PATCH with a default written explicitly over an absent namespace emits nothing', async () => {
      stored({});

      await service.patchSettings(USER_ID, {
        graph: { extraction: { autoExtract: true } },
      } as any);

      expect(graphChanged).not.toHaveBeenCalled();
    });

    it('an unrelated PATCH emits nothing', async () => {
      stored({ graph: { extraction: { autoExtract: false } } });

      await service.patchSettings(USER_ID, { theme: 'dark' } as any);

      expect(graphChanged).not.toHaveBeenCalled();
    });

    it('a change to another namespace emits nothing graph-related', async () => {
      stored({});

      await service.patchSettings(USER_ID, {
        navigation: { railCollapsed: true },
      } as any);

      expect(graphChanged).not.toHaveBeenCalled();
    });

    it('an out-of-order threshold still answers 400 with the same message and emits nothing', async () => {
      stored({ graph: { resolution: { ...DEFAULT_RESOLUTION, newThreshold: 0.8 } } });

      const attempt = service.patchSettings(USER_ID, {
        graph: { resolution: { autoLinkThreshold: 0.82 } },
      } as any);

      await expect(attempt).rejects.toBeInstanceOf(BadRequestException);
      await expect(attempt).rejects.toThrow(
        'graph.resolution: newThreshold must be at least 0.05 below autoLinkThreshold (would store newThreshold 0.8, autoLinkThreshold 0.82).',
      );
      expect(mockPrisma.userSettings.update).not.toHaveBeenCalled();
      expect(graphChanged).not.toHaveBeenCalled();
    });

    it('PUT emits for the sub-objects it changed', async () => {
      stored({ graph: { extraction: { autoExtract: false } } });

      await service.replaceSettings(USER_ID, {
        theme: 'system',
        profile: { imageSource: 'provider' },
        graph: { domains: { work: false, personal: false } },
      } as any);

      expect(graphChanged).toHaveBeenCalledTimes(1);
      expect(graphChanged).toHaveBeenCalledWith(
        expect.objectContaining({ userId: USER_ID, changed: ['extraction', 'domains'] }),
      );
    });

    it('PUT restating the same preferences emits nothing', async () => {
      stored({ graph: { extraction: { autoExtract: false } } });

      await service.replaceSettings(USER_ID, {
        theme: 'system',
        profile: { imageSource: 'provider' },
        graph: { extraction: { autoExtract: false } },
      } as any);

      expect(graphChanged).not.toHaveBeenCalled();
    });

    it('a throwing graph listener does not fail the write', async () => {
      stored({});
      graphChanged.mockImplementation(() => {
        throw new Error('listener boom');
      });

      await expect(
        service.patchSettings(USER_ID, {
          graph: { extraction: { autoExtract: false } },
        } as any),
      ).resolves.toMatchObject({ graph: { extraction: { autoExtract: false } } });
    });
  });
});
