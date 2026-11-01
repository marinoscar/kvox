import { type ExecutionContext, Inject, Injectable, Optional, createParamDecorator } from '@nestjs/common';

import { KVOX_SETTINGS, type KvoxSettingsPort } from '../../ports/index.js';
import { KVOX_DEFAULT_TIME_ZONE, KVOX_TIME_ZONE_HEADER, isValidTimeZone, pickTimeZone } from './time-zone.js';

/**
 * The raw `X-Time-Zone` request header, as a handler parameter (undefined when
 * the client sent none). Hand it to {@link KvoxTimeZoneService.forRequest}.
 *
 * @example
 * ```ts
 * @Get('activity')
 * async activity(@CurrentKvoxPrincipal() who: KvoxPrincipal, @TimeZoneHeader() header?: string) {
 *   const timeZone = await this.zones.forRequest(who.userId, header);
 * }
 * ```
 *
 * @stability experimental
 */
export const TimeZoneHeader: (...dataOrPipes: unknown[]) => ParameterDecorator = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string | undefined => {
    const request = context.switchToHttp().getRequest<{ headers?: Record<string, string | string[] | undefined> }>();
    const raw = request.headers?.[KVOX_TIME_ZONE_HEADER];
    return Array.isArray(raw) ? raw[0] : raw;
  },
);

/**
 * Resolves the zone a date operation follows: the user's stored zone (the settings
 * port), then a valid `X-Time-Zone` header, then UTC. Provided globally by
 * {@link KvoxPortsModule}; a slice injects it by class. Never throws.
 *
 * @stability experimental
 */
@Injectable()
export class KvoxTimeZoneService {
  constructor(@Optional() @Inject(KVOX_SETTINGS) private readonly settings?: KvoxSettingsPort) {}

  /**
   * The zone of a user outside any request (a job, a cron): the stored zone, else UTC.
   *
   * @param userId - the user.
   * @returns a valid IANA zone id.
   */
  async forUser(userId: string): Promise<string> {
    return this.forRequest(userId, undefined);
  }

  /**
   * The zone of a request: the stored zone, else the header, else UTC.
   *
   * @param userId - the requester.
   * @param header - the raw `X-Time-Zone` header value ({@link TimeZoneHeader}).
   * @returns a valid IANA zone id.
   */
  async forRequest(userId: string, header: string | null | undefined): Promise<string> {
    let stored: string | null = null;
    try {
      stored = (await this.settings?.readUserTimeZone(userId)) ?? null;
    } catch {
      stored = null;
    }
    return pickTimeZone(isValidTimeZone(stored) ? stored : null, header, KVOX_DEFAULT_TIME_ZONE);
  }
}
