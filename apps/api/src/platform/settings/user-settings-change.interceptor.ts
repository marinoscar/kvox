// =============================================================================
// `user-settings.namespace-changed`, emitted around the platform's routes
// (issue #466, epic #462)
// =============================================================================
//
// PLATFORM-ADOPTION-SHIM(#466): the graph module re-scans when a user changes a
// resolution threshold (`GraphPreferencesChangeForwarder` turns
// `user-settings.namespace-changed` with `key === 'graph'` into
// `graph.preferences_changed`). KVox's own settings service emitted that event;
// the platform's does not. This global interceptor restores it for the two write
// routes: it reads the caller's namespaces before the handler runs and diffs
// them against the response afterwards, emitting once per namespace whose value
// changed (compared on `JSON.stringify`).
//
// A throwing listener must never turn a committed settings write into an error
// response, so each emit is guarded. Listeners only enqueue (root rule 1).
// =============================================================================

import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  UserSettingsService,
  userSettingsNamespaceRegistry,
} from '@marinoscar/platform-api/settings';
import { Observable, from, mergeMap, tap } from 'rxjs';

import {
  USER_SETTINGS_NAMESPACE_CHANGED_EVENT,
  type UserSettingsNamespaceChangedEvent,
} from './user-settings.events';

const USER_SETTINGS_PATH = '/api/user-settings';

interface RequestLike {
  method?: string;
  url?: string;
  requestUser?: { id?: string };
  user?: { id?: string };
}

@Injectable()
export class UserSettingsChangeInterceptor implements NestInterceptor {
  private readonly logger = new Logger(UserSettingsChangeInterceptor.name);

  constructor(
    private readonly userSettings: UserSettingsService,
    private readonly events: EventEmitter2,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();

    const request = context.switchToHttp().getRequest<RequestLike>();
    const method = request.method?.toUpperCase();
    const path = (request.url ?? '').split('?')[0].replace(/\/+$/, '');
    if ((method !== 'PUT' && method !== 'PATCH') || path !== USER_SETTINGS_PATH) {
      return next.handle();
    }

    const userId = (request.requestUser ?? request.user)?.id;
    if (!userId) return next.handle();

    return from(this.read(userId)).pipe(
      mergeMap((before) =>
        next.handle().pipe(
          tap((result) => {
            const body = (result as { data?: unknown } | null)?.data ?? result;
            this.emitChanges(userId, before, body as Record<string, unknown> | null);
          }),
        ),
      ),
    );
  }

  private async read(userId: string): Promise<Record<string, unknown> | null> {
    try {
      return (await this.userSettings.getSettings(userId)) as unknown as Record<string, unknown>;
    } catch {
      // The write itself will surface whatever is wrong.
      return null;
    }
  }

  private emitChanges(
    userId: string,
    previous: Record<string, unknown> | null,
    next: Record<string, unknown> | null,
  ): void {
    if (!next) return;
    const before = previous ?? {};

    for (const ns of userSettingsNamespaceRegistry.list()) {
      if (JSON.stringify(before[ns.key]) === JSON.stringify(next[ns.key])) {
        continue;
      }

      const event: UserSettingsNamespaceChangedEvent = {
        userId,
        key: ns.key,
        previous: before[ns.key],
        next: next[ns.key],
      };
      try {
        this.events.emit(USER_SETTINGS_NAMESPACE_CHANGED_EVENT, event);
      } catch (error) {
        this.logger.error(
          `A ${USER_SETTINGS_NAMESPACE_CHANGED_EVENT} listener threw for user ${userId} ` +
            `(namespace "${ns.key}"); the settings write is unaffected: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
}
