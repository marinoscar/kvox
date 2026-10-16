import { Inject, Injectable, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { KvoxEventEmitterEvents, KvoxPortsModule } from '../src/core/index.js';
import {
  KVOX_AI,
  KVOX_AUDIT,
  KVOX_EVENTS,
  KVOX_JOBS,
  type KvoxAiPort,
  type KvoxAuditPort,
  type KvoxEventsPort,
} from '../src/ports/index.js';
import { createKvoxFakePorts, createKvoxTestingModule } from '../src/testing/index.js';

describe('KvoxPortsModule.forRoot', () => {
  const full = () => {
    const ports = createKvoxFakePorts();
    const v = <T>(useValue: T) => ({ useValue });
    return {
      ai: v(ports.ai),
      objectStore: v(ports.objectStore),
      jobs: v(ports.jobs),
      identity: v(ports.identity),
      notify: v(ports.notify),
      prisma: v(ports.prisma),
      settings: v(ports.settings),
      secrets: v(ports.secrets),
    };
  };

  it('names every missing required port in one error', () => {
    const { jobs: _jobs, secrets: _secrets, ...rest } = full();
    expect(() => KvoxPortsModule.forRoot({ ports: rest as never })).toThrow(/KVOX_JOBS \(ports\.jobs\), KVOX_SECRETS \(ports\.secrets\)/);
  });

  it('names a single missing port', () => {
    const { ai: _ai, ...rest } = full();
    expect(() => KvoxPortsModule.forRoot({ ports: rest as never })).toThrow(/no binding for port KVOX_AI/);
  });

  it('treats an empty binding as missing', () => {
    expect(() => KvoxPortsModule.forRoot({ ports: { ...full(), notify: {} as never } })).toThrow(/KVOX_NOTIFY/);
  });

  it('is global and injects every token without the consumer importing anything', async () => {
    const jobsFake = createKvoxFakePorts().jobs;

    @Injectable()
    class Consumer {
      constructor(
        @Inject(KVOX_AI) readonly ai: KvoxAiPort,
        @Inject(KVOX_EVENTS) readonly events: KvoxEventsPort,
        @Inject(KVOX_AUDIT) readonly audit: KvoxAuditPort,
        @Inject(KVOX_JOBS) readonly jobs: unknown,
      ) {}
    }

    @Module({
      imports: [KvoxPortsModule.forRoot({ ports: { ...full(), jobs: { useValue: jobsFake } } })],
      providers: [Consumer],
    })
    class AppModule {}

    const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
    try {
      const consumer = app.get(Consumer);
      expect(consumer.jobs).toBe(jobsFake);
      expect(consumer.events).toBeInstanceOf(KvoxEventEmitterEvents);
      await expect(consumer.audit.record({ actorUserId: null, action: 'a', targetType: 't', targetId: '1' })).resolves.toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it('accepts class, existing, factory and value bindings', async () => {
    const base = createKvoxFakePorts();

    @Injectable()
    class AiBinding {
      readonly marker = 'class';
    }

    @Module({
      imports: [
        KvoxPortsModule.forRoot({
          ports: {
            ...full(),
            ai: { useClass: AiBinding as never },
            jobs: { useFactory: () => base.jobs },
          },
        }),
      ],
    })
    class AppModule {}

    const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
    try {
      expect((app.get(KVOX_AI, { strict: false }) as { marker: string }).marker).toBe('class');
      expect(app.get(KVOX_JOBS, { strict: false })).toBe(base.jobs);
    } finally {
      await app.close();
    }
  });

  it('createKvoxTestingModule binds a fake to every port, with overrides', async () => {
    const ai = createKvoxFakePorts().ai;

    @Module({ imports: [createKvoxTestingModule({ overrides: { ai } })] })
    class AppModule {}

    const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
    try {
      expect(app.get(KVOX_AI, { strict: false })).toBe(ai);
    } finally {
      await app.close();
    }
  });
});
