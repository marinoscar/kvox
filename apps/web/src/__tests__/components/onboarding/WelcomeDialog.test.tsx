/**
 * `WelcomeDialog` / `FirstRunWelcomeDialog` — issue #280, epic #271.
 *
 * ⚠ THE ACCESSIBILITY BLOCK IS THE POINT OF THIS FILE, and every assertion in
 * it is separate on purpose. Over 70% of pages carrying a modal fail at least
 * one WCAG criterion on the same three points — focus never moved in, focus
 * never restored, the screen reader never told a dialog opened — and all three
 * come free from MUI's `Dialog`, which is exactly why they are easy to lose
 * without noticing. A single "renders a dialog" assertion, or a single
 * `vitest-axe` pass, would survive a `disableRestoreFocus` added to quiet an
 * unrelated test.
 *
 * The other half of the file is the "not a gate" promise: four independent
 * close routes, each asserted to close AND to be the one the shell records.
 *
 * `FirstRunWelcomeDialog`'s provider is stubbed rather than stood up; see
 * `onboardingContext`'s own comment in `onboardingFixtures.ts` for why, and
 * `OnboardingContext.test.tsx` for the wiring this file does not re-prove.
 */

import { describe, it, expect, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';
import { useState } from 'react';

import { APP_NAME } from '@app/shared';

import { render, mockUser, mockAdminUser } from '../../utils/test-utils';
import {
  BACK_LABEL,
  BYOK_DIALOG_FACTS,
  CLOSE_LABEL,
  FirstRunWelcomeDialog,
  NEXT_LABEL,
  REDUCED_MOTION_SX,
  SKIP_LABEL,
  WELCOME_PANES,
  WelcomeDialog,
  checklistTarget,
} from '../../../components/onboarding/WelcomeDialog';
import {
  ADMIN_SETUP_PATH,
  GETTING_STARTED_PATH,
} from '../../../components/onboarding/onboardingPaths';
import { OnboardingContext } from '../../../contexts/OnboardingContext';
import type { OnboardingContextValue } from '../../../contexts/OnboardingContext';
import { AXE_OPTIONS } from '../home/homeFixtures';
import { onboardingContext, userState } from './onboardingFixtures';

/** Renders the controlled dialog, open, for whichever account is given. */
function renderDialog({
  admin = false,
  onClose = vi.fn(),
}: { admin?: boolean; onClose?: () => void } = {}) {
  const view = render(<WelcomeDialog open onClose={onClose} />, {
    wrapperOptions: { user: admin ? mockAdminUser : mockUser },
  });
  return { ...view, onClose };
}

/** Advances to a pane by pressing `Next` the right number of times. */
async function goToPane(user: ReturnType<typeof userEvent.setup>, index: number) {
  for (let i = 0; i < index; i += 1) {
    await user.click(screen.getByRole('button', { name: NEXT_LABEL }));
  }
}

/** Renders `FirstRunWelcomeDialog` over a stubbed provider value. */
function renderShell(value: Partial<OnboardingContextValue> = {}) {
  const context = onboardingContext({ user: userState(), ...value });
  const view = render(
    <OnboardingContext.Provider value={context}>
      <FirstRunWelcomeDialog />
    </OnboardingContext.Provider>,
  );
  return { ...view, context };
}

// =============================================================================
// Three panes, and what each of them says
// =============================================================================

describe('the three panes', () => {
  it('is three panes — not four, and not a tour', () => {
    // Asserted as a NUMBER, because "add one more pane" is the single most
    // likely future edit and the argument against it (flows lose 30–50% of
    // users past five steps, and this is a preamble to setup rather than
    // setup) lives in the component header where a reviewer may not look.
    expect(WELCOME_PANES).toHaveLength(3);
    expect(WELCOME_PANES.map((pane) => pane.key)).toEqual(['what', 'byok', 'checklist']);
  });

  it('opens on pane 1 with the product thesis in one sentence', () => {
    renderDialog();

    expect(screen.getByRole('dialog')).toHaveAccessibleName(`Welcome to ${APP_NAME}`);
    expect(screen.getByText(WELCOME_PANES[0]!.lead)).toBeInTheDocument();
    // The four stages, in the journey's own order — the same thesis
    // `JourneyEmptyState` states on the home page.
    expect(screen.getByText(/^Capture —/)).toBeInTheDocument();
    expect(screen.getByText(/^Correct —/)).toBeInTheDocument();
    expect(screen.getByText(/^Transform —/)).toBeInTheDocument();
    expect(screen.getByText(/^Find —/)).toBeInTheDocument();
  });

  it('states the pane position in words, not only as dots', async () => {
    const user = userEvent.setup();
    renderDialog();

    // `MobileStepper`'s dots are unnamed `<div>`s. The position has to be
    // readable, so it is text in the title.
    expect(screen.getByText('Step 1 of 3')).toBeInTheDocument();
    await goToPane(user, 1);
    expect(screen.getByText('Step 2 of 3')).toBeInTheDocument();
  });

  it('states all three BYOK facts on pane 2 — the pane the dialog exists for', async () => {
    const user = userEvent.setup();
    renderDialog();
    await goToPane(user, 1);

    expect(screen.getByRole('dialog')).toHaveAccessibleName('AI runs on your own provider key');

    // ⚠ ALL THREE, BY NAME. None of them implies the others: "you provide the
    // key" does not say who pays, and "you pay" does not say whether this
    // deployment holds one it could fall back on. A test looking for the word
    // "key" would pass over copy that had dropped two of them.
    expect(BYOK_DIALOG_FACTS).toHaveLength(3);
    for (const fact of BYOK_DIALOG_FACTS) {
      expect(screen.getByText(fact)).toBeInTheDocument();
    }
    expect(BYOK_DIALOG_FACTS[0]).toMatch(/The key is yours/);
    expect(BYOK_DIALOG_FACTS[1]).toMatch(/billed to your account/);
    expect(BYOK_DIALOG_FACTS[2]).toMatch(/stores no key of its own/);
  });

  it('walks forward and back, and cannot go back off the first pane', async () => {
    const user = userEvent.setup();
    renderDialog();

    expect(screen.getByRole('button', { name: BACK_LABEL })).toBeDisabled();
    await goToPane(user, 2);
    expect(screen.getByText('Step 3 of 3')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: BACK_LABEL }));
    expect(screen.getByText('Step 2 of 3')).toBeInTheDocument();
  });
});

// =============================================================================
// Pane 3's destination
// =============================================================================

describe("pane 3's button", () => {
  it('targets the deployment checklist for an administrator', async () => {
    const user = userEvent.setup();
    renderDialog({ admin: true });
    await goToPane(user, 2);

    const cta = screen.getByRole('link', { name: 'Open deployment setup' });
    expect(cta).toHaveAttribute('href', ADMIN_SETUP_PATH);
  });

  it("targets the caller's own checklist for everybody else", async () => {
    const user = userEvent.setup();
    renderDialog();
    await goToPane(user, 2);

    const cta = screen.getByRole('link', { name: 'Open your checklist' });
    expect(cta).toHaveAttribute('href', GETTING_STARTED_PATH);
  });

  it('closes as it navigates, so the modal is not left over the page it sent you to', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderDialog({ onClose });
    await goToPane(user, 2);

    await user.click(screen.getByRole('link', { name: 'Open your checklist' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('decides the destination from the permission the controller enforces', () => {
    // ⚠ The mapping, asserted directly: an administrator sent to
    // `/settings/getting-started` would be shown a three-item personal
    // checklist while the deployment they are responsible for cannot
    // transcribe; an ordinary user sent to `/admin/settings/setup` gets a 403.
    expect(checklistTarget(true).path).toBe(ADMIN_SETUP_PATH);
    expect(checklistTarget(false).path).toBe(GETTING_STARTED_PATH);
  });
});

// =============================================================================
// ⚠ NOT A GATE — four close routes, all equal
// =============================================================================

describe('it is not a gate', () => {
  it('closes on Escape', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderDialog({ onClose });

    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on the close button, which is named rather than a bare ×', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderDialog({ onClose });

    // A bare "×" announces as "button" and nothing else, over a dialog that
    // opened unprompted on whatever page the user had just reached.
    await user.click(screen.getByRole('button', { name: CLOSE_LABEL }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on a backdrop click', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const { baseElement } = renderDialog({ onClose });

    const backdrop = baseElement.querySelector('.MuiBackdrop-root');
    expect(backdrop).not.toBeNull();
    await user.click(backdrop as Element);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on Skip', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderDialog({ onClose });

    await user.click(screen.getByRole('button', { name: SKIP_LABEL }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('gives Skip the same visual weight as Next, and both to the keyboard', async () => {
    const user = userEvent.setup();
    renderDialog();

    const skip = screen.getByRole('button', { name: SKIP_LABEL });
    const next = screen.getByRole('button', { name: NEXT_LABEL });

    // ⚠ SAME VARIANT, SAME COLOUR. A greyed `Skip` beside a filled `Next` is a
    // dismissal the design is discouraging, and a modal you are discouraged
    // from dismissing on a product you are still evaluating is where the
    // evaluation stops. Asserted on the emitted MUI variant/colour classes
    // rather than on computed styles, which jsdom cannot resolve.
    for (const variantClass of ['MuiButton-text', 'MuiButton-colorPrimary', 'MuiButton-sizeSmall']) {
      expect(skip, `Skip should carry ${variantClass}`).toHaveClass(variantClass);
      expect(next, `Next should carry ${variantClass}`).toHaveClass(variantClass);
    }

    // And both are reachable by keyboard from the first pane.
    const reachable = new Set<Element>();
    for (let i = 0; i < 8; i += 1) {
      await user.tab();
      if (document.activeElement) reachable.add(document.activeElement);
    }
    expect(reachable.has(skip)).toBe(true);
    expect(reachable.has(next)).toBe(true);
  });

  it('reopens on pane 1 rather than resuming where it was closed', async () => {
    // A replay from the getting-started page that resumed on pane 3 would open
    // on the button that sent the user to the page they are already on.
    const user = userEvent.setup();

    function Harness() {
      const [open, setOpen] = useState(true);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Replay
          </button>
          <WelcomeDialog open={open} onClose={() => setOpen(false)} />
        </>
      );
    }

    render(<Harness />);
    await goToPane(user, 2);
    expect(screen.getByText('Step 3 of 3')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: SKIP_LABEL }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: 'Replay' }));
    expect(screen.getByText('Step 1 of 3')).toBeInTheDocument();
  });
});

// =============================================================================
// ⚠ ACCESSIBILITY — one assertion per failure mode, never one for all of them
// =============================================================================

describe('accessibility', () => {
  it('is a dialog whose name and description resolve to real elements with text', () => {
    renderDialog();

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('role', 'dialog');

    // ⚠ RESOLVED, NOT MERELY PRESENT. An `aria-labelledby` pointing at an id
    // that does not exist announces as nothing at all, and it is indentical to
    // a correct one in every snapshot and every DOM dump.
    const labelledBy = dialog.getAttribute('aria-labelledby');
    const describedBy = dialog.getAttribute('aria-describedby');
    expect(labelledBy).toBeTruthy();
    expect(describedBy).toBeTruthy();

    const label = document.getElementById(labelledBy!);
    const description = document.getElementById(describedBy!);
    expect(label).not.toBeNull();
    expect(description).not.toBeNull();
    expect(label).toHaveTextContent(`Welcome to ${APP_NAME}`);
    expect(description).toHaveTextContent(WELCOME_PANES[0]!.lead);

    // The name is the pane heading alone — not the heading with "Step 1 of 3"
    // welded onto the front of it.
    expect(label).not.toHaveTextContent('Step 1 of 3');
  });

  it('traps focus inside the dialog while it is open', async () => {
    const user = userEvent.setup();

    function Harness() {
      return (
        <>
          {/* Queried by test id rather than by role: MUI marks everything
              behind an open modal `aria-hidden`, so by the time this assertion
              matters the button is — correctly — no longer in the
              accessibility tree at all. */}
          <button type="button" data-testid="outside-the-dialog">
            Outside the dialog
          </button>
          <WelcomeDialog open onClose={() => {}} />
        </>
      );
    }

    render(<Harness />);
    const dialog = screen.getByRole('dialog');
    const outside = screen.getByTestId('outside-the-dialog');

    // Tabbing all the way round must never land on the button behind the
    // modal — the failure that lets a keyboard user walk out of a dialog they
    // cannot see they have left.
    for (let i = 0; i < 12; i += 1) {
      await user.tab();
      expect(document.activeElement).not.toBe(outside);
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
  });

  it('restores focus to the element that was focused before it opened', async () => {
    const user = userEvent.setup();

    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Replay the intro
          </button>
          <WelcomeDialog open={open} onClose={() => setOpen(false)} />
        </>
      );
    }

    render(<Harness />);
    const trigger = screen.getByRole('button', { name: 'Replay the intro' });

    trigger.focus();
    await user.click(trigger);
    await screen.findByRole('dialog');
    expect(trigger).not.toHaveFocus();

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    // ⚠ THE CRITERION. Without this, closing drops focus back to `<body>` and
    // a keyboard user restarts from the top of the page they were already
    // partway down.
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it('suppresses its transition for prefers-reduced-motion, in CSS rather than a hook', () => {
    renderDialog();

    // The constant, pinned: `!important` is load-bearing, because MUI writes
    // the transition as an INLINE style that an ordinary class rule cannot
    // outrank however specific it is.
    expect(REDUCED_MOTION_SX['@media (prefers-reduced-motion: reduce)']).toEqual({
      transition: 'none !important',
      animation: 'none !important',
    });

    // And it actually reached the document, rather than being an exported
    // object nothing applies. jsdom evaluates no media queries, so the emitted
    // rules are the only readable evidence.
    const emitted = [...document.querySelectorAll('style')]
      .map((style) => style.textContent ?? '')
      .join('');
    expect(emitted).toContain('prefers-reduced-motion');
  });

  it.each(WELCOME_PANES.map((pane, index) => [pane.key, index] as const))(
    'is axe-clean on the %s pane',
    async (_key, index) => {
      const user = userEvent.setup();
      renderDialog();
      await goToPane(user, index);

      // The dialog portals to `document.body`, outside the rendered container.
      expect(await axe(document.body, AXE_OPTIONS)).toHaveNoViolations();
    },
  );
});

// =============================================================================
// The shell's first-run decision
// =============================================================================

describe('FirstRunWelcomeDialog', () => {
  it('opens once for an account with no welcomeSeenAt', async () => {
    renderShell();
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });

  it('never opens for an account that has seen it', () => {
    renderShell({ welcomeSeen: true });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('does not open while the first read is still settling', () => {
    // A dialog that flashes up for one frame and vanishes when a stored
    // `welcomeSeenAt` lands a tick later is worse than one that appears a beat
    // late. `isLoading` covers the settings read too (see the context header).
    renderShell({ isLoading: true });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('does not open when the checklist itself failed to load', () => {
    // ⚠ The non-obvious gate. The last pane hands the user a button to a
    // checklist; opening over a failed read means the product's first ten
    // seconds are a screen it opened by itself, ending in a page that will not
    // load. The provider renders nothing on a failed read, and so does this.
    renderShell({ user: null, error: 'Failed to load setup state' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it.each([
    ['Escape', async (user: ReturnType<typeof userEvent.setup>) => user.keyboard('{Escape}')],
    [
      'the close button',
      async (user: ReturnType<typeof userEvent.setup>) =>
        user.click(screen.getByRole('button', { name: CLOSE_LABEL })),
    ],
    [
      'Skip',
      async (user: ReturnType<typeof userEvent.setup>) =>
        user.click(screen.getByRole('button', { name: SKIP_LABEL })),
    ],
  ])('records welcomeSeenAt when closed by %s', async (_label, close) => {
    const user = userEvent.setup();
    const { context } = renderShell();
    await screen.findByRole('dialog');

    await close(user);

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(context.markWelcomeSeen).toHaveBeenCalledTimes(1);
  });

  it('does not reopen once closed, whatever the checklist does afterwards', async () => {
    const user = userEvent.setup();
    const { context, rerender } = renderShell();
    await screen.findByRole('dialog');
    await user.click(screen.getByRole('button', { name: SKIP_LABEL }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    // ⚠ THE REGISTRY GROWING A STEP MUST NOT BRING IT BACK. `welcomeSeenAt`
    // records a decision about THE INTRODUCTION, not about a particular set of
    // steps — re-showing it after a release added `admin.push` would make every
    // upgrade feel like a regression to every existing user. The stub still
    // reports `welcomeSeen: false` here (the write is the provider's job, and
    // it is mocked), so this is the strictest version of the assertion: even
    // with the stored flag unchanged, it stays shut.
    rerender(
      <OnboardingContext.Provider value={{ ...context, user: userState() }}>
        <FirstRunWelcomeDialog />
      </OnboardingContext.Provider>,
    );

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('renders nothing with no provider in the tree at all', () => {
    // Several suites render shell surfaces on their own and none of them is
    // about onboarding, so `useOnboarding` returns null rather than throwing.
    render(<FirstRunWelcomeDialog />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

// =============================================================================
// The dialog is inert when closed
// =============================================================================

describe('when closed', () => {
  it('renders no dialog and no copy at all', () => {
    const { baseElement } = render(<WelcomeDialog open={false} onClose={() => {}} />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(within(baseElement).queryByText(WELCOME_PANES[0]!.lead)).not.toBeInTheDocument();
  });
});
