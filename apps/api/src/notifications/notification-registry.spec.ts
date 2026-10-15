import { RegistryError } from '../common/registry';
import {
  registerEmailTemplate,
  resetEmailTemplatesForTests,
} from '../email/templates/email-template.registry';
import type { NotificationEventDef } from './notification-event.types';
import {
  NOTIFICATION_EVENTS,
  browserTemplateFor,
  clearBrowserTemplateOverridesForTests,
  emailTemplateNameFor,
  findRegisteredEvent,
  notificationRegistry,
  overrideBrowserTemplateForTests,
  registerNotification,
  registerNotifications,
  resetNotificationsForTests,
  type NotificationRegistration,
} from './notification-registry';

// =============================================================================
// The notification registry (issue #460): duplicate, atomic and frozen
// behaviour, binding validation, and the browser-template test seam
// =============================================================================
//
// `test/setup.ts` has already run the manifest; each test starts from an empty
// notification registry and an empty email template registry so it controls
// exactly what is registered. Each Jest test file has its own module instance.
// =============================================================================

const rendered = { subject: 's', html: '<p>h</p>', text: 't' };
const emailRenderer = () => rendered;
const browserRenderer = () => ({ title: 't', body: 'b', link: '/x' });

function event(overrides: Partial<NotificationEventDef> = {}): NotificationEventDef {
  return {
    key: 'billing.invoice_ready',
    label: 'Invoice ready',
    description: 'Sent when an invoice is ready.',
    channels: ['email', 'browser'],
    defaultEnabled: true,
    ...overrides,
  };
}

function code(fn: () => void): string | undefined {
  try {
    fn();
  } catch (err) {
    return err instanceof RegistryError ? err.code : `not a RegistryError: ${String(err)}`;
  }
  return undefined;
}

function registration(overrides: Partial<NotificationRegistration> = {}): NotificationRegistration {
  return { event: event(), emailTemplate: 'test-email', browserTemplate: browserRenderer, ...overrides };
}

describe('notification registry', () => {
  beforeEach(() => {
    resetNotificationsForTests();
    resetEmailTemplatesForTests();
    registerEmailTemplate('test-email', emailRenderer);
    registerEmailTemplate('job-failed', emailRenderer);
  });

  it('registers an event with both bindings and exposes it through every lookup', () => {
    const input = registration();
    registerNotification(input);

    expect(findRegisteredEvent('billing.invoice_ready')).toBe(input.event);
    expect(emailTemplateNameFor('billing.invoice_ready')).toBe('test-email');
    expect(browserTemplateFor('billing.invoice_ready')).toBe(browserRenderer);
    expect(NOTIFICATION_EVENTS).toEqual([input.event]);
  });

  it('keeps registration order, which is the order of the preferences matrix', () => {
    registerNotification(registration({ event: event({ key: 'billing.b_second' }) }));
    registerNotifications([
      registration({ event: event({ key: 'billing.a_first' }) }),
      registration({ event: event({ key: 'billing.c_third' }) }),
    ]);

    expect(NOTIFICATION_EVENTS.map((e) => e.key)).toEqual([
      'billing.b_second',
      'billing.a_first',
      'billing.c_third',
    ]);
    expect(notificationRegistry.ids()).toEqual([...NOTIFICATION_EVENTS.map((e) => e.key)]);
  });

  it('answers undefined for an unknown key', () => {
    expect(findRegisteredEvent('does.not_exist')).toBeUndefined();
    expect(emailTemplateNameFor('does.not_exist')).toBeUndefined();
    expect(browserTemplateFor('does.not_exist')).toBeUndefined();
  });

  describe('duplicates', () => {
    it('refuses a second notification under the same key and keeps the first', () => {
      const first = registration();
      registerNotification(first);

      expect(
        code(() => registerNotification(registration({ event: event({ label: 'Other' }) }))),
      ).toBe('DUPLICATE_ID');
      expect(findRegisteredEvent('billing.invoice_ready')).toBe(first.event);
      expect(NOTIFICATION_EVENTS).toHaveLength(1);
    });
  });

  describe('atomic registration', () => {
    it('stores neither event nor bindings when the email template is not registered', () => {
      expect(
        code(() => registerNotification(registration({ emailTemplate: 'broadcast' }))),
      ).toBe('INVALID_ENTRY');

      expect(findRegisteredEvent('billing.invoice_ready')).toBeUndefined();
      expect(NOTIFICATION_EVENTS).toHaveLength(0);
      expect(browserTemplateFor('billing.invoice_ready')).toBeUndefined();
    });

    it('stores none of a batch whose later entry is invalid', () => {
      expect(
        code(() =>
          registerNotifications([
            registration({ event: event({ key: 'billing.good_one' }) }),
            registration({ event: event({ key: 'billing.bad_one' }), emailTemplate: 'broadcast' }),
          ]),
        ),
      ).toBe('INVALID_ENTRY');

      expect(NOTIFICATION_EVENTS).toHaveLength(0);
      expect(notificationRegistry.size).toBe(0);
    });

    it('stores none of a batch that duplicates a key inside the batch', () => {
      expect(code(() => registerNotifications([registration(), registration()]))).toBe(
        'DUPLICATE_ID',
      );
      expect(NOTIFICATION_EVENTS).toHaveLength(0);
    });
  });

  describe('validation', () => {
    it.each([
      ['a key without the <area>.<event> shape', { key: 'invoice_ready' }, 'INVALID_ID'],
      ['an upper-case key', { key: 'Billing.invoice' }, 'INVALID_ID'],
      ['a blank label', { label: '  ' }, 'INVALID_ENTRY'],
      ['a blank description', { description: '' }, 'INVALID_ENTRY'],
      ['no channels', { channels: [] }, 'INVALID_ENTRY'],
      ['an unknown channel', { channels: ['sms' as never] }, 'INVALID_ENTRY'],
      [
        'a mandatory event that is not enabled by default',
        { mandatory: true, defaultEnabled: false },
        'INVALID_ENTRY',
      ],
    ])('rejects %s', (_label, overrides, expected) => {
      expect(
        code(() =>
          registerNotification({ event: event(overrides as Partial<NotificationEventDef>) }),
        ),
      ).toBe(expected);
      expect(NOTIFICATION_EVENTS).toHaveLength(0);
    });

    it('rejects an email template on an event that does not declare email', () => {
      expect(
        code(() =>
          registerNotification({
            event: event({ channels: ['browser'] }),
            emailTemplate: 'test-email',
          }),
        ),
      ).toBe('INVALID_ENTRY');
    });

    it('rejects a browser template on an event with neither browser nor push', () => {
      expect(
        code(() =>
          registerNotification({
            event: event({ channels: ['email'] }),
            emailTemplate: 'test-email',
            browserTemplate: browserRenderer,
          }),
        ),
      ).toBe('INVALID_ENTRY');
    });

    it('accepts a mandatory event that is enabled by default, with no bindings at all', () => {
      expect(
        code(() =>
          registerNotification({ event: event({ mandatory: true, channels: ['browser'] }) }),
        ),
      ).toBeUndefined();
      expect(emailTemplateNameFor('billing.invoice_ready')).toBeUndefined();
    });
  });

  describe('frozen', () => {
    it('refuses every registration after the registry is frozen and keeps what was there', () => {
      registerNotification(registration());
      notificationRegistry.freeze();

      expect(
        code(() => registerNotification(registration({ event: event({ key: 'billing.late' }) }))),
      ).toBe('FROZEN');
      expect(
        code(() =>
          registerNotifications([registration({ event: event({ key: 'billing.later' }) })]),
        ),
      ).toBe('FROZEN');

      expect(NOTIFICATION_EVENTS.map((e) => e.key)).toEqual(['billing.invoice_ready']);
    });
  });

  describe('the browser template test seam', () => {
    it('overrides the registered renderer, and null removes it', () => {
      registerNotification(registration());
      const replacement = () => ({ title: 'other', body: 'other' });

      overrideBrowserTemplateForTests('billing.invoice_ready', replacement);
      expect(browserTemplateFor('billing.invoice_ready')).toBe(replacement);

      overrideBrowserTemplateForTests('billing.invoice_ready', null);
      expect(browserTemplateFor('billing.invoice_ready')).toBeUndefined();

      clearBrowserTemplateOverridesForTests();
      expect(browserTemplateFor('billing.invoice_ready')).toBe(browserRenderer);
    });

    it('is cleared by the registry reset', () => {
      overrideBrowserTemplateForTests('user.welcome', browserRenderer);
      resetNotificationsForTests();

      expect(browserTemplateFor('user.welcome')).toBeUndefined();
    });
  });
});
