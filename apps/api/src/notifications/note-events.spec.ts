// =============================================================================
// The two note events cost ONE registry entry each (issue #49, epic #45)
// =============================================================================
//
// The same promise `operational-events-no-migration.spec.ts` proves for #288's
// four, asserted here for #49's two: a new notification is DATA, not DDL. These
// keys reach `GET /api/notifications/events` — the preferences matrix — because
// they are in `NOTIFICATION_EVENTS`, and for no other reason: no table, no
// column, no enum, no preference row written for anybody (absent means
// enabled, which is what `defaultEnabled: true` means in a sparse store).
//
// The template registrations are asserted too, because a missing one is a
// RECORDED DELIVERY FAILURE rather than an exception — the kind of mistake that
// ships quietly and is discovered by a user who never got their email.
// =============================================================================

import { EMAIL_TEMPLATES, type EmailTemplateName } from '../email/templates';
import { EVENT_BROWSER_TEMPLATES } from './channels/browser-notification.channel';
import { EVENT_EMAIL_TEMPLATES } from './channels/email-notification.channel';
import {
  NOTIFICATION_EVENTS,
  channelsFor,
  findEvent,
  isMandatory,
} from './notification-events';

const READY = 'notes.note_ready';
const FAILED = 'notes.note_failed';

describe('the note events are registered', () => {
  it.each([READY, FAILED])('%s appears in the registry the matrix renders', (key) => {
    expect(NOTIFICATION_EVENTS.map((event) => event.key)).toContain(key);
    expect(findEvent(key)).toBeDefined();
  });

  it.each([READY, FAILED])('%s is deliverable over email AND browser', (key) => {
    expect(channelsFor(key).sort()).toEqual(['browser', 'email']);
  });

  it.each([READY, FAILED])('%s is enabled by default', (key) => {
    expect(findEvent(key)?.defaultEnabled).toBe(true);
  });

  it.each([READY, FAILED])('%s is NOT mandatory — a user may silence it', (key) => {
    // Being told your own requested work finished is a courtesy about your own
    // action, not a security-relevant change to your account.
    expect(isMandatory(key)).toBe(false);
    expect(findEvent(key)?.mandatory).toBeUndefined();
  });

  it('has no event for a rate-limited generation', () => {
    // A 429 is an invisible deferral (spec §2.2), not an outcome. An event for
    // it would report a delay as something the user must act on.
    const noteKeys = NOTIFICATION_EVENTS.map((event) => event.key).filter((key) =>
      key.startsWith('notes.'),
    );

    expect(noteKeys).toEqual([READY, FAILED]);
  });
});

describe('both channels can actually render them', () => {
  it.each([
    [READY, 'note-ready'],
    [FAILED, 'note-failed'],
  ])('%s maps to the %s email template, which is registered', (key, templateName) => {
    expect(EVENT_EMAIL_TEMPLATES[key]).toBe(templateName);
    expect(EMAIL_TEMPLATES[templateName as EmailTemplateName]).toBeDefined();
  });

  it.each([READY, FAILED])('%s has a browser template', (key) => {
    expect(EVENT_BROWSER_TEMPLATES[key]).toBeDefined();
  });

  it('the browser rows link to the note, root-relative', () => {
    const ready = EVENT_BROWSER_TEMPLATES[READY] as (data: unknown) => {
      title: string;
      body: string;
      link?: string;
    };
    const failed = EVENT_BROWSER_TEMPLATES[FAILED] as (data: unknown) => {
      title: string;
      body: string;
      link?: string;
    };

    const readyRow = ready({
      noteId: 'note-1',
      title: 'Kestrel weekly',
      templateName: 'Meeting notes',
      providerLabel: 'OpenAI',
      model: 'gpt-4o',
      wordCount: 412,
    });

    const failedRow = failed({
      noteId: 'note-1',
      title: 'Kestrel weekly',
      reason: 'Your API key was rejected.',
      category: 'Your API key',
    });

    expect(readyRow.link).toBe('/notes/note-1');
    expect(failedRow.link).toBe('/notes/note-1');
    expect(readyRow.body).toContain('Kestrel weekly');
    expect(failedRow.body).toContain('Your API key was rejected.');
    // NOTHING that implies an automatic retry — nothing retries this.
    expect(failedRow.body.toLowerCase()).not.toContain('try again automatically');
  });
});
