// =============================================================================
// Job handler registry (issue #259, epic #254)
// =============================================================================
//
// The one place that knows which job types this process can execute. The
// worker (#262) holds a reference to this and nothing else: it claims a row,
// reads `job.type`, calls `get(type)`, and calls `process`. It has no
// `switch`, no import of any handler, and no reason to change when a handler
// is added — which is the entire point of epic #254's "one class, no queue
// wiring" promise.
//
// -----------------------------------------------------------------------------
// EXPLICIT SELF-REGISTRATION, NOT DECORATOR DISCOVERY
// -----------------------------------------------------------------------------
//
// Each handler calls `this.registry.register(this)` from its OWN
// `OnModuleInit`. Nest can do better-looking things than this: a
// `@JobHandler()` decorator plus `DiscoveryService` would let a handler
// register merely by existing, with no lifecycle hook and no injected
// registry.
//
// REJECTED, for the reason `notifications.module.ts` already states about its
// channel factory ("a channel added by an import side effect is a channel
// that appears in production without appearing in a diff"):
//
//   - It is more magic, not less code. `DiscoveryService` still needs a
//     registry underneath to hold the scan's results; discovery replaces the
//     `register` call with a metadata scan and keeps everything else.
//   - It is harder to trace. "Why is this type running?" has a grep-able
//     answer today — one `register(this)` line in one file. Under discovery
//     the answer is "because a decorator you cannot see from here matched a
//     scan at boot", and a handler that failed to register looks identical to
//     one that never existed.
//   - It disagrees with how this repository already does the same job in two
//     other places: `NOTIFICATION_CHANNEL_SENDERS` is an explicit factory
//     list, and the storage object processors are explicit `OBJECT_PROCESSOR`
//     providers. A third mechanism for "collect the implementations of an
//     interface" would be a third thing to learn.
//
// -----------------------------------------------------------------------------
// ⚠ THE LIFECYCLE CONSEQUENCE THE WORKER (#262) MUST RESPECT
// -----------------------------------------------------------------------------
//
// Because registration happens in each handler's `OnModuleInit`, THE WORKER
// MUST START FROM `OnApplicationBootstrap`, NOT `OnModuleInit`.
//
// Nest runs every `onModuleInit` hook in one phase, in module-resolution
// order, and only afterwards runs every `onApplicationBootstrap` hook. A
// worker that started polling from `onModuleInit` would therefore be racing
// the very registrations it depends on: whether `get(type)` finds a handler
// would come down to which module Nest happened to initialise first. And the
// failure is not a retryable blip — a claimed job whose type has no
// registered handler is an "unknown job type" error, which is a PERMANENT
// failure for a perfectly good job that would have run fine one second later.
// Starting at `onApplicationBootstrap` makes the ordering a guarantee rather
// than luck: every handler has registered before the first claim query runs.
//
// `job.worker.ts` satisfies this and says so from its side; the two headers
// point at each other on purpose, because the file that creates a hazard and
// the file that must respect it are the two places somebody will be reading
// when they consider changing either. §1.3 of docs/specs/job-queue.md is the
// third, and `job.worker.bootstrap.spec.ts` is the test that would fail.
// =============================================================================

import { Injectable, Logger } from '@nestjs/common';

import { JobHandler } from './job-handler.interface';

@Injectable()
export class JobHandlerRegistry {
  private readonly logger = new Logger(JobHandlerRegistry.name);

  private readonly handlers = new Map<string, JobHandler>();

  /**
   * Adds `handler` under its own `type`, replacing any handler already
   * registered under that type.
   *
   * OVERWRITE, LOUDLY — deliberately not "throw" and not "first one wins".
   *
   *   - Throwing would turn a duplicate into a boot failure for the entire
   *     application. A fork that shadows a framework handler with its own
   *     implementation of the same type is doing something legitimate (it is
   *     how you replace framework behaviour without editing framework code),
   *     and a template should not make that impossible.
   *   - First-one-wins would make the override depend on module-resolution
   *     order, which is exactly the kind of invisible coupling the explicit
   *     registration above exists to avoid — and it would silently ignore the
   *     handler the author most likely meant to win.
   *
   * So the LAST registration wins, and the collision is logged at `warn` so it
   * is visible in logs whether it was intended or a copy-pasted `type` string
   * two features apart. `warn` rather than `error`: an intentional override is
   * not a fault.
   */
  register(handler: JobHandler): void {
    const existing = this.handlers.get(handler.type);

    if (existing) {
      this.logger.warn(
        `Duplicate job handler for type "${handler.type}": ` +
          `${existing.constructor.name} is being replaced by ` +
          `${handler.constructor.name}. The last registration wins.`,
      );
    }

    this.handlers.set(handler.type, handler);
  }

  /**
   * The handler for `type`, or `undefined` when nothing is registered.
   *
   * RETURNS `undefined` RATHER THAN THROWING, for the same reason
   * `findEvent()` does in `notification-events.ts`: the caller is holding a
   * string that came out of the database, and a `jobs` row can legitimately
   * name a type this process cannot run — a handler that was removed, renamed,
   * or (once the node plane exists) one that only some deployments register.
   * The caller decides what an unknown type means; the registry does not
   * decide it for them by throwing.
   */
  get(type: string): JobHandler | undefined {
    return this.handlers.get(type);
  }

  /**
   * Every registered type, in registration order.
   *
   * This is what the admin dashboard lists and what makes a fork's own job
   * types appear there with no migration and no UI change (see
   * `job-type-labels.ts` for how an unmapped type still renders).
   */
  types(): string[] {
    return [...this.handlers.keys()];
  }

  /**
   * The registered types that CANNOT be computed on a remote worker node.
   *
   * DERIVED, never declared — see `job-handler.interface.ts`'s header for the
   * full argument. A type is node-eligible only when its handler carries BOTH
   * `nodeResultSchema` and `persistNodeResult`; anything else, including a
   * handler carrying exactly one of the two, is server-only. There is no
   * `nodeEligible` flag anywhere to disagree with this, and no second list of
   * server-only types to keep in sync — which is what lets the later `system`
   * worker mode ("claim only what a node could never run") be a single call
   * to this method.
   */
  serverOnlyTypes(): string[] {
    return this.types().filter((type) => {
      const handler = this.handlers.get(type);

      if (!handler) {
        return false;
      }

      const nodeEligible =
        handler.nodeResultSchema !== undefined &&
        typeof handler.persistNodeResult === 'function';

      return !nodeEligible;
    });
  }
}
