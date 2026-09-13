import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Sse,
} from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiProduces,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Observable } from 'rxjs';

import { ApiDataResponse } from '../common/decorators/api-data-response.decorator';
import { Auth } from '../auth/decorators/auth.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { NOTIFICATION_EVENTS } from './notification-events';
import { policyChannels } from './notification-policy';
import { NotificationPolicyService } from './notification-policy.service';
import {
  NotificationStreamService,
  type SseMessage,
} from './notification-stream.service';
import { NotificationStoreService } from './notification-store.service';
import { PushSubscriptionService } from './push-subscription.service';
import {
  NotificationConfigDto,
  type NotificationConfigResponse,
} from './dto/notification-config.dto';
import {
  NotificationEventDto,
  type NotificationEventResponse,
} from './dto/notification-event.dto';
import {
  NotificationDto,
  NotificationListQueryDto,
  UnreadCountDto,
  type NotificationListResponse,
  type UnreadCountResponse,
} from './dto/notification.dto';
import {
  PushSubscribeDto,
  PushSubscriptionResponseDto,
  PushUnsubscribeDto,
  type PushSubscriptionResponse,
} from './dto/push-subscription.dto';

// =============================================================================
// NotificationsController (issues #124/#127, epic #109)
// =============================================================================
//
// #124 shipped one endpoint here: the event registry. #127 adds the browser
// channel's entire read surface — the live stream and the four calls behind
// the notification centre.
//
// -----------------------------------------------------------------------------
// EVERY ENDPOINT BELOW IS SCOPED TO THE CALLER, AND THERE IS NO USER ID INPUT
// -----------------------------------------------------------------------------
//
// This is the security property epic #109 hangs on #127, so it is worth
// stating in the one file where it could be broken by a single added
// parameter: `@CurrentUser('id')` is the ONLY source of a user id in this
// controller. Not a path parameter, not a query parameter, not a body field.
// There is no `GET /notifications?userId=…` to forget to authorise, and no
// admin variant that takes an id — a route that could name another user is a
// route somebody has to remember to guard, and #127 chose to have none.
//
// The service layer holds the second half of the same guarantee: every
// statement in `notification-store.service.ts` carries `userId` in its `where`
// clause rather than checking ownership after the fact. See its header.
// =============================================================================

@ApiTags('Notifications')
@Controller('notifications')
export class NotificationsController {
  constructor(
    private readonly store: NotificationStoreService,
    // `streams`, plural, and not `stream`: the handler below is named `stream`
    // and a field of the same name shadows it on the class.
    private readonly streams: NotificationStreamService,
    // The admin policy (#226), for `GET /events` and `GET /config`. Same
    // reader the dispatcher uses, so the two cannot disagree.
    private readonly policy: NotificationPolicyService,
    // Push subscription storage (#229), for `GET /config` and the two
    // `push/subscriptions` endpoints below.
    private readonly pushSubscriptions: PushSubscriptionService,
  ) {}

  @Get('events')
  @Auth()
  @ApiOperation({
    summary: 'List notification events',
    description:
      'The registry of events this application can raise, in the order the ' +
      'preferences UI should render them. Readable by **any authenticated user** — ' +
      'every user renders their own preferences against it.\n\n' +
      'This describes what events *exist*, not what the caller has chosen. An event ' +
      'with `mandatory: true` cannot be switched off; that is enforced server-side ' +
      'during delivery, and the flag is here so the UI can show the control disabled ' +
      'with a reason rather than hiding it.\n\n' +
      '**`channels` is capability ∩ administrator policy.** An event that can be ' +
      'delivered over `browser` does not list it while an administrator has browser ' +
      'notifications switched off deployment-wide, or has suppressed that event, in ' +
      'system settings — the delivery path applies the identical filter, so a channel ' +
      'listed here is a channel that will be used and one omitted is one that will not. ' +
      'A `mandatory` event is the exception: its channels are never filtered, because ' +
      'its stored notification is the delivery. For those, the policy shows up as ' +
      '`toast: false` on the SSE stream instead.',
  })
  @ApiDataResponse(NotificationEventDto, {
    isArray: true,
    description: 'The notification event registry',
  })
  async listEvents(): Promise<NotificationEventResponse[]> {
    // THE SAME POLICY THE DISPATCHER WILL APPLY, from the same function (#226).
    // `resolveChannels` calls `policyChannels` too, which is what makes it
    // impossible for this matrix to offer a channel delivery would refuse — or
    // to hide one it would use. See notification-policy.ts.
    const policy = await this.policy.getPolicy();

    // Mapped field by field rather than returned directly, for three reasons:
    //
    //   1. `mandatory` is normalised from `boolean | undefined` to `boolean`,
    //      so no client has to know that absent means "the user is in charge".
    //   2. `channels` is a FRESH ARRAY out of `policyChannels`. The arrays in
    //      `NOTIFICATION_EVENTS` are the registry's own state and this is a
    //      module-level constant living for the process lifetime; handing out
    //      the live array would let a serialiser or an interceptor that sorts
    //      in place reconfigure delivery for every later dispatch.
    //   3. The response shape is decided here, in code that is about the
    //      response shape. A spread would make it a consequence of whatever
    //      the registry happens to hold, so a field added for the dispatcher's
    //      internal use would silently become public API.
    return NOTIFICATION_EVENTS.map((event) => ({
      key: event.key,
      label: event.label,
      description: event.description,
      channels: policyChannels(event, policy),
      defaultEnabled: event.defaultEnabled,
      mandatory: event.mandatory === true,
    }));
  }

  /**
   * What this deployment can do, for the client that has to decide whether to
   * ask the browser for notification permission.
   *
   * ---------------------------------------------------------------------------
   * `@Auth()` WITH NO PERMISSION, EXACTLY LIKE `GET /events` ABOVE
   * ---------------------------------------------------------------------------
   *
   * Deliberately the same gate, and for the same reason: this is information
   * every signed-in account needs about its own notifications. A `viewer` holds
   * `user_settings:read|write` and `storage:read` and nothing else — so gating
   * this on `system_settings:read` would lock the policy away from precisely the
   * users it governs, and widening THAT permission to reach it would publish the
   * entire settings blob to every account. See the DTO, which carries
   * the full argument and the rejected alternative.
   */
  @Get('config')
  @Auth()
  @ApiOperation({
    summary: 'Notification capabilities of this deployment',
    description:
      'What this deployment can deliver, for a client deciding whether to ask the browser ' +
      'for notification permission. Readable by **any authenticated user** — the policy ' +
      'governs every account, so every account can read it.\n\n' +
      '`browserEnabled` is the administrator’s deployment-wide switch (system settings). ' +
      'A client should not prompt for OS notification permission when it is `false`: browser ' +
      'permission, once denied, cannot be re-prompted, so prompting for a capability this ' +
      'deployment has switched off spends a one-shot decision for nothing.\n\n' +
      '**This is not a delivery switch.** Notifications are still recorded and the ' +
      'notification centre still fills when `browserEnabled` is `false`; what is withheld is ' +
      'the OS toast. Per-event suppression is deliberately not listed here — it travels with ' +
      'each notification as `toast` on the SSE stream, so a long-lived tab holding a cached ' +
      'copy of this response can never re-enable something an administrator has muted.\n\n' +
      '`pushEnabled` reflects whether THIS DEPLOYMENT currently has an ACTIVE VAPID key pair — ' +
      'an admin-configured one from `/admin/push-config` (`PushConfigService` ' +
      '.resolveActiveVapidConfig()`, #355) when one exists and is enabled, falling back to the ' +
      '`VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY` env vars only when no admin configuration has ever ' +
      'been saved. It says nothing about this user’s own subscription state. When `true`, ' +
      '`vapidPublicKey` carries the public key a client needs to call `pushManager.subscribe`; a ' +
      'client should not attempt that call while `pushEnabled` is `false`.',
  })
  @ApiDataResponse(NotificationConfigDto, {
    description: 'This deployment’s notification capabilities',
  })
  async config(): Promise<NotificationConfigResponse> {
    const policy = await this.policy.getPolicy();

    // Both now resolve the ACTIVE key pair through `PushConfigService`
    // (#355): an admin-configured, enabled one from `/admin/push-config`
    // when it exists, else the deploy-time env vars, else neither — see
    // `PushSubscriptionService.isEnabled`/`.getVapidPublicKey` for the
    // one-line delegation and `PushConfigService.resolveActiveVapidConfig`
    // for the full precedence.
    const [pushEnabled, vapidPublicKey] = await Promise.all([
      this.pushSubscriptions.isEnabled(),
      this.pushSubscriptions.getVapidPublicKey(),
    ]);

    return {
      browserEnabled: policy.browserEnabled,
      pushEnabled,
      vapidPublicKey,
    };
  }

  // ---------------------------------------------------------------------------
  // The live stream (#127)
  // ---------------------------------------------------------------------------

  /**
   * Server-Sent Events for the calling user's notifications.
   *
   * -----------------------------------------------------------------------------
   * WHY `@Sse()` AND NOT A HAND-WRITTEN `@Res()` HANDLER
   * -----------------------------------------------------------------------------
   *
   * This app runs the FASTIFY adapter, and the reflex worry is that `@Sse()` is
   * Express-shaped. It is not, as of the Nest 11 this project pins: the SSE
   * dispatch in `router-execution-context` unwraps `res.raw ?? res`, so under
   * Fastify the framework's `SseStream` is piped to the underlying Node
   * `ServerResponse` — which has the `writeHead`/`flushHeaders` it needs. The
   * mechanism is the same one Express gets.
   *
   * Choosing it over hand-writing frames onto a `@Res()` reply buys, for free
   * and already tested:
   *
   *   * The header set, INCLUDING `X-Accel-Buffering: no` — the response-side
   *     half of the nginx buffering problem #127 describes. (The `location`
   *     block with `proxy_buffering off` is still required; that is #127's
   *     infra half and is not in this commit. Both halves are needed: nginx
   *     honours the header, but the read timeout is not something a header can
   *     change.)
   *   * Correct SSE framing, including multi-line `data:` splitting and
   *     `: comment` lines — the heartbeat mechanism below.
   *   * Socket tuning (`setKeepAlive`, `setNoDelay`, `setTimeout(0)`) so Node
   *     itself does not close an idle stream.
   *   * Teardown on client disconnect: it unsubscribes the Observable when the
   *     raw socket emits `close`, which is what runs the registry cleanup in
   *     `NotificationStreamService.subscribe`.
   *
   * A hand-written version would reimplement all of that, and would get the
   * header set subtly wrong the first time.
   *
   * -----------------------------------------------------------------------------
   * ONE CAVEAT FOR THE WEB CLIENT: `EventSource` CANNOT SEND AN `Authorization`
   * HEADER
   * -----------------------------------------------------------------------------
   *
   * This route is guarded by the ordinary `@Auth()` — the same
   * `Authorization: Bearer …` every other endpoint requires. The native
   * `EventSource` constructor takes no headers, so the browser half of #127
   * must connect with a fetch-based SSE client (`@microsoft/fetch-event-source`
   * or equivalent), which supports headers and reconnection both.
   *
   * A `?token=` QUERY PARAMETER WAS REJECTED, and should stay rejected. An
   * access token in a URL is written to the nginx access log, kept in browser
   * history, and forwarded in `Referer` — turning a 15-minute bearer credential
   * into something replayable from a log file that is retained for months and
   * read by people who are not supposed to hold sessions. Making the transport
   * convenient is not worth putting credentials in logs; the client-side
   * library is a smaller cost, paid once.
   *
   * -----------------------------------------------------------------------------
   * WHAT ARRIVES, AND WHAT DOES NOT
   * -----------------------------------------------------------------------------
   *
   * `event: notification` frames whose `data` is one `NotificationDto` (minus
   * `readAt` — it is unread by definition at that instant), plus periodic
   * `: heartbeat` comment lines that `EventSource` swallows without surfacing.
   *
   * NOT A DELIVERY GUARANTEE. Anything published while this connection is down
   * is gone: there is no buffer, no `Last-Event-ID` handling and no replay.
   * `EventSource` will reconnect on its own, and THE CLIENT MUST REFETCH
   * `GET /api/notifications/unread-count` AND `GET /api/notifications` ON EVERY
   * (RE)CONNECT rather than assuming the gap was filled. That is not a
   * shortcoming to fix later — it is the design: the `notifications` table is
   * the source of truth and one indexed query after a reconnect is strictly
   * more reliable than any replay mechanism built on top of a stream. The same
   * refetch also covers the multi-replica case documented on
   * `NotificationStreamService`.
   */
  @Sse('stream')
  @Auth()
  @ApiProduces('text/event-stream')
  @ApiOperation({
    summary: 'Stream this user’s notifications (SSE)',
    description:
      'A `text/event-stream` carrying **only the authenticated caller’s** notifications. ' +
      'There is no parameter that selects a user; the recipient is the bearer of the token.\n\n' +
      '**Frames.** `event: notification` with a JSON `data` payload matching `Notification` ' +
      '(without `readAt`, plus `toast`), plus `: heartbeat` comment lines roughly every 25 ' +
      'seconds so proxies do not reap an idle connection.\n\n' +
      '**`toast`** is the server’s answer to “may this client raise an OS notification for ' +
      'this event?”, computed from the administrator’s policy at publish time. `false` means ' +
      'the bubble is withheld — the notification itself was still recorded and this frame was ' +
      'still sent, so the bell and the unread count are unaffected. Because it travels with ' +
      'each event, a tab holding a stale copy of `GET /api/notifications/config` still ' +
      'honours the current policy.\n\n' +
      '**This is not a delivery guarantee.** Events published while the connection is down are ' +
      'lost — there is no replay and no `Last-Event-ID` support. `EventSource` reconnects by ' +
      'itself; the client must then refetch `GET /api/notifications/unread-count` and ' +
      '`GET /api/notifications`, which is what makes a gap harmless. The durable record is the ' +
      'notification list, not the stream.\n\n' +
      '**Client note.** The native `EventSource` cannot send an `Authorization` header. Use a ' +
      'fetch-based SSE client; a token in the query string is deliberately not supported, ' +
      'because it would put a live credential into access logs and browser history.',
  })
  @ApiOkResponse({
    description: 'An open event stream. Terminates when the client disconnects.',
    content: {
      'text/event-stream': {
        schema: {
          type: 'string',
          example:
            ': connected\n\nevent: notification\ndata: {"id":"…","eventKey":"security.role_changed",' +
            '"title":"Your roles changed","body":"…","link":"/settings","createdAt":"…","toast":true}' +
            '\n\n: heartbeat\n\n',
        },
      },
    },
  })
  stream(@CurrentUser('id') userId: string): Observable<SseMessage> {
    // THE ENTIRE ISOLATION MECHANISM, IN ONE ARGUMENT. `userId` comes from the
    // verified JWT and from nowhere else, and `subscribe` registers this
    // connection under exactly that key. There is no filter to get wrong
    // because there is nothing to filter — this connection is never written to
    // by anything except a publish for this user.
    //
    // Returned SYNCHRONOUSLY (not `async`), so the Observable's own teardown
    // function is the complete cleanup story and no `@SseSignal()` is needed:
    // nothing is allocated before subscription, so nothing can leak if the
    // client disappears during setup.
    return this.streams.subscribe(userId);
  }

  // ---------------------------------------------------------------------------
  // The notification centre (#127)
  // ---------------------------------------------------------------------------

  @Get()
  @Auth()
  @ApiOperation({
    summary: 'List this user’s notifications',
    description:
      'The caller’s own notifications, newest first. **Any authenticated user** may read ' +
      'their own; there is no way to read anybody else’s — the recipient is the bearer of ' +
      'the token, not a parameter.\n\n' +
      'This is the durable surface of the browser channel. It is correct regardless of whether ' +
      'the user ever granted browser-notification permission, and regardless of whether the SSE ' +
      'stream was connected when the notification was raised.',
  })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'pageSize', required: false, type: Number })
  @ApiQuery({
    name: 'unreadOnly',
    required: false,
    enum: ['true', 'false'],
    description: 'Return only unread notifications. Defaults to `false`.',
  })
  @ApiDataResponse(NotificationDto, {
    pagination: 'flat',
    description: 'A page of the caller’s notifications',
  })
  async list(
    @CurrentUser('id') userId: string,
    @Query() query: NotificationListQueryDto,
  ): Promise<NotificationListResponse> {
    return this.store.list(userId, query);
  }

  @Get('unread-count')
  @Auth()
  @ApiOperation({
    summary: 'Count this user’s unread notifications',
    description:
      'The number behind the bell badge, for the authenticated caller only.\n\n' +
      'A separate endpoint rather than something derived from a page of `GET /api/notifications`: ' +
      'a count taken from a page silently caps at `pageSize` and under-reports. Clients should ' +
      'call this on load and again on every SSE (re)connect, which is how a gap in the stream is ' +
      'recovered from.',
  })
  @ApiDataResponse(UnreadCountDto, { description: 'The unread count' })
  async unreadCount(
    @CurrentUser('id') userId: string,
  ): Promise<UnreadCountResponse> {
    return { unreadCount: await this.store.unreadCount(userId) };
  }

  /**
   * `POST`, not `PATCH`, and `/read` rather than a body flag.
   *
   * Marking read is an ACTION with one possible outcome, not a partial
   * replacement of a resource whose fields a client may choose. `PATCH /:id`
   * with `{ readAt }` would invite a client to send an arbitrary timestamp for
   * a column that answers "when did they actually see this?"; there is no
   * legitimate reason for the client to pick that value, so the endpoint does
   * not accept it.
   */
  @Post(':id/read')
  @Auth()
  @ApiOperation({
    summary: 'Mark one notification read',
    description:
      'Marks a single notification read and returns the caller’s resulting unread count, ' +
      'so a click costs one round trip rather than two.\n\n' +
      '**Idempotent.** Marking an already-read notification succeeds and leaves the original ' +
      '`readAt` untouched.\n\n' +
      '**Ownership.** Only the caller’s own notifications can be marked. An id belonging to ' +
      'another user returns `404`, identical to an id that does not exist — the two are ' +
      'deliberately indistinguishable so the endpoint cannot be used to probe for valid ids.',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiDataResponse(UnreadCountDto, { description: 'The new unread count' })
  @ApiResponse({ status: 404, description: 'No such notification for this user' })
  async markRead(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<UnreadCountResponse> {
    return { unreadCount: await this.store.markRead(userId, id) };
  }

  @Post('read-all')
  @Auth()
  // 200, not 204: the response carries the new count, which is the whole
  // reason a client calls this rather than marking rows one at a time.
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Mark all of this user’s notifications read',
    description:
      'Clears the caller’s badge in one call and returns the resulting unread count — ' +
      'normally `0`, but not assumed to be: a notification arriving between the update and the ' +
      'count is reported honestly rather than hidden behind a hardcoded zero.\n\n' +
      'Affects only the caller’s rows. Notifications already read keep their original ' +
      '`readAt`.',
  })
  @ApiDataResponse(UnreadCountDto, { description: 'The new unread count' })
  async markAllRead(
    @CurrentUser('id') userId: string,
  ): Promise<UnreadCountResponse> {
    return { unreadCount: await this.store.markAllRead(userId) };
  }

  // ---------------------------------------------------------------------------
  // Push subscriptions (#229)
  // ---------------------------------------------------------------------------

  @Post('push/subscriptions')
  @Auth()
  @ApiOperation({
    summary: 'Register a browser push subscription',
    description:
      'Stores (or refreshes) the caller’s `PushSubscription`, so #230’s sender has something to ' +
      'push to. Body matches the browser’s `PushSubscription.toJSON()` shape exactly, so the ' +
      'client can pass that object through unmodified.\n\n' +
      '**Upserted by `endpoint`, not created unconditionally.** Re-subscribing the same endpoint ' +
      '(the same browser instance) updates the existing row in place — including moving it to a ' +
      'different `userId` when the same browser subscribes while signed in as someone else — ' +
      'rather than creating a duplicate. See `PushSubscriptionService.subscribe`.\n\n' +
      '`User-Agent` is read from the request header, not a body field, since the browser already ' +
      'sends it on every request with zero client code required and a client-supplied value could ' +
      'be spoofed to no benefit.\n\n' +
      '**`409 Conflict`** when this deployment has no VAPID key pair configured — check ' +
      '`GET /api/notifications/config`’s `pushEnabled` before ever calling `pushManager.subscribe` ' +
      'in the first place.',
  })
  @ApiDataResponse(PushSubscriptionResponseDto, {
    status: 201,
    description: 'The subscription was stored',
  })
  @ApiResponse({
    status: 409,
    description: 'Web Push is not enabled on this deployment (no VAPID keys configured)',
  })
  @HttpCode(HttpStatus.CREATED)
  async subscribePush(
    @CurrentUser('id') userId: string,
    @Body() dto: PushSubscribeDto,
    @Headers('user-agent') userAgent: string | undefined,
  ): Promise<PushSubscriptionResponse> {
    const subscription = await this.pushSubscriptions.subscribe(
      userId,
      dto,
      userAgent,
    );

    return {
      id: subscription.id,
      endpoint: subscription.endpoint,
      createdAt: subscription.createdAt.toISOString(),
    };
  }

  /**
   * `DELETE` with a JSON body — unusual in this codebase's other `DELETE`
   * endpoints (`allowlist`, `pat`), which identify their target by an `:id`
   * path segment, but there is no surrogate id here: the client's only handle
   * on a subscription is the (long, `/`-containing) endpoint URL the browser
   * gave it, and a body avoids re-encoding that into a path or query segment.
   * Both Fastify and Nest support a body on `DELETE`; nothing here relies on
   * `DELETE` being body-less.
   */
  @Delete('push/subscriptions')
  @Auth()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Remove a browser push subscription',
    description:
      'Deletes the caller’s own push subscription for the given `endpoint`. Ownership-scoped: ' +
      'an endpoint that does not exist and one that belongs to a different user return the same ' +
      '`404`, matching this API’s existing precedent for ownership checks (e.g. ' +
      '`POST /api/notifications/:id/read`) — the two are deliberately indistinguishable so this ' +
      'cannot be used to probe which endpoints exist.',
  })
  @ApiResponse({ status: 204, description: 'Subscription removed' })
  @ApiResponse({ status: 404, description: 'No such subscription for this user' })
  async unsubscribePush(
    @CurrentUser('id') userId: string,
    @Body() dto: PushUnsubscribeDto,
  ): Promise<void> {
    await this.pushSubscriptions.unsubscribe(userId, dto.endpoint);
  }
}
