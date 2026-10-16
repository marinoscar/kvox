import { EventEmitter } from 'node:events';

import { Logger } from '@nestjs/common';

import type { KvoxEventsPort } from '../../ports/index.js';

/**
 * The part of an event emitter {@link KvoxEventEmitterEvents} needs. Structural,
 * so Nest's `EventEmitter2` (from the optional `@nestjs/event-emitter` peer) and
 * Node's `EventEmitter` both fit, and this slice imports neither package.
 *
 * @stability experimental
 */
export interface KvoxEmitterLike {
  /**
   * Emits an event to its listeners.
   *
   * @param event - the event name.
   * @param values - the arguments the listeners receive.
   */
  emit(event: string, ...values: unknown[]): unknown;

  /**
   * Adds a listener.
   *
   * @param event - the event name.
   * @param listener - called with the emitted arguments.
   */
  on(event: string, listener: (...args: any[]) => void): unknown;

  /**
   * Removes a listener.
   *
   * @param event - the event name.
   * @param listener - the function passed to `on`.
   */
  off(event: string, listener: (...args: any[]) => void): unknown;
}

/**
 * A default {@link KvoxEventsPort} over an event emitter: in-process, one
 * process only. Pass Nest's `EventEmitter2` to share the application's bus (the
 * `@OnEvent` listeners then see the same events); with no argument a private
 * Node emitter is used, which is what Desktop and the tests want.
 *
 * `emit` never throws and never waits for a listener. A listener that throws, or
 * returns a promise that rejects, is logged and does not reach the emitter.
 *
 * @stability experimental
 */
export class KvoxEventEmitterEvents implements KvoxEventsPort {
  private readonly logger = new Logger('KvoxEvents');

  private readonly emitter: KvoxEmitterLike;

  /**
   * @param emitter - the emitter to publish on; a private Node emitter when absent.
   */
  constructor(emitter?: KvoxEmitterLike) {
    this.emitter = emitter ?? new EventEmitter();
  }

  /**
   * Publishes an event. Never throws and never waits for listeners.
   *
   * @param name - the event name.
   * @param payload - plain data.
   */
  emit(name: string, payload: unknown): void {
    try {
      this.emitter.emit(name, payload);
    } catch (error) {
      this.logger.warn(`Event "${name}" failed to emit: ${describe(error)}`);
    }
  }

  /**
   * Listens for an event; a listener that throws or rejects is logged.
   *
   * @param name - the event name.
   * @param handler - called for each event.
   * @returns a function that removes the listener.
   */
  subscribe(name: string, handler: (payload: unknown) => Promise<void> | void): () => void {
    const listener = (payload: unknown): void => {
      try {
        const result = handler(payload);
        if (result && typeof (result as Promise<void>).then === 'function') {
          (result as Promise<void>).catch((error: unknown) => {
            this.logger.warn(`A listener of "${name}" failed: ${describe(error)}`);
          });
        }
      } catch (error) {
        this.logger.warn(`A listener of "${name}" failed: ${describe(error)}`);
      }
    };

    this.emitter.on(name, listener);

    return () => {
      this.emitter.off(name, listener);
    };
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
