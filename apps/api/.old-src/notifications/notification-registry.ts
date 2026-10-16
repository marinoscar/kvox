import { defineRegistry } from '../common/registry';
import { resetRegistryForTests } from '../common/registry/testing';
import { emailTemplateRegistry } from '../email/templates/email-template.registry';
import type { EmailTemplateName } from '../email/templates';
import type { BrowserNotificationTemplate } from './channels/browser-notification.channel';
import { NOTIFICATION_CHANNELS, type NotificationEventDef } from './notification-event.types';

// =============================================================================
// The notification registry (issue #460, mirrors EnterpriseAppBase
// `notifications/registry/bindings.registry.ts` + `event.registry.ts`)
// =============================================================================
//
// ONE registration per notification: the event (what it is, which channels can
// carry it, whether a user may mute it) AND what renders it on each channel.
// Before #460 those were three lists in three base files
// (`NOTIFICATION_EVENTS`, `EVENT_EMAIL_TEMPLATES`, `EVENT_BROWSER_TEMPLATES`),
// which is how a domain event ended up named in the base. Now a base event is
// registered from `notification-events.ts` (`BASE_NOTIFICATIONS`), a domain's
// from its own folder (`TRANSCRIPTS_NOTIFICATIONS`, `NOTES_NOTIFICATIONS`), and
// `kvox.manifest.ts` registers them in the order the preferences matrix shows.
//
// -----------------------------------------------------------------------------
// ATOMIC BY CONSTRUCTION
// -----------------------------------------------------------------------------
//
// The event and both bindings are ONE entry, validated in one `validate` call
// before the registry stores anything, so a registration with a good event and
// a bad binding stores neither -- there is no half-registered notification to
// clean up. `registerNotifications` extends that to a batch (all or nothing).
//
// Validation is the structural invariants `notification-events.spec.ts` has
// always asserted, enforced where the entry is born instead of where a spec
// happens to look: a `<area>.<event>` key (the registry's id pattern), a non-empty label and description,
// at least one channel and only known ones, `mandatory` implies
// `defaultEnabled`, a binding only for a channel the event declares, and an
// email template that is ALREADY registered (so `kvox.manifest.ts` registers
// templates first, and a typo fails at start instead of as a recorded delivery
// failure in somebody's inbox).
//
// -----------------------------------------------------------------------------
// THE TEST SEAM
// -----------------------------------------------------------------------------
//
// `browser-notification.channel.spec.ts` needs an event to render through a
// template it controls. It used to assign into an exported plain object; the
// registry's entries are not exposed for writing, so the seam is
// {@link overrideBrowserTemplateForTests}, which is refused outside a test
// runner and consulted by {@link browserTemplateFor} before the registered one.
// =============================================================================

/**
 * The `<area>.<event>` convention every key follows. A CONVENTION made a rule
 * at registration: keys are persisted in user preferences and delivery
 * records, so a misspelt one is permanent.
 */
export const NOTIFICATION_EVENT_KEY_PATTERN = /^[a-z]+(_[a-z]+)*\.[a-z]+(_[a-z]+)*$/;

/** One notification: its event and what renders it on each channel. */
export interface NotificationRegistration {
  /** The event, with the fields `NotificationEventDef` has always had. */
  readonly event: NotificationEventDef;
  /**
   * The email template that renders this event. Required whenever the event
   * declares the `email` channel (a missing one is a recorded delivery failure
   * at send time); forbidden otherwise (dead code that reads as a live feature).
   * Must already be registered.
   */
  readonly emailTemplate?: EmailTemplateName;
  /**
   * The browser AND push renderer. Optional even for an event that declares
   * `browser`: a miss falls back to the event's label and description, which is
   * truthful if generic. Forbidden for an event declaring neither `browser` nor
   * `push`.
   */
  readonly browserTemplate?: BrowserNotificationTemplate;
}

function validateRegistration({ event, emailTemplate, browserTemplate }: NotificationRegistration): void {
  if (event.label.trim().length === 0) {
    throw new Error('an event needs a non-empty label (the preferences row heading)');
  }
  if (event.description.trim().length === 0) {
    throw new Error('an event needs a non-empty description (the answer to "why did I get this?")');
  }
  if (event.channels.length === 0) {
    throw new Error('an event must declare at least one channel, or it can never be delivered');
  }
  for (const channel of event.channels) {
    if (!(NOTIFICATION_CHANNELS as readonly string[]).includes(channel)) {
      throw new Error(`unknown channel '${channel}'`);
    }
  }
  if (event.mandatory === true && !event.defaultEnabled) {
    throw new Error('a mandatory event must also be defaultEnabled: true');
  }
  if (emailTemplate !== undefined) {
    if (!event.channels.includes('email')) {
      throw new Error(`it binds an email template but does not declare the email channel`);
    }
    if (!emailTemplateRegistry.has(emailTemplate)) {
      throw new Error(
        `its email template '${emailTemplate}' is not registered: register email templates before notifications`,
      );
    }
  }
  if (browserTemplate !== undefined) {
    if (typeof browserTemplate !== 'function') {
      throw new TypeError('a browser template must be a function');
    }
    if (!event.channels.includes('browser') && !event.channels.includes('push')) {
      throw new Error('it binds a browser template but declares neither the browser nor the push channel');
    }
  }
}

/** Event key -> registration. The source of truth; registration order is the matrix order. */
export const notificationRegistry = defineRegistry<NotificationRegistration>({
  name: 'notifications',
  idOf: (registration) => registration.event.key,
  idPattern: NOTIFICATION_EVENT_KEY_PATTERN,
  validate: validateRegistration,
  describeDuplicate: (_existing, incoming) =>
    `Notification '${incoming.event.key}' is already registered.`,
});

/**
 * Every registered event, in registration order. A read-only view kept in step
 * with {@link notificationRegistry} by this file alone: it is appended to in
 * the same call, after the registry has accepted the registration, so it cannot
 * hold an event the registry refused. `notification-events.ts` re-exports it
 * under the name every consumer already imports.
 */
const eventView: NotificationEventDef[] = [];
export const NOTIFICATION_EVENTS: readonly NotificationEventDef[] = eventView;

let browserTemplateOverrides = new Map<string, BrowserNotificationTemplate | null>();

/**
 * Registers one notification.
 *
 * @throws RegistryError `INVALID_ID`/`INVALID_ENTRY` for a malformed event or
 * binding, `DUPLICATE_ID` for a taken key, `FROZEN` after bootstrap. Nothing is
 * stored when it throws.
 */
export function registerNotification(input: NotificationRegistration): void {
  notificationRegistry.register(input);
  eventView.push(input.event);
}

/** Registers several notifications, in order, all or nothing. */
export function registerNotifications(inputs: readonly NotificationRegistration[]): void {
  notificationRegistry.registerAll(inputs);
  for (const input of inputs) eventView.push(input.event);
}

/** The definition for `key`, or `undefined`. See `findEvent`. */
export function findRegisteredEvent(key: string): NotificationEventDef | undefined {
  return notificationRegistry.get(key)?.event;
}

/**
 * The email template name bound to `eventKey`, or `undefined`.
 *
 * Replaces the old `EVENT_EMAIL_TEMPLATES[eventKey]` lookup; same contract: a
 * miss is `undefined`, never an exception, because the caller turns it into a
 * recorded delivery failure.
 */
export function emailTemplateNameFor(eventKey: string): EmailTemplateName | undefined {
  return notificationRegistry.get(eventKey)?.emailTemplate;
}

/**
 * The browser/push renderer bound to `eventKey`, or `undefined` (the channels
 * then fall back to the event's label and description).
 *
 * Replaces the old `EVENT_BROWSER_TEMPLATES[eventKey]` lookup.
 */
export function browserTemplateFor(eventKey: string): BrowserNotificationTemplate | undefined {
  if (browserTemplateOverrides.has(eventKey)) {
    return browserTemplateOverrides.get(eventKey) ?? undefined;
  }
  return notificationRegistry.get(eventKey)?.browserTemplate;
}

function assertTestRunner(what: string): void {
  if (!process.env.JEST_WORKER_ID && !process.env.VITEST) {
    throw new Error(`${what} is a test helper: it runs only under Jest or Vitest.`);
  }
}

/**
 * Makes {@link browserTemplateFor} answer `template` for `eventKey` (`null`
 * for "no template") instead of the registered binding, until
 * {@link clearBrowserTemplateOverridesForTests}. SPECS ONLY.
 */
export function overrideBrowserTemplateForTests(
  eventKey: string,
  template: BrowserNotificationTemplate | null,
): void {
  assertTestRunner('overrideBrowserTemplateForTests');
  browserTemplateOverrides.set(eventKey, template);
}

/** Removes every {@link overrideBrowserTemplateForTests} override. SPECS ONLY. */
export function clearBrowserTemplateOverridesForTests(): void {
  assertTestRunner('clearBrowserTemplateOverridesForTests');
  browserTemplateOverrides = new Map();
}

/**
 * Empties the registry and its event view and unfreezes it. SPECS ONLY (refused
 * outside Jest/Vitest); each Jest test file has its own module instance.
 */
export function resetNotificationsForTests(): void {
  resetRegistryForTests(notificationRegistry);
  eventView.length = 0;
  clearBrowserTemplateOverridesForTests();
}
