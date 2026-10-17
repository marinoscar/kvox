// =============================================================================
// The events this application delivers, as the platform registry holds them
// (issue #470, epic #467)
// =============================================================================
//
// Before #470 the events lived in `src/notifications/notification-events.ts`.
// They are `registerNotification` entries now (`src/notifications-registry/`
// and the platform's own groups) and the dispatcher, the preferences matrix and
// `GET /api/notifications/events` all read the platform registry. The refactor
// is only allowed to be a no-op on the wire, so this table pins, for every
// event the application ships: the key, the channels it declares, the
// `defaultEnabled` and `mandatory` flags.
//
// KEYS AND CHANNEL IDS ARE PERSISTED in users' stored `notifications` settings
// and in `notification_deliveries`: a change here is a data migration, never a
// refactor. See also `preferences-continuity.db.spec.ts`.
//
// Pure: imports the manifest (a side-effect module that fills the registries),
// boots no Nest application.
// =============================================================================

import {
  emailTemplateRegistry,
  findEmailTemplate,
} from '@marinoscar/platform-api/email';
import {
  eventBrowserTemplateRegistry,
  eventEmailTemplateRegistry,
  findEvent,
  isMandatory,
  listNotificationEvents,
  type NotificationChannel,
} from '@marinoscar/platform-api/notifications';

import '../../src/platform/notifications/notification.manifest';

interface ExpectedEvent {
  key: string;
  channels: NotificationChannel[];
  mandatory: boolean;
  defaultEnabled: boolean;
  emailTemplate?: string;
}

/** Every event the application ships. The order is the preferences matrix order. */
const EXPECTED: ExpectedEvent[] = [
  { key: 'user.welcome', channels: ['email'], mandatory: false, defaultEnabled: true, emailTemplate: 'user-welcome' },
  { key: 'allowlist.invitation', channels: ['email'], mandatory: false, defaultEnabled: true, emailTemplate: 'allowlist-invitation' },
  { key: 'security.role_changed', channels: ['email', 'browser'], mandatory: true, defaultEnabled: true, emailTemplate: 'role-changed' },
  { key: 'allowlist.invitation_reminder', channels: ['email'], mandatory: false, defaultEnabled: true, emailTemplate: 'allowlist-invitation-reminder' },
  { key: 'admin.broadcast', channels: ['email', 'browser', 'push'], mandatory: false, defaultEnabled: true, emailTemplate: 'broadcast' },
  { key: 'admin.broadcast_critical', channels: ['email', 'browser', 'push'], mandatory: true, defaultEnabled: true, emailTemplate: 'broadcast' },
  { key: 'jobs.job_failed', channels: ['email'], mandatory: false, defaultEnabled: true, emailTemplate: 'job-failed' },
  { key: 'nodes.node_offline', channels: ['email', 'browser'], mandatory: false, defaultEnabled: true, emailTemplate: 'node-offline' },
  { key: 'db_backup.backup_failed', channels: ['email', 'browser'], mandatory: false, defaultEnabled: true, emailTemplate: 'backup-failed' },
  { key: 'db_backup.restore_completed', channels: ['email', 'browser'], mandatory: true, defaultEnabled: true, emailTemplate: 'restore-completed' },
  { key: 'transcripts.transcript_ready', channels: ['email', 'browser'], mandatory: false, defaultEnabled: true, emailTemplate: 'transcript-ready' },
  { key: 'transcripts.transcript_failed', channels: ['email', 'browser'], mandatory: false, defaultEnabled: true, emailTemplate: 'transcript-failed' },
  { key: 'sharing.shared_with_you', channels: ['email', 'browser'], mandatory: false, defaultEnabled: true, emailTemplate: 'shared-with-you' },
  { key: 'notes.note_ready', channels: ['email', 'browser'], mandatory: false, defaultEnabled: true, emailTemplate: 'note-ready' },
  { key: 'notes.note_failed', channels: ['email', 'browser'], mandatory: false, defaultEnabled: true, emailTemplate: 'note-failed' },
  { key: 'export.ready', channels: ['browser', 'push'], mandatory: false, defaultEnabled: true },
  { key: 'export.failed', channels: ['browser', 'push'], mandatory: false, defaultEnabled: true },
];

type BrowserRender = (data: unknown) => { title: string; body: string; link?: string };

function browserRender(key: string): BrowserRender | undefined {
  return eventBrowserTemplateRegistry.get(key)?.render as BrowserRender | undefined;
}

describe('the events the application ships', () => {
  it('registers exactly the seventeen events, in the preferences matrix order', () => {
    expect(listNotificationEvents().map((event) => event.key)).toEqual(EXPECTED.map((event) => event.key));
  });

  describe.each(EXPECTED)('$key', (expected) => {
    it('declares the same channels as before', () => {
      expect(findEvent(expected.key)?.channels).toEqual(expected.channels);
    });

    it('is enabled by default', () => {
      expect(findEvent(expected.key)?.defaultEnabled).toBe(expected.defaultEnabled);
    });

    it(`is ${expected.mandatory ? '' : 'NOT '}mandatory`, () => {
      expect(isMandatory(expected.key)).toBe(expected.mandatory);
    });

    it('has a non-empty label and description', () => {
      const event = findEvent(expected.key);

      expect(event?.label.trim()).toBeTruthy();
      expect(event?.description.trim()).toBeTruthy();
    });
  });
});

describe('every channel an event declares can render it', () => {
  const emailEvents = EXPECTED.filter((event) => event.channels.includes('email'));
  const browserEvents = EXPECTED.filter((event) => event.channels.includes('browser'));

  it.each(emailEvents)('$key is bound to the "$emailTemplate" email template', (expected) => {
    expect(eventEmailTemplateRegistry.get(expected.key)?.template).toBe(expected.emailTemplate);
  });

  it.each(emailEvents)('$key: the "$emailTemplate" template is registered and renders', (expected) => {
    expect(emailTemplateRegistry.has(expected.emailTemplate as string)).toBe(true);
    expect(findEmailTemplate(expected.emailTemplate as string)).toEqual(expect.any(Function));
  });

  it.each(browserEvents)('$key has a browser template', (expected) => {
    expect(browserRender(expected.key)).toEqual(expect.any(Function));
  });

  it('binds no browser template to an event that does not declare the browser channel', () => {
    const withoutBrowser = EXPECTED.filter((event) => !event.channels.includes('browser')).map((event) => event.key);

    for (const key of withoutBrowser) {
      expect(eventBrowserTemplateRegistry.get(key)).toBeUndefined();
    }
  });

  it('keeps the this-app email template names the preference matrix and delivery rows persist', () => {
    for (const name of [
      'allowlist-invitation-reminder',
      'transcript-ready',
      'transcript-failed',
      'shared-with-you',
      'note-ready',
      'note-failed',
    ]) {
      expect(emailTemplateRegistry.has(name)).toBe(true);
    }
  });
});

// -----------------------------------------------------------------------------
// The two note events (moved from the deleted `src/notes/notifications` spec)
// -----------------------------------------------------------------------------

describe('the note events', () => {
  const READY = 'notes.note_ready';
  const FAILED = 'notes.note_failed';

  it('are both registered, and are the only events in the notes domain', () => {
    // A 429 is an invisible deferral (spec §2.2), not an outcome: an event for a
    // rate-limited generation would report a delay as something the user must act on.
    const noteKeys = listNotificationEvents()
      .map((event) => event.key)
      .filter((key) => key.startsWith('notes.'));

    expect(noteKeys).toEqual([READY, FAILED]);
  });

  it('link their browser rows to the note, root-relative', () => {
    const readyRow = browserRender(READY)!({
      noteId: 'note-1',
      title: 'Kestrel weekly',
      templateName: 'Meeting notes',
      providerLabel: 'OpenAI',
      model: 'gpt-4o',
      wordCount: 412,
    });
    const failedRow = browserRender(FAILED)!({
      noteId: 'note-1',
      title: 'Kestrel weekly',
      reason: 'Your API key was rejected.',
      category: 'Your API key',
    });

    expect(readyRow.link).toBe('/notes/note-1');
    expect(failedRow.link).toBe('/notes/note-1');
    expect(readyRow.body).toContain('Kestrel weekly');
    expect(failedRow.body).toContain('Your API key was rejected.');
    // Nothing retries a failed generation automatically, so the row must not imply it.
    expect(failedRow.body.toLowerCase()).not.toContain('try again automatically');
  });
});

describe('the transcript events', () => {
  it('link their browser rows to the transcript, root-relative', () => {
    const ready = browserRender('transcripts.transcript_ready')!({
      transcriptId: 'tr-1',
      title: 'Board meeting',
      durationMs: 60_000,
      speakerCount: 2,
      wordCount: 120,
      providerLabel: 'Provider',
    });
    const failed = browserRender('transcripts.transcript_failed')!({
      transcriptId: 'tr-1',
      title: 'Board meeting',
      reason: 'The audio could not be read.',
      stage: 'submit',
      retryable: true,
    });
    // The share message is the platform slice's (#485); its link is the path the
    // resource type\'s `describe()` gives (`app-registrations/sharing.ts`).
    const shared = browserRender('sharing.shared_with_you')!({
      resourceType: 'transcript',
      resourceId: 'tr-1',
      title: 'Board meeting',
      role: 'viewer',
      sharedBy: 'Ana Rivera',
      path: '/transcripts/tr-1',
    });

    for (const row of [ready, failed, shared]) {
      expect(row.link).toBe('/transcripts/tr-1');
      expect(row.link?.startsWith('/')).toBe(true);
      expect(row.link?.startsWith('//')).toBe(false);
    }
  });
});

describe('the export events (platform exports slice, issue #532)', () => {
  const data = { exportId: 'ex-1', source: 'kvox-content', sourceLabel: 'Transcript, note and Ask content', format: 'json' };

  it('link their bell rows to the Download your data page, root-relative, and carry no download URL', () => {
    const ready = browserRender('export.ready')!(data);
    const failed = browserRender('export.failed')!(data);

    for (const row of [ready, failed]) {
      expect(row.link).toBe('/settings/data-export');
      expect(row.link?.startsWith('//')).toBe(false);
      expect(JSON.stringify(row)).not.toMatch(/https?:/);
    }
  });

  it('have no email: a download link must not sit in a mailbox', () => {
    expect(eventEmailTemplateRegistry.get('export.ready')).toBeUndefined();
    expect(eventEmailTemplateRegistry.get('export.failed')).toBeUndefined();
  });
});
