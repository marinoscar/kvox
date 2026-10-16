import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { NOTIFICATION_CHANNELS } from '../notification-events';

// =============================================================================
// GET /api/notifications/events — response item (issue #124, epic #109)
// =============================================================================
//
// The wire form of one `NotificationEventDef`. Derived from the registry's own
// channel list, so adding `'push'` to `NOTIFICATION_CHANNELS` widens this
// schema in the same edit rather than making the endpoint publish a value its
// own documentation says is impossible.
//
// ONE FIELD IS NORMALISED ON THE WAY OUT: `mandatory`, which is
// `boolean | undefined` on the definition (absent is the normal case) and a
// plain `boolean` here. A client rendering a disabled toggle should not have
// to know that `undefined` means "the user is in charge" — and a client that
// forgets is one `!def.mandatory` away from either a dead control on every row
// or, worse, an enabled control on a security event.
//
// NOTE WHAT THIS ENDPOINT IS NOT. It is a description of what events EXIST,
// not of what the caller has chosen. Preferences are #126's endpoint against
// #126's rows, and the sparse absent-key contract lives there: no preference
// row is materialised until a user deliberately changes something, so an
// account with no rows is not "no events" — it is every event, enabled.
// =============================================================================

export const notificationEventSchema = z.object({
  /**
   * Stable identifier, persisted in preferences and delivery records.
   *
   * The key a client stores its preference against. Renaming one server-side
   * is a migration, not a refactor — see `NotificationEventDef.key`.
   */
  key: z.string(),

  /** Short human label. The row heading on the preferences page. */
  label: z.string(),

  /** One sentence on what actually triggers this, in the user's terms. */
  description: z.string(),

  /**
   * Channels this event CAN be delivered over — a capability of the event, not
   * a statement about which transports are implemented yet.
   *
   * A client renders a cell only for a channel listed here. Rendering the full
   * matrix regardless would offer, for instance, a browser toggle for
   * `allowlist.invitation`, whose recipient has no account and no open tab by
   * definition.
   */
  channels: z.array(z.enum(NOTIFICATION_CHANNELS)),

  /** What an account that has expressed no preference receives. */
  defaultEnabled: z.boolean(),

  /**
   * The user may not opt out, on any channel.
   *
   * A UI HINT ONLY. The gate is server-side, in #125's preference resolution
   * (`isMandatory`), because a client-side check is bypassed by any request
   * that never went near the client — which is the entire attack this flag
   * closes. Render the controls disabled WITH the reason rather than hiding
   * them: epic #109's success criterion 5 is that a dead toggle teaches
   * nothing.
   */
  mandatory: z.boolean(),
});

/** One registry entry, as sent. */
export type NotificationEventResponse = z.infer<typeof notificationEventSchema>;

export class NotificationEventDto extends createZodDto(
  notificationEventSchema,
) {}
