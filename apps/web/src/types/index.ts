export interface Role {
  name: string;
}

export interface User {
  id: string;
  email: string;
  displayName: string | null;
  /**
   * The RESOLVED picture to render, per `UserSettings.profile.imageSource`:
   * `null` for `none`, the provider URL for `provider`, and the same-origin
   * `/api/users/:id/avatar/:objectId` URL for `upload` (#367).
   */
  profileImageUrl: string | null;
  /** The sign-in provider's picture, whatever the chosen source (previews). */
  providerProfileImageUrl?: string | null;
  /**
   * Whether an uploaded picture is stored, whatever the chosen source. Its
   * bytes are previewed via the authenticated `GET /user-settings/profile-image`.
   */
  hasUploadedProfileImage?: boolean;
  roles: Role[];
  permissions: string[];
  isActive: boolean;
  createdAt: string;
}

/** Where the profile picture comes from (#367). */
export type ProfileImageSource = 'none' | 'provider' | 'upload';

export type DataTableDensity = 'compact' | 'standard' | 'comfortable';

/**
 * Navigation preferences. Every field is optional and an ABSENT field means
 * "use the built-in default" — absence is meaningful, not incidental, so never
 * backfill these with literal defaults when reading settings.
 */
export interface NavigationSettings {
  railCollapsed?: boolean;
}

/**
 * Per-table preferences, keyed by table id. As with navigation, every field is
 * optional and an ABSENT field means "use the built-in default" for that table
 * (an absent `visibleColumns` is not an empty column set).
 */
export interface DataTableSettings {
  visibleColumns?: string[];
  density?: DataTableDensity;
  sort?: { field: string; direction: 'asc' | 'desc' };
  pageSize?: number;
}

// =============================================================================
// Notifications — the registry (#124) and the stored preferences (#126, epic #109)
// =============================================================================
//
// TWO DIFFERENT SHAPES THAT ARE EASY TO CONFUSE, so they are named apart here:
//
//   * `NotificationEventDef`  — what events EXIST. Static, identical for every
//     caller, served by `GET /api/notifications/events`. The server owns it;
//     the web app never declares its own copy (see the long argument in
//     `apps/api/src/notifications/notification-events.ts`).
//   * `NotificationPreferences` — what THIS user chose, stored inside the
//     user-settings document under `notifications`.
//
// A definition is not a preference: an account with no stored preferences is
// not "no events", it is every event at its registry default.
// =============================================================================

/**
 * A delivery channel.
 *
 * Mirrors the API's `NOTIFICATION_CHANNELS`. This union is the ONE piece of the
 * registry the web app restates, and only because it is the key type of the
 * patch documents below — an open `string` there would let a typo compile.
 * It is a closed set server-side too (the PATCH schema validates the outer key
 * against the same enum and 400s on anything else), so a channel this union
 * lacks is a channel this app could not write anyway.
 *
 * `'push'` was added here in #228 (epic #215), mirroring the API's widening of
 * `NOTIFICATION_CHANNELS` in the same issue. #228 also builds the
 * preferences-matrix column for it (`pushChannelState()` in
 * `NotificationSettings.tsx`, disabled while the deployment's `pushEnabled` is
 * `false`). The column only has rows for events that declare `push`.
 *
 * Rendering is nonetheless written to survive a NEWER server that declares a
 * channel this build has never heard of — see `CHANNEL_LABELS` in
 * `components/settings/NotificationSettings.tsx`, which falls back to the raw
 * key rather than rendering a blank label.
 */
export type NotificationChannel = 'email' | 'browser' | 'push';

/**
 * One entry of the event registry, as served by `GET /api/notifications/events`.
 *
 * Field for field the API's `notificationEventSchema`. Note `mandatory` is a
 * plain `boolean` here, not `boolean | undefined`: the API normalises it on the
 * way out precisely so no client has to know that absent means "the user is in
 * charge".
 */
export interface NotificationEventDef {
  /** Stable key. What a preference is stored against; renaming one server-side is a migration. */
  key: string;
  /** Short human label — the row heading on the preferences page. */
  label: string;
  /** One sentence on what actually triggers this, in the user's terms. */
  description: string;
  /**
   * Channels this event CAN be delivered over — a capability of the event, not
   * a statement about which transports are implemented yet. A cell is rendered
   * only for a channel listed here, so `allowlist.invitation` (email only, its
   * recipient has no session by definition) never offers a browser toggle.
   */
  channels: NotificationChannel[];
  /** What an account that has expressed no preference receives. */
  defaultEnabled: boolean;
  /**
   * The user may not opt out, on ANY channel.
   *
   * A UI HINT ONLY — the gate is server-side in preference resolution, because
   * a client-side check is bypassed by any request that never went near the
   * client. Render the controls disabled WITH the reason rather than hiding
   * them: a dead toggle teaches nothing (epic #109, success criterion 5).
   */
  mandatory: boolean;
}

/**
 * One channel's stored preferences: event key -> the user's explicit choice.
 *
 * SPARSE. A key is present only where the user deliberately chose something. An
 * absent key is NOT `false` and must never be normalised into one — absent
 * means "use the registry's `defaultEnabled`", resolved at read time.
 */
export type NotificationChannelPreferences = Record<string, boolean>;

/**
 * The `notifications` namespace of the user-settings document, as stored.
 *
 * CHANNEL-OUTER, EVENT-INNER — `{ email: { 'user.welcome': false } }`. Not a
 * choice this file makes: it is the shape the API's
 * `readNotificationPreferences` parses and `isChannelEnabled` resolves, and a
 * document written event-outer would be silently ignored by the dispatcher,
 * i.e. a mute that never takes effect.
 *
 * Every level is optional, all the way down. There is deliberately no shape of
 * this value that asserts "the user has an opinion about every event".
 */
export type NotificationPreferences = Partial<
  Record<NotificationChannel, NotificationChannelPreferences>
>;

/**
 * PATCH form of one channel's preferences.
 *
 * The value is nullable because JSON Merge Patch uses `null` to mean DELETE:
 * `{ email: { 'user.welcome': null } }` removes that one event key, restoring
 * the absent (= registry default) state. That is what the preferences page
 * sends when a control returns to its default — writing the default value
 * explicitly works today and pins the user to today's default forever.
 */
export type NotificationChannelPreferencesPatch = Record<string, boolean | null>;

/**
 * PATCH form of the `notifications` namespace. Three levels of delete, each
 * meaning something different (see `UserSettingsUpdate`).
 *
 * Unlike `dataTables`, a non-null channel object is DEEP-merged per event
 * rather than replacing the channel wholesale — which is exactly what lets the
 * page send one key per toggle and leave every other preference absent.
 */
export type NotificationPreferencesPatch = Partial<
  Record<NotificationChannel, NotificationChannelPreferencesPatch | null>
>;

// =============================================================================
// The notification centre — delivered notifications (#127, epic #109)
// =============================================================================
//
// A THIRD notification shape, and the one most easily confused with the two
// above, so: `NotificationEventDef` is what CAN happen, `NotificationPreferences`
// is what the user WANTS, and `AppNotification` below is something that
// ACTUALLY HAPPENED — one row of the `notifications` table, addressed to this
// user, with its own read state.
//
// NAMED `AppNotification`, NOT `Notification`. The DOM declares a global
// `Notification` (the constructor behind the native toast), and this file's
// types are imported into modules that use BOTH — `services/browserNotifications.ts`
// raises a real `new Notification(...)` from one of these rows. A local
// interface called `Notification` would shadow the global inside every one of
// those modules, so the toast would silently be constructed from the wrong
// thing or fail to compile in a confusing place. The prefix costs one word and
// removes the collision entirely.
// =============================================================================

/**
 * One delivered notification, field for field the API's `notificationSchema`
 * (`apps/api/src/notifications/dto/notification.dto.ts`).
 *
 * THE SAME SHAPE ARRIVES TWO WAYS — fetched from `GET /api/notifications`, or
 * pushed over SSE — and that is deliberate on the API's side: a streamed event
 * is this object minus `readAt`, so both go into the same list with no second
 * mapping. See `streamEventToNotification` in `services/notificationStream.ts`,
 * which is the only place the missing field is filled in.
 */
export interface AppNotification {
  id: string;
  /**
   * The registry key that raised this (`security.role_changed`).
   *
   * For grouping, icons or filtering. NOT what is rendered — `title` and `body`
   * were rendered server-side at write time, so editing a template never
   * rewrites what a user was already told.
   */
  eventKey: string;
  /** One short line. Already length-capped by the API. Render as TEXT. */
  title: string;
  /** The detail. Plain text, never markup. */
  body: string;
  /**
   * Root-relative path to open, or `null`.
   *
   * GUARANTEED INTERNAL by the API — `sanitizeLink` validated it before the row
   * was written, so it is always a single leading `/` with no scheme and no
   * protocol-relative `//`. That is what makes it safe to hand to
   * `navigate()`. The client still refuses anything that does not start with a
   * single `/` (see `isInternalLink` in `NotificationBell.tsx`): the guarantee
   * is the server's to keep, and a client that also checks costs one comparison
   * and survives the day it is broken.
   */
  link: string | null;
  /** ISO-8601. When the user marked it read; `null` while unread. */
  readAt: string | null;
  /** ISO-8601. */
  createdAt: string;
}

/**
 * A page of `GET /api/notifications`.
 *
 * FLAT pagination (`items`/`total`/`page`/`pageSize`/`totalPages`), matching
 * `/users` and `/allowlist` rather than storage's nested `pagination` object —
 * the API deliberately picked the more common of its two existing list shapes.
 */
export interface NotificationListResponse {
  items: AppNotification[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

/**
 * The badge number.
 *
 * Returned by `GET /api/notifications/unread-count` AND by BOTH mark-read
 * endpoints — which is why marking one read costs a single round trip: the
 * client already holds the row it marked, and the count is the only thing it
 * cannot compute for itself. Do not follow a mark-read with a count fetch.
 */
export interface UnreadCountResponse {
  unreadCount: number;
}

/**
 * One `event: notification` frame's payload, as `NotificationStreamService`
 * publishes it.
 *
 * `AppNotification` WITHOUT `readAt`, PLUS `toast` — not an oversight and not a
 * different model. `readAt` is absent because a notification is unread by
 * definition at the instant it is published, so the field would carry no
 * information. `toast` is present because it is an instruction about THIS
 * delivery rather than a property of the stored row. Everything else is
 * identical, which is the property that lets a streamed event be pushed
 * straight into the fetched list.
 *
 * Carries NO user id. The recipient is implicit in which stream it arrived on;
 * the API omits it specifically so no client is ever tempted to filter on it.
 */
export type NotificationStreamEvent = Omit<AppNotification, 'readAt'> & {
  /**
   * May this client raise an OS notification for this event? (#226, epic #215)
   *
   * SERVER-COMPUTED, from the administrator's deployment-wide policy:
   * `browserEnabled && !disabledEvents.includes(eventKey)`. It travels with the
   * event rather than being derived from a cached
   * `GET /api/notifications/config`, so a tab open since before an
   * administrator changed the setting still honours the current policy.
   *
   * `false` DOES NOT MEAN SUPPRESSED. The notification was recorded and this
   * frame was sent; the bell, the unread count and the notification centre are
   * unaffected. Only the OS bubble is withheld — which is what lets an
   * administrator mute toasts without muting a mandatory security alert's
   * durable record.
   *
   * #227 is what acts on it. Until then it is parsed and carried, which is the
   * harmless direction: a field ignored is cheaper than a field the client
   * cannot see when it finally needs it.
   */
  toast: boolean;
};

/**
 * `GET /api/notifications/config` — this deployment's client-facing
 * notification capabilities (#226, epic #215). Field for field the API's
 * `notificationConfigSchema` (`apps/api/src/notifications/dto/notification-config.dto.ts`),
 * which carries the full argument for why this is its own narrow, unauthenticated-
 * by-permission endpoint rather than a widening of `system_settings:read` — cited
 * here rather than re-derived: a viewer holds no `system_settings:read`, so this
 * is the one place that lets a non-admin learn the toggle without exposing the
 * whole settings blob.
 */
export interface NotificationConfigResponse {
  /**
   * May this client raise browser notifications at all? THE PERMISSION-PROMPT
   * GATE — see the DTO's own doc comment. `false` does not stop delivery; rows
   * are still written and the centre still fills, it only means the OS bubble
   * is off. Consumed by #227 as `useNotificationCapability`'s `adminDisabled`
   * input (`!browserEnabled`).
   */
  browserEnabled: boolean;
  /**
   * May this client subscribe to Web Push? `true` once an administrator has
   * generated and enabled a VAPID key pair (#355). Drives the boot-time
   * subscription sync (`hooks/usePushSubscriptionSync.ts`, #365) and the
   * settings page's push column.
   */
  pushEnabled: boolean;
  /**
   * The VAPID application server key (URL-safe base64) for
   * `pushManager.subscribe`, or `null` when push is unavailable. Changes when
   * the key pair is rotated, which is how the sync detects a stale
   * subscription.
   */
  vapidPublicKey: string | null;
}

/**
 * `POST /api/notifications/push/subscriptions` body — exactly the browser's
 * `PushSubscription.toJSON()` shape, so the client passes it through unmodified
 * (#229, wired by #365).
 */
export interface PushSubscriptionPayload {
  endpoint: string;
  expirationTime?: number | null;
  keys: {
    p256dh: string;
    auth: string;
  };
}

/** `POST /api/notifications/push/subscriptions` response. */
export interface PushSubscriptionResponse {
  id: string;
  endpoint: string;
  createdAt: string;
}

export interface UserSettings {
  theme: 'light' | 'dark' | 'system';
  profile: {
    displayName?: string;
    /**
     * Which picture to show (#367). `'upload'` is only accepted by PATCH once a
     * picture has been uploaded; the upload endpoint sets it itself.
     */
    imageSource: ProfileImageSource;
    /**
     * The uploaded picture's storage object id. Kept when switching to
     * `none`/`provider` so switching back to `upload` works; cleared only by
     * `DELETE /api/user-settings/profile-image`. Set by the server, never PATCHed.
     */
    imageObjectId?: string | null;
  };
  navigation?: NavigationSettings;
  dataTables?: Record<string, DataTableSettings>;
  /**
   * Per-channel, per-event notification preferences (#126, epic #109).
   *
   * OPTIONAL, AND ABSENT IS THE NORMAL CASE — not a loading state and not
   * "notifications off". No account has this key until it deliberately changes
   * a preference, so `settings.notifications ?? {}` resolves every event to its
   * registry default. Never backfill it with a materialised object.
   */
  notifications?: NotificationPreferences;
  updatedAt: string;
  version: number;
}

/**
 * PATCH form of `navigation`: each field may additionally be `null`, meaning
 * "delete this field and fall back to the built-in default".
 */
export type NavigationSettingsPatch = {
  [K in keyof NavigationSettings]?: NavigationSettings[K] | null;
};

/**
 * PATCH form of `dataTables`: the per-table VALUE may be `null` to delete that
 * table's entry. Note the asymmetry with navigation — a non-null entry REPLACES
 * the stored entry wholesale rather than being deep-merged, so its fields are
 * plain optionals and are NOT individually nullable. The server rejects
 * `{ [id]: { sort: null } }`; omit the field or replace the whole entry.
 */
export type DataTablesPatch = Record<string, DataTableSettings | null>;

/**
 * `POST` / `DELETE /api/user-settings/profile-image` response, after the
 * client's `data` unwrap (#367). `settings` carries the new `version`, which
 * the caller MUST adopt or its next `If-Match` PATCH will 409.
 */
export interface ProfileImageMutationResponse {
  settings: UserSettings;
  /** The resolved picture after the change (same meaning as `User.profileImageUrl`). */
  profileImageUrl: string | null;
}

/**
 * Payload accepted by `PATCH /api/user-settings`.
 *
 * This deliberately is NOT `Partial<UserSettings>`: the endpoint uses JSON
 * Merge Patch semantics, where `null` is a DELETE signal rather than a value.
 *   - `{ navigation: null }`                    clears the whole namespace
 *   - `{ navigation: { railCollapsed: null } }` deletes just that field
 *   - `{ dataTables: null }`                    clears the whole namespace
 *   - `{ dataTables: { [id]: null } }`          deletes just that table's entry
 *   - `{ notifications: null }`                 clears the whole namespace
 *   - `{ notifications: { email: null } }`      clears one channel
 *   - `{ notifications: { email: { k: null } }}` deletes ONE event key, restoring
 *                                               the registry default for it
 * Omitting a key leaves the stored value untouched. Server-owned fields
 * (`updatedAt`, `version`) are not patchable and so are absent here.
 */
export interface UserSettingsUpdate {
  theme?: UserSettings['theme'];
  profile?: Partial<UserSettings['profile']>;
  navigation?: NavigationSettingsPatch | null;
  dataTables?: DataTablesPatch | null;
  /**
   * Notification preferences (#126). The channel object is DEEP-merged per
   * event key server-side, which is what allows the preferences page to send
   * exactly the one key it changed and leave every other preference absent.
   */
  notifications?: NotificationPreferencesPatch | null;
}

/**
 * Deployment-wide browser-notification policy (#225, epic #215).
 *
 * A MODELLED block on the settings document, mirroring the API's
 * `systemNotificationsSchema`: a typed, validated namespace rather than a
 * shapeless map of flags.
 *
 * NOTHING READS THESE VALUES YET, on either side. Issue #225 adds the setting,
 * its persistence and the admin page at `/admin/settings/notifications`; the
 * enforcement (the browser channel consulting them, and the non-admin read
 * endpoint that lets this app skip asking for OS permission when the capability
 * is off) is issue #226. An editable control with no observable effect is the
 * expected state until then, not a bug.
 */
export interface SystemNotificationSettings {
  /** The whole browser channel, for everyone. */
  browserEnabled: boolean;
  /**
   * `NotificationEventDef` keys whose OS notification is suppressed for
   * everyone, independently of any user's own preference.
   *
   * A plain `string[]` and not a union: the registry is served by the API, so a
   * key this build has never heard of is a key an operator may still legitimately
   * have suppressed — the admin page renders what the registry returns and
   * leaves unknown stored keys alone.
   */
  disabledEvents: string[];
}

export interface SystemSettings {
  notifications: SystemNotificationSettings;
  updatedAt: string;
  updatedBy: { id: string; email: string } | null;
  version: number;
}

export interface AuthProvider {
  name: string;
  authUrl: string;
}

export interface AllowedEmailEntry {
  id: string;
  email: string;
  addedBy: { id: string; email: string } | null;
  addedAt: string;
  claimedBy: { id: string; email: string } | null;
  claimedAt: string | null;
  notes: string | null;
}

export interface AllowlistResponse {
  items: AllowedEmailEntry[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface UserListItem {
  id: string;
  email: string;
  displayName: string | null;
  providerDisplayName: string | null;
  profileImageUrl: string | null;
  providerProfileImageUrl?: string | null;
  isActive: boolean;
  roles: string[];
  createdAt: string;
  updatedAt: string;
}

export interface UsersResponse {
  items: UserListItem[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

/**
 * What `GET /api/auth/device/activate?code=…` returns for a pending code.
 *
 * EVERY FIELD UNDER `clientInfo` IS ATTACKER-CHOSEN. `POST /auth/device/code`
 * is `@Public()`, its body is stored verbatim in the `device_codes.client_info`
 * JSONB column, and this endpoint hands that column back wholesale. The types
 * below describe what a WELL-BEHAVED client sends, not what will arrive — see
 * `components/device-activation/credential.ts`, which is the only place this
 * object is allowed to be interpreted.
 */
export interface DeviceActivationInfo {
  userCode: string;
  // Optional because the API declares it optional (`clientInfo?` on
  // DeviceActivateResponseDto) and because a row written by hand or by an older
  // build can carry `null`. It was typed as required, which let call sites do
  // `deviceInfo.clientInfo.deviceName` and crash the whole activation page on a
  // shape the server is allowed to send.
  clientInfo?: {
    deviceName?: string;
    userAgent?: string;
    ipAddress?: string;
    // `string`, NOT the `'session' | 'pat'` union (#141). Two reasons, both
    // load-bearing: rows created before #141 have no `tokenType` at all, and
    // the column is not re-validated on read, so an unexpected value is a
    // shape we must be able to represent in order to defend against it. Typing
    // it as the union here would make `readCredentialKind`'s unknown-value
    // branch look like dead code and invite someone to delete it.
    tokenType?: string;
  };
  expiresAt: string;
}

export interface DeviceAuthorizationResponse {
  success: boolean;
  message: string;
}

// Personal Access Tokens
export type PatDurationUnit = 'minutes' | 'days' | 'months';

export interface PersonalAccessToken {
  id: string;
  name: string;
  tokenPrefix: string;
  durationValue: number;
  durationUnit: PatDurationUnit;
  expiresAt: string;
  lastUsedAt: string | null;
  createdAt: string;
  revokedAt: string | null;
}

export interface PatCreatedResponse {
  token: string;
  id: string;
  name: string;
  tokenPrefix: string;
  expiresAt: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Email settings — issue #124, epic #109.
//
// These mirror the payloads of `/api/email-settings`, which are NOT part of the
// system settings document: email is its own controller writing its own
// `system_settings` row, with its own version counter and its own save
// semantics (see `EmailSettingsInput` below), so it gets its own types rather
// than another branch of `SystemSettings`. Everything the web app knows about
// the wire format lives here and in `services/api.ts`'s email block — if the
// API's field names move, those two files are the whole reconciliation.
//
// THE SHAPE IS FLAT, because the API's is. `emailSettingsSchema`
// (`apps/api/src/email/email-settings.schema.ts`) is one object whose
// `sesRegion` / `smtpHost` / `smtpPort` / `smtpUsername` are siblings of
// `fromAddress` and `provider`, and both DTOs derive from it rather than
// restating it. An earlier draft of this file grouped them into `ses: {…}` and
// `smtp: {…}` sub-objects. That typechecked perfectly and was wrong on the
// wire in both directions: every read came back `undefined`, and every write
// was dropped by zod, which strips unknown keys. Do not re-nest — the types
// here are not free to be tidier than the payload they describe.
// ---------------------------------------------------------------------------

/**
 * Which transport sends mail. Mirrors `EMAIL_PROVIDER_KINDS` in the API's
 * `email-settings.schema.ts`.
 *
 * There is deliberately no `'disabled'` member. "Off" is not a transport, it is
 * `EmailSettings.enabled === false` — see the note there. The absence of a
 * chosen transport is `provider: null`, which is why every use of this type on
 * the wire is written `EmailProviderKind | null` rather than made optional.
 */
export type EmailProviderKind = 'ses' | 'smtp';

/**
 * What the API will tell us about the stored SMTP password — which is
 * everything except the password.
 *
 * The password itself is written into the encrypted credential store (epic
 * #108) and is unreadable through the API by construction: the response DTO
 * carries a compile-time proof that it has no field able to hold one. This
 * status object is what makes the blank password box honest; without it the UI
 * would render an empty field with no way to say whether submitting it keeps
 * something or keeps nothing.
 */
export interface SmtpPasswordStatus {
  /** Is a password stored at all? */
  configured: boolean;

  /**
   * The credential store's OWN mask — `••••` plus at most the last four
   * characters — derived once on write by the code that held the plaintext.
   *
   * Null when nothing is stored, and also null for a secret too short to mask
   * safely, so the UI must read correctly without it. Better than a fixed
   * placeholder: an admin who has just rotated a credential can see WHICH one
   * is live rather than only that one exists.
   */
  hint: string | null;

  /** When the stored password was last written. Null when nothing is stored. */
  updatedAt: string | null;

  /** Who last wrote it. Null when nothing is stored, or that user was deleted. */
  updatedByUserId: string | null;
}

/**
 * `GET /api/email-settings`, and the body of a successful `PUT`.
 *
 * The optional fields are optional in the same sense the API means: the key is
 * ABSENT when nothing is configured (`stripUnsetSettingFields` removes empty
 * values before the row is written), never present-and-empty. Read them with
 * `?? ''` and do not test them for `''`.
 */
export interface EmailSettings {
  /**
   * `null` means "no transport chosen", the state of every fresh install. It
   * is a persisted value, not a missing key.
   */
  provider: EmailProviderKind | null;

  /**
   * The master switch, a SEPARATE AXIS from `provider`. Nothing is sent while
   * this is false.
   *
   * Two fields rather than one because the pair carries something a single
   * three-way choice cannot: an admin who switches mail off for a maintenance
   * window keeps the transport and every field belonging to it, and turning it
   * back on costs no retyping. `provider: null, enabled: false` (never
   * configured) and `provider: 'smtp', enabled: false` (deliberately off) are
   * genuinely different states, and collapsing them would lose the second one.
   */
  enabled: boolean;

  /** SES region override, e.g. `us-east-1`. Absent means the deployment's `S3_REGION`. */
  sesRegion?: string;

  smtpHost?: string;
  smtpPort?: number;

  /**
   * REQUIRE TLS — not nodemailer's `secure` flag, which the API derives itself
   * from the port (465 is TLS from the first byte; everything else gets
   * required STARTTLS). Absent is treated as `true` by the provider, so the UI
   * must default it to on rather than to off.
   */
  smtpUseTls?: boolean;

  /** Absent means unauthenticated submission — a real configuration for an IP-authorised relay. */
  smtpUsername?: string;

  fromAddress?: string;
  fromName?: string;

  /** Everything the UI may know about the stored password. See {@link SmtpPasswordStatus}. */
  smtpPasswordStatus: SmtpPasswordStatus;

  /**
   * Why the STORED configuration could not be read, when it could not be. Null
   * on the normal path.
   *
   * The read endpoint degrades instead of throwing: a hand-edited row or a bad
   * migration would otherwise take down the one screen capable of repairing
   * it. When this is set, every settings field above is a DEFAULT rather than
   * the deployment's real configuration — which is why the page has to say so.
   * An admin who is not told is editing a form that does not describe their
   * system, and "saving" it overwrites the row they came to fix.
   *
   * Field paths only, never stored values.
   */
  settingsError: string | null;

  /** Bumped on every write. Pass back as `If-Match` on the next PUT. */
  version: number;

  updatedAt: string | null;
  updatedBy: { id: string; email: string } | null;
}

/**
 * A settings field an admin left empty.
 *
 * An HTML form cannot express "absent": a cleared text input submits `''` and a
 * reset controlled component submits `null`. The API's
 * `updateEmailSettingsSchema` wraps every optional field in a `blankable`
 * union that accepts both, and converts them to "absent" exactly once, in
 * `EmailSettingsService.update`. So the web app sends what the admin did —
 * they cleared the box — instead of reimplementing that conversion here and
 * getting a seventh copy of it slightly wrong.
 */
export type Blankable<T> = T | '' | null;

/**
 * `PUT /api/email-settings`.
 *
 * A full replacement, not a patch, plus the version the caller believed it was
 * replacing (sent as `If-Match` — see `updateEmailSettings` in
 * `services/api.ts`, not carried in this body).
 *
 * `provider` and `enabled` are REQUIRED and are NOT blankable: `null` is a real
 * persisted value for `provider`, so the API keeps it distinct from an emptied
 * box, and stripping it would drop a required key and fail the parse.
 *
 * BLANK PRESERVES (the #115 contract, restated by #124). `smtpPassword`
 * omitted — or sent as an empty string — leaves the stored password exactly as
 * it is; a non-empty value replaces it. There is deliberately NO way to erase a
 * password by clearing the field, because "I left the box alone" and "I want no
 * password" are the same gesture, and guessing wrong in the destructive
 * direction silently breaks mail for everyone. Note it is the ONE field this
 * app omits rather than sending as `''`: for every other field `''` means "not
 * configured", and for this one it means "unchanged".
 */
export interface EmailSettingsInput {
  provider: EmailProviderKind | null;
  enabled: boolean;
  sesRegion?: Blankable<string>;
  smtpHost?: Blankable<string>;
  smtpPort?: Blankable<number>;
  smtpUseTls?: Blankable<boolean>;
  smtpUsername?: Blankable<string>;
  fromAddress?: Blankable<string>;
  fromName?: Blankable<string>;
  smtpPassword?: string;
}

/**
 * `POST /api/email-settings/test` — the result of a real send attempt.
 *
 * A FAILED SEND IS A 200 WITH `success: false`, not a rejected promise: the
 * request succeeded, the mail did not. That is why the page branches on this
 * field and never on "did the call throw" — the single most likely way this
 * page could end up claiming success while the provider refused the message.
 *
 * Every field is present on a real response (nullable rather than optional in
 * the API's DTO). They are optional HERE because the hook also builds this
 * shape locally when the CALL itself fails — a 403, a 500, a dropped
 * connection — which is still a failed test and belongs in the same red
 * region, but has no recipient, no provider and no timestamp to report.
 */
export interface EmailTestResult {
  success: boolean;

  /**
   * Where it went — the caller's own address, taken from the session. Echoed
   * back so the UI states the destination as fact rather than assuming it.
   */
  sentTo?: string;

  /**
   * Which transport carried, or refused, the message. Null when nothing was
   * attempted because no provider was configured. Worth showing: an admin who
   * has just switched from SMTP to SES needs to know which one produced the
   * error in front of them.
   */
  providerKind?: EmailProviderKind | null;

  /** Provider message id on success — the string that correlates this attempt with a provider-side log. */
  messageId?: string | null;

  /**
   * The provider's VERBATIM error on failure — `535 Authentication failed`,
   * `MessageRejected: Email address is not verified`. Diagnosing mail
   * configuration is this page's entire job (#124), so this string is rendered
   * as-is and never replaced with a friendlier summary. Already redacted and
   * length-capped by the API's `SecretRedactor`.
   */
  error?: string | null;

  /** When the attempt was made. */
  attemptedAt?: string;
}

// =============================================================================
// Maintenance mode — issue #258, epic #254
// =============================================================================
//
// The web mirror of `GET`/`PUT /api/admin/maintenance`
// (`apps/api/src/common/maintenance/dto/update-maintenance.dto.ts`). Mirrored
// rather than shared because there is no cross-package type surface between
// `apps/api` and `apps/web` — `packages/shared` is deliberately plain
// JavaScript constants (see its header) — so this is the same arrangement
// `EmailSettings` and `SystemSettings` above already live under.
//
// The one thing NOT restated here is the marker string and the retry delay:
// those are the wire CONTRACT rather than a shape, and they live beside the
// code that recognises them, in `services/maintenance.ts`.

/** Which of the three layers decided `enabled`. Reported, never inferred. */
export type MaintenanceSource = 'env' | 'memory' | 'persisted';

/**
 * An override held in the API process only (the database restore's swap
 * window). `message` and `allowAdmins` are optional on it because the caller
 * that installs one usually has nothing to say about them.
 */
export interface MaintenanceOverride {
  enabled: boolean;
  message?: string;
  allowAdmins?: boolean;
}

/** The stored `maintenance` namespace of the system settings document. */
export interface MaintenancePolicy {
  enabled: boolean;
  message: string;
  allowAdmins: boolean;
  startedAt: string | null;
  startedById: string | null;
}

/**
 * The effective state, plus every contributing layer, separately.
 *
 * `layers` is the reason the admin page exists as more than a switch: an
 * operator asking "I turned it off and it is still on" needs to be shown that
 * `MAINTENANCE_MODE=true` is in the environment and outranks the row they just
 * wrote. Rendering only `enabled` would make that invisible from the UI in
 * exactly the way it would have been invisible from the API without this block.
 */
export interface MaintenanceStatus extends MaintenancePolicy {
  source: MaintenanceSource;
  layers: {
    /** `enabled: null` means the variable is unset, or set to something that is neither `'true'` nor `'false'`. */
    env: { present: boolean; enabled: boolean | null };
    memory: { present: boolean; override: MaintenanceOverride | null };
    /** `readable: false` means the row could not be read and `value` is the last known state. */
    persisted: { readable: boolean; value: MaintenancePolicy };
  };
}

/**
 * The `PUT` body. `enabled` is the only required field, exactly as in
 * `updateMaintenanceSchema`.
 *
 * `startedAt` / `startedById` are ABSENT on purpose and must stay absent: the
 * API stamps them itself and refuses to take them from a caller, because an
 * audit trail the audited party can dictate is not one.
 */
export interface UpdateMaintenanceInput {
  enabled: boolean;
  message?: string;
  allowAdmins?: boolean;
}
