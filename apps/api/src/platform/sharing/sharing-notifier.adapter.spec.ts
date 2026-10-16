import { SharingNotifierAdapter } from './sharing-notifier.adapter';

// =============================================================================
// SharingNotifierAdapter (issue #485)
// =============================================================================
//
// The adapter between the platform sharing slice and the platform dispatcher. What
// is asserted: the event reaches the dispatcher with the absolute URLs the slice
// leaves to the app, a transcript demotion stays silent (as it was under
// `transcripts.transcript_shared`), and every other event passes through untouched.
// =============================================================================

const KEY = 'sharing.shared_with_you';

function build(appUrl: string | undefined = 'https://app.example.test/') {
  const notifications = {
    notify: jest.fn().mockResolvedValue(undefined),
    notifyAddress: jest.fn().mockResolvedValue(undefined),
  };
  const config = { get: jest.fn(() => appUrl) };

  return {
    adapter: new SharingNotifierAdapter(notifications as never, config as never),
    notifications,
  };
}

const share = (overrides: Record<string, unknown> = {}) => ({
  resourceType: 'transcript',
  resourceId: 't-1',
  role: 'viewer',
  title: 'Board meeting',
  path: '/transcripts/t-1',
  sharedBy: 'Ana Rivera',
  ...overrides,
});

describe('SharingNotifierAdapter', () => {
  it('adds the record URL and the sign-in URL, rooted at APP_URL without a trailing slash', async () => {
    const { adapter, notifications } = build();

    await adapter.notify(KEY, 'user-1', share());

    expect(notifications.notify).toHaveBeenCalledWith(KEY, 'user-1', {
      ...share(),
      openUrl: 'https://app.example.test/transcripts/t-1',
      signInUrl: 'https://app.example.test',
    });
  });

  it('adds no URL when the deployment has no APP_URL, and none for a path that is not root-relative', async () => {
    const none = build('');
    await none.adapter.notify(KEY, 'user-1', share());
    expect(none.notifications.notify).toHaveBeenCalledWith(KEY, 'user-1', share());

    const odd = build();
    await odd.adapter.notify(KEY, 'user-1', share({ path: 'https://elsewhere.test/x' }));
    expect(odd.notifications.notify).toHaveBeenCalledWith(
      KEY,
      'user-1',
      expect.not.objectContaining({ openUrl: expect.anything() }),
    );
  });

  it('stays silent on a demotion of a transcript share (editor to viewer)', async () => {
    const { adapter, notifications } = build();

    await adapter.notify(KEY, 'user-1', share({ previousRole: 'editor', role: 'viewer' }));

    expect(notifications.notify).not.toHaveBeenCalled();
  });

  it('notifies a new share, a promotion, and a demotion of any other resource type', async () => {
    const { adapter, notifications } = build();

    await adapter.notify(KEY, 'user-1', share());
    await adapter.notify(KEY, 'user-1', share({ previousRole: 'viewer', role: 'editor' }));
    await adapter.notify(KEY, 'user-1', share({ resourceType: 'album', previousRole: 'editor', role: 'viewer' }));

    expect(notifications.notify).toHaveBeenCalledTimes(3);
  });

  it('passes any other event, and an address notification, through untouched', async () => {
    const { adapter, notifications } = build();

    await adapter.notify('groups.invitation', 'user-1', { groupName: 'Team' });
    await adapter.notifyAddress('groups.invitation', 'a@example.test', { groupName: 'Team' });

    expect(notifications.notify).toHaveBeenCalledWith('groups.invitation', 'user-1', { groupName: 'Team' });
    expect(notifications.notifyAddress).toHaveBeenCalledWith('groups.invitation', 'a@example.test', { groupName: 'Team' });
  });
});
