/**
 * The broadcast composer (issue #325, epic #319).
 *
 * This dialog is the only place in the application where a single submit
 * reaches every user at once and cannot be undone, so what is under test is not
 * "does the form hold text" — it is every guard that stands between an
 * administrator and a send they did not mean:
 *
 *   * SUBMIT IS REFUSED with no channels, because the dispatcher reads an empty
 *     channel set as "every channel muted" — the send would be accepted,
 *     queued, fanned out across every active user, deliver nothing, and report
 *     success at every layer.
 *   * IMPORTANT FORCES AND LOCKS IN-APP, mirroring the API's `critical ⇒
 *     browser` refinement client-side, so the 400 is unreachable from this
 *     form. A critical announcement with no durable in-app row is unreadable by
 *     anyone who missed the mail — the exact failure `mandatory` exists to
 *     prevent, arriving through the sender's door.
 *   * A PAST TIME BLOCKS SUBMIT, because a past `scheduledFor` is claimable on
 *     the very next poll: the API turns "I mistyped the date" into an immediate
 *     send to everybody, so the composer must refuse it first.
 *   * THE PREVIEW SPLITS PARAGRAPHS, because the body's one formatting rule is
 *     invisible in a textarea.
 *   * "SEND TEST TO ME" POSTS AND LEAVES THE DIALOG OPEN — a test send is a
 *     step in composing, not the end of it.
 *   * PUSH IS DISABLED WITH A TOOLTIP when the deployment has no push channel,
 *     rather than offered and silently dropped.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../../utils/test-utils';
import { BroadcastComposer } from '../../../components/admin/BroadcastComposer';
import type { NotificationConfigResponse } from '../../../types';

vi.mock('../../../hooks/useNotificationConfig', () => ({
  useNotificationConfig: vi.fn(),
}));

import { useNotificationConfig } from '../../../hooks/useNotificationConfig';

const mockUseNotificationConfig = vi.mocked(useNotificationConfig);

function setConfig(config: NotificationConfigResponse | null) {
  mockUseNotificationConfig.mockReturnValue({
    config,
    isLoading: config === null,
    error: null,
    refresh: vi.fn(),
  });
}

const onSubmit = vi.fn();
const onSendTest = vi.fn();
const onClose = vi.fn();

function renderComposer(overrides: { audience?: number | null; isWorking?: boolean } = {}) {
  return render(
    <BroadcastComposer
      open
      onClose={onClose}
      audience={overrides.audience === undefined ? 1284 : overrides.audience}
      isWorking={overrides.isWorking ?? false}
      onSubmit={onSubmit}
      onSendTest={onSendTest}
    />,
  );
}

const submitButton = () => screen.getByRole('button', { name: /^send…$|^schedule…$/i });

/**
 * The live element a disabled control's tooltip hangs off.
 *
 * MUI sets `pointer-events: none` on a disabled `Checkbox`'s own root, so a
 * `Tooltip` wrapping it would never fire — which is the whole reason the
 * composer wraps each one in a plain `<span>`. That span is the
 * `FormControlLabel`'s parent, and it is what a real pointer would enter.
 */
function tooltipAnchorFor(control: HTMLElement): HTMLElement {
  return control.closest('label')?.parentElement as HTMLElement;
}

/** Fill the minimum a valid composition needs. */
async function compose(
  user: ReturnType<typeof userEvent.setup>,
  body = 'We will be offline from 01:00.',
) {
  await user.type(screen.getByLabelText(/^title/i), 'Planned maintenance');
  await user.type(screen.getByLabelText(/^body/i), body);
}

describe('BroadcastComposer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setConfig({ browserEnabled: true, pushEnabled: true, vapidPublicKey: 'key' });
    onSubmit.mockResolvedValue(true);
    onSendTest.mockResolvedValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // =========================================================================
  // Channels
  // =========================================================================

  describe('channels', () => {
    it('disables submit when every channel is cleared', async () => {
      const user = userEvent.setup();
      renderComposer();
      await compose(user);

      expect(submitButton()).toBeEnabled();

      // The two defaults off: In-app and Email.
      await user.click(screen.getByRole('checkbox', { name: 'In-app' }));
      await user.click(screen.getByRole('checkbox', { name: 'Email' }));

      expect(submitButton()).toBeDisabled();
      expect(screen.getByText(/select at least one channel/i)).toBeInTheDocument();
    });

    it('disables Push with a tooltip when the deployment has no push channel', async () => {
      const user = userEvent.setup();
      setConfig({ browserEnabled: true, pushEnabled: false, vapidPublicKey: null });
      renderComposer();

      const push = screen.getByRole('checkbox', { name: 'Push' });
      expect(push).toBeDisabled();
      expect(push).not.toBeChecked();

      // The tooltip hangs off the live wrapper a disabled control needs.
      await user.hover(tooltipAnchorFor(push));
      expect(await screen.findByRole('tooltip')).toHaveTextContent(/push is not configured/i);
    });

    it('leaves Push selectable when push is configured', () => {
      renderComposer();

      expect(screen.getByRole('checkbox', { name: 'Push' })).toBeEnabled();
    });

    it('warns beside In-app when browser notifications are off deployment-wide', () => {
      // A WARNING, not a block: the kill switch mutes the OS toast, the durable
      // in-app row is still written, and scheduling for after the switch is
      // flipped back is legitimate — which is why the API treats this as a
      // non-fatal warning rather than a 400.
      setConfig({ browserEnabled: false, pushEnabled: true, vapidPublicKey: 'key' });
      renderComposer();

      expect(
        screen.getByText(/browser notifications are turned off for this deployment/i),
      ).toBeInTheDocument();
      expect(screen.getByRole('checkbox', { name: 'In-app' })).toBeEnabled();
    });

    it('shows no warning while the config is still loading', () => {
      // The tri-state read `useNotificationConfig`'s header insists on:
      // `=== false`, never `!config?.browserEnabled`. The negated form reads
      // `true` during the loading window and would flicker this banner in on
      // every open.
      setConfig(null);
      renderComposer();

      expect(
        screen.queryByText(/browser notifications are turned off/i),
      ).not.toBeInTheDocument();
      expect(screen.getByRole('checkbox', { name: 'Push' })).toBeEnabled();
    });
  });

  // =========================================================================
  // Importance
  // =========================================================================

  describe('the Important switch', () => {
    it('forces In-app on and locks it, mirroring the API’s critical ⇒ browser rule', async () => {
      const user = userEvent.setup();
      renderComposer();

      // Start from a state where In-app is explicitly OFF, so "forces" is
      // genuinely being asserted rather than "leaves alone".
      const inApp = screen.getByRole('checkbox', { name: 'In-app' });
      await user.click(inApp);
      expect(inApp).not.toBeChecked();

      await user.click(screen.getByRole('switch', { name: /important/i }));

      await waitFor(() => expect(inApp).toBeChecked());
      expect(inApp).toBeDisabled();
    });

    it('explains why it cannot be turned off', async () => {
      const user = userEvent.setup();
      renderComposer();

      await user.click(screen.getByRole('switch', { name: /important/i }));
      await user.hover(tooltipAnchorFor(screen.getByRole('checkbox', { name: 'In-app' })));

      expect(await screen.findByRole('tooltip')).toHaveTextContent(/must leave an in-app record/i);
    });

    it('sends critical: true with the browser channel included', async () => {
      const user = userEvent.setup();
      renderComposer();
      await compose(user);
      await user.click(screen.getByRole('switch', { name: /important/i }));
      await user.click(submitButton());

      const confirmation = await screen.findByRole('dialog', { name: /send this to everyone/i });
      await user.click(within(confirmation).getByRole('button', { name: /send broadcast/i }));

      await waitFor(() => expect(onSubmit).toHaveBeenCalled());
      const body = onSubmit.mock.calls[0][0];
      expect(body.critical).toBe(true);
      expect(body.channels).toContain('browser');
    });
  });

  // =========================================================================
  // Scheduling
  // =========================================================================

  describe('scheduling', () => {
    it('blocks submit for a time in the past', async () => {
      const user = userEvent.setup();
      renderComposer();
      await compose(user);

      await user.click(screen.getByRole('radio', { name: /schedule for later/i }));
      const field = screen.getByLabelText(/send at/i);
      await user.clear(field);
      await user.type(field, '2020-01-01T09:00');

      expect(submitButton()).toBeDisabled();
      expect(screen.getByText(/pick a time in the future/i)).toBeInTheDocument();
    });

    it('blocks submit while the schedule field is empty', async () => {
      // "Schedule for later" with no time is not "send now" — it is an
      // unfinished form, and treating it as immediate would be the worst
      // possible default for this particular action.
      const user = userEvent.setup();
      renderComposer();
      await compose(user);

      await user.click(screen.getByRole('radio', { name: /schedule for later/i }));

      expect(submitButton()).toBeDisabled();
    });

    it('shows the resolved instant in both the local zone and UTC', async () => {
      const user = userEvent.setup();
      renderComposer();
      await compose(user);

      await user.click(screen.getByRole('radio', { name: /schedule for later/i }));
      const future = new Date(Date.now() + 24 * 60 * 60 * 1000);
      const value =
        `${future.getFullYear()}-${String(future.getMonth() + 1).padStart(2, '0')}-` +
        `${String(future.getDate()).padStart(2, '0')}T09:00`;
      await user.type(screen.getByLabelText(/send at/i), value);

      // A `datetime-local` value carries no zone, so the field alone cannot
      // tell an admin in one office what an admin in another will see.
      expect(await screen.findByText(/in your time zone/i)).toBeInTheDocument();
      expect(screen.getByText(/UTC\.$/)).toBeInTheDocument();
    });

    it('sends an ISO instant, not the raw wall-clock value', async () => {
      const user = userEvent.setup();
      renderComposer();
      await compose(user);

      await user.click(screen.getByRole('radio', { name: /schedule for later/i }));
      const future = new Date(Date.now() + 24 * 60 * 60 * 1000);
      const value =
        `${future.getFullYear()}-${String(future.getMonth() + 1).padStart(2, '0')}-` +
        `${String(future.getDate()).padStart(2, '0')}T09:00`;
      await user.type(screen.getByLabelText(/send at/i), value);

      await user.click(screen.getByRole('button', { name: /^schedule…$/i }));
      const confirmation = await screen.findByRole('dialog', { name: /schedule this broadcast/i });
      await user.click(within(confirmation).getByRole('button', { name: /schedule broadcast/i }));

      await waitFor(() => expect(onSubmit).toHaveBeenCalled());
      expect(onSubmit.mock.calls[0][0].scheduledFor).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
      );
    });
  });

  // =========================================================================
  // The preview
  // =========================================================================

  describe('the preview', () => {
    it('splits the body on blank lines, as the bell will', async () => {
      const user = userEvent.setup();
      renderComposer();
      await compose(user, 'First paragraph.\n\nSecond paragraph.');

      const preview = screen.getByTestId('broadcast-preview');
      expect(within(preview).getByText('First paragraph.')).toBeInTheDocument();
      expect(within(preview).getByText('Second paragraph.')).toBeInTheDocument();
      // Two elements, not one string with a blank line in it — the rule is
      // invisible in the textarea, so the preview is where it becomes visible.
      expect(within(preview).queryByText('First paragraph.\n\nSecond paragraph.')).toBeNull();
    });

    it('names the audience and the channels in one plain sentence', async () => {
      const user = userEvent.setup();
      renderComposer();
      await compose(user);

      expect(
        screen.getByText(/goes to all 1,284 active users over In-app and Email\./i),
      ).toBeInTheDocument();
    });

    it('says "all active users" rather than zero when the count has not resolved', async () => {
      const user = userEvent.setup();
      renderComposer({ audience: null });
      await compose(user);

      expect(screen.getByText(/goes to all active users over/i)).toBeInTheDocument();
      expect(screen.queryByText(/all 0 active users/i)).not.toBeInTheDocument();
    });
  });

  // =========================================================================
  // The link and its CTA
  // =========================================================================

  describe('the link', () => {
    it('keeps the button label disabled until a link is present', async () => {
      const user = userEvent.setup();
      renderComposer();

      expect(screen.getByLabelText(/button label/i)).toBeDisabled();

      await user.type(screen.getByLabelText(/^link/i), '/status');

      expect(screen.getByLabelText(/button label/i)).toBeEnabled();
    });

    it('refuses an external link on blur, with the reason', async () => {
      const user = userEvent.setup();
      renderComposer();
      await compose(user);

      await user.type(screen.getByLabelText(/^link/i), 'https://evil.example/x');
      await user.tab();

      expect(await screen.findByText(/must point inside this application/i)).toBeInTheDocument();
      expect(submitButton()).toBeDisabled();
    });

    it('refuses a protocol-relative link, the classic bypass of a naive check', async () => {
      const user = userEvent.setup();
      renderComposer();
      await compose(user);

      await user.type(screen.getByLabelText(/^link/i), '//evil.example/x');
      await user.tab();

      expect(await screen.findByText(/link to another site/i)).toBeInTheDocument();
      expect(submitButton()).toBeDisabled();
    });

    it('accepts a root-relative path', async () => {
      const user = userEvent.setup();
      renderComposer();
      await compose(user);

      await user.type(screen.getByLabelText(/^link/i), '/status?tab=live');
      await user.tab();

      expect(screen.queryByText(/must point inside this application/i)).not.toBeInTheDocument();
      expect(submitButton()).toBeEnabled();
    });
  });

  // =========================================================================
  // Send test to me
  // =========================================================================

  describe('send test to me', () => {
    it('posts the current composition and leaves the dialog open', async () => {
      const user = userEvent.setup();
      renderComposer();
      await compose(user, 'First paragraph.\n\nSecond paragraph.');

      await user.click(screen.getByRole('button', { name: /send test to me/i }));

      await waitFor(() => expect(onSendTest).toHaveBeenCalled());
      expect(onSendTest.mock.calls[0][0]).toMatchObject({
        title: 'Planned maintenance',
        body: 'First paragraph.\n\nSecond paragraph.',
        channels: ['browser', 'email'],
        critical: false,
      });

      // A test send is a step in composing, not the end of it — closing here
      // would throw away the draft the admin is about to adjust.
      expect(onClose).not.toHaveBeenCalled();
      expect(screen.getByLabelText(/^title/i)).toHaveValue('Planned maintenance');
      expect(await screen.findByText(/test sent to you only/i)).toBeInTheDocument();
      // And nothing was actually broadcast.
      expect(onSubmit).not.toHaveBeenCalled();
    });

    it('is disabled until the composition is valid', () => {
      renderComposer();

      expect(screen.getByRole('button', { name: /send test to me/i })).toBeDisabled();
    });
  });

  // =========================================================================
  // The confirmation
  // =========================================================================

  describe('the confirmation', () => {
    it('stands between the submit button and the send', async () => {
      const user = userEvent.setup();
      renderComposer();
      await compose(user);

      await user.click(submitButton());

      expect(
        await screen.findByRole('dialog', { name: /send this to everyone/i }),
      ).toBeInTheDocument();
      expect(onSubmit).not.toHaveBeenCalled();
    });

    it('names the audience, the channels and the importance', async () => {
      const user = userEvent.setup();
      renderComposer();
      await compose(user);
      await user.click(submitButton());

      const confirmation = await screen.findByRole('dialog', { name: /send this to everyone/i });
      expect(within(confirmation).getByText(/all 1,284 active users/i)).toBeInTheDocument();
      expect(within(confirmation).getByText(/In-app and Email/i)).toBeInTheDocument();
      expect(within(confirmation).getByText(/normal importance/i)).toBeInTheDocument();
      expect(within(confirmation).getByText(/cannot be edited or recalled/i)).toBeInTheDocument();
    });

    it('backs out without sending', async () => {
      const user = userEvent.setup();
      renderComposer();
      await compose(user);
      await user.click(submitButton());

      const confirmation = await screen.findByRole('dialog', { name: /send this to everyone/i });
      await user.click(within(confirmation).getByRole('button', { name: /^back$/i }));

      expect(onSubmit).not.toHaveBeenCalled();
      expect(onClose).not.toHaveBeenCalled();
    });

    it('closes the composer once the send is accepted', async () => {
      const user = userEvent.setup();
      renderComposer();
      await compose(user);
      await user.click(submitButton());

      const confirmation = await screen.findByRole('dialog', { name: /send this to everyone/i });
      await user.click(within(confirmation).getByRole('button', { name: /send broadcast/i }));

      await waitFor(() => expect(onClose).toHaveBeenCalled());
    });

    it('keeps the composer open when the send is refused', async () => {
      // The draft must survive a 400 — it is the only copy of what was typed.
      const user = userEvent.setup();
      onSubmit.mockResolvedValue(false);
      renderComposer();
      await compose(user);
      await user.click(submitButton());

      const confirmation = await screen.findByRole('dialog', { name: /send this to everyone/i });
      await user.click(within(confirmation).getByRole('button', { name: /send broadcast/i }));

      await waitFor(() => expect(onSubmit).toHaveBeenCalled());
      expect(onClose).not.toHaveBeenCalled();
      expect(screen.getByLabelText(/^title/i)).toHaveValue('Planned maintenance');
    });
  });
});
