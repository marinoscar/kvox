/**
 * `SetupChecklist` — issue #276, epic #271.
 *
 * The component takes props and owns no data, so this file asserts the one
 * thing it is actually responsible for: that the list is READABLE, in the
 * specific sense #271's criteria mean by that.
 *
 * ⚠ EVERY STATUS ASSERTION BELOW IS ON THE WORDS, NEVER ON THE ICON. That is
 * the whole point of the assertion. A checklist conveying "done" with a green
 * tick and "not set up" with a grey circle passes every visual check and is
 * unreadable to a screen reader and to anyone who cannot tell the two colours
 * apart — and a test that queried by `data-testid` on the icon would be equally
 * happy either way.
 *
 * The responsive behaviour is NOT asserted and cannot be: it is a handful of
 * `sx` breakpoint objects and jsdom performs no layout. What matters — that no
 * `useMediaQuery` creeps in and makes a sixth coupled breakpoint gate
 * (`docs/specs/settings-ui.md` §5) — IS asserted, against the source, in the
 * last block of this file.
 */

import { describe, it, expect, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type { ComponentProps } from 'react';

import { render } from '../../utils/test-utils';
import {
  SetupChecklist,
  STATUS_LABELS,
  sortStepsByTier,
  stepDomId,
} from '../../../components/onboarding/SetupChecklist';
import { AXE_OPTIONS } from '../home/homeFixtures';
import { onboardingState, step, userState } from './onboardingFixtures';

const HERE = dirname(fileURLToPath(import.meta.url));
const ONBOARDING_DIR = resolve(HERE, '../../../components/onboarding');
const CONTEXT_SOURCE = resolve(HERE, '../../../contexts/OnboardingContext.tsx');

const noop = () => {};

function renderChecklist(props: Partial<ComponentProps<typeof SetupChecklist>> = {}) {
  return render(
    <SetupChecklist
      state={userState()}
      onSkip={noop}
      onUnskip={noop}
      onAction={noop}
      {...props}
    />,
  );
}

// =============================================================================
// Status is text
// =============================================================================

describe('status', () => {
  it('spells out each status as words, not as an icon or a colour', () => {
    renderChecklist({
      state: onboardingState({
        steps: [
          step({ key: 'a', title: 'Alpha', status: 'satisfied' }),
          step({ key: 'b', title: 'Bravo', status: 'pending' }),
          step({
            key: 'c',
            title: 'Charlie',
            status: 'blocked',
            blockedReason: 'Your administrator has not configured transcription yet.',
          }),
        ],
      }),
    });

    expect(screen.getByText(STATUS_LABELS.satisfied)).toBeInTheDocument();
    expect(screen.getByText(STATUS_LABELS.pending)).toBeInTheDocument();
    expect(screen.getByText(STATUS_LABELS.blocked)).toBeInTheDocument();

    // The literals, pinned here as well as in the component, because the exact
    // wording IS the accessible status and a silent change to it is a silent
    // change to what a screen reader announces.
    expect(STATUS_LABELS).toEqual({
      satisfied: 'Done',
      pending: 'Not set up',
      blocked: 'Waiting on your administrator',
    });
  });

  it('hides every decorative icon from assistive technology', () => {
    const { container } = renderChecklist();

    const icons = container.querySelectorAll('svg');
    expect(icons.length).toBeGreaterThan(0);
    for (const icon of icons) {
      // MUI icons carry `aria-hidden` themselves; what this asserts is that
      // none of them was given a label and promoted into the accessibility
      // tree as the carrier of a meaning the text is supposed to carry.
      expect(icon.closest('[aria-hidden="true"]')).not.toBeNull();
    }
  });
});

// =============================================================================
// The list is a real list
// =============================================================================

describe('the list', () => {
  it('renders an ordered list with one item per step', () => {
    renderChecklist();

    const list = screen.getByRole('list', { name: 'Setup steps' });
    expect(list.tagName).toBe('OL');
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
  });

  it('puts required steps first and keeps registry order inside a tier', () => {
    const sorted = sortStepsByTier([
      step({ key: 'opt', tier: 'optional' }),
      step({ key: 'rec-1', tier: 'recommended' }),
      step({ key: 'req', tier: 'required' }),
      step({ key: 'rec-2', tier: 'recommended' }),
    ]);

    // Grouping is CONTIGUITY inside one list, not three lists — see the
    // component header for why the count must not reset per group.
    expect(sorted.map((s) => s.key)).toEqual(['req', 'rec-1', 'rec-2', 'opt']);
  });

  it('labels each row with its tier in words', () => {
    renderChecklist();
    expect(screen.getByText('Required')).toBeInTheDocument();
    expect(screen.getByText('Optional')).toBeInTheDocument();
  });

  it('reports progress as a number beside the bar, not only as a bar', () => {
    renderChecklist({
      state: onboardingState({
        steps: [
          step({ key: 'a', status: 'satisfied' }),
          step({ key: 'b', status: 'pending' }),
        ],
      }),
    });

    expect(screen.getByText('1 of 2 complete')).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'Setup progress' })).toBeInTheDocument();
  });

  it('counts a skipped step as settled, because the user decided it', () => {
    renderChecklist({
      state: onboardingState({
        steps: [
          step({ key: 'a', tier: 'optional', skippable: true, skipped: true }),
          step({ key: 'b', status: 'pending' }),
        ],
      }),
    });

    expect(screen.getByText('1 of 2 complete')).toBeInTheDocument();
  });
});

// =============================================================================
// A blocked step
// =============================================================================

describe('a blocked step', () => {
  const blocked = onboardingState({
    steps: [
      step({
        key: 'user.first_transcript',
        title: 'Record your first conversation',
        actionLabel: 'New transcript',
        status: 'blocked',
        blockedReason: 'Your administrator has not configured transcription yet.',
      }),
    ],
  });

  it('disables its action and associates the reason with it', () => {
    renderChecklist({ state: blocked });

    const action = screen.getByRole('button', { name: 'New transcript' });
    expect(action).toBeDisabled();

    // ⚠ ASSOCIATED, NOT MERELY NEARBY. Without this the button announces as
    // "New transcript, dimmed" and nothing else — at the exact moment the user
    // needs to be told they are waiting on somebody rather than looking at a
    // broken control.
    const reasonId = stepDomId('user.first_transcript', 'reason');
    expect(action).toHaveAttribute('aria-describedby', reasonId);
    expect(document.getElementById(reasonId)).toHaveTextContent(
      'Your administrator has not configured transcription yet.',
    );
  });

  it('derives a selector-safe id from a dotted step key', () => {
    // A dot is legal in an id and is a CLASS selector in `querySelector`, which
    // is how a valid `aria-describedby` ends up untestable.
    expect(stepDomId('admin.db_backup', 'reason')).toBe('onboarding-admin-db-backup-reason');
  });

  it('shows the reason as visible prose, not only as an attribute', () => {
    renderChecklist({ state: blocked });
    expect(
      screen.getByText('Your administrator has not configured transcription yet.'),
    ).toBeVisible();
  });
});

// =============================================================================
// Skipping
// =============================================================================

describe('skipping', () => {
  it('offers a skip only where the server said one is allowed', () => {
    renderChecklist({
      state: onboardingState({
        steps: [
          step({ key: 'req', title: 'Required thing', skippable: false }),
          step({ key: 'opt', title: 'Optional thing', tier: 'optional', skippable: true }),
        ],
      }),
    });

    // One skip button, for the one skippable step. `skippable` is the API's own
    // invariant (never true for `required`) and this trusts it rather than
    // re-deriving it from `tier`, so one place decides.
    expect(screen.getAllByRole('button', { name: 'Skip' })).toHaveLength(1);
  });

  it('offers an undo for a skipped step, which is why #275 still returns it', async () => {
    const onUnskip = vi.fn();
    const user = userEvent.setup();
    renderChecklist({
      state: onboardingState({
        steps: [step({ key: 'opt', tier: 'optional', skippable: true, skipped: true })],
      }),
      onUnskip,
    });

    expect(screen.getByText('Skipped')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Skip' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Undo skip' }));
    expect(onUnskip).toHaveBeenCalledWith('opt');
  });

  it('hands the whole step back to the caller on an action', async () => {
    const onAction = vi.fn();
    const user = userEvent.setup();
    const state = userState();
    renderChecklist({ state, onAction });

    await user.click(screen.getByRole('button', { name: 'New transcript' }));
    // The step, not its href: the page may need to close a dialog or record
    // where the user went, and this component must not have to know that.
    expect(onAction).toHaveBeenCalledWith(state.steps[0]);
  });
});

// =============================================================================
// Degrading to nothing
// =============================================================================

describe('when there is nothing to show', () => {
  it('renders nothing at all for a null state', () => {
    // ⚠ NOT an error banner. This component is mounted inside the app shell's
    // surfaces, and a read that failed must occupy no space rather than put an
    // alert above every page in the application.
    const { container } = renderChecklist({ state: null });
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing for a checklist with no applicable steps', () => {
    const { container } = renderChecklist({ state: onboardingState({ steps: [] }) });
    expect(container).toBeEmptyDOMElement();
  });

  it('says what it is doing while loading, rather than showing bare skeletons', () => {
    renderChecklist({ state: null, isLoading: true });
    expect(screen.getByText('Checking what is left to set up…')).toBeInTheDocument();
  });
});

// =============================================================================
// vitest-axe, one assertion per state
// =============================================================================

describe('accessibility', () => {
  it('is clean while loading', async () => {
    const { container } = renderChecklist({ state: null, isLoading: true });
    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });

  it('is clean with everything satisfied', async () => {
    const { container } = renderChecklist({
      state: onboardingState({
        steps: [
          step({ key: 'a', status: 'satisfied' }),
          step({ key: 'b', tier: 'recommended', status: 'satisfied' }),
        ],
      }),
    });
    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });

  it('is clean with a blocked step', async () => {
    const { container } = renderChecklist({
      state: onboardingState({
        steps: [
          step({
            key: 'a',
            status: 'blocked',
            blockedReason: 'Your administrator has not configured transcription yet.',
          }),
        ],
      }),
    });
    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });

  it('is clean with a skipped step', async () => {
    const { container } = renderChecklist({
      state: onboardingState({
        steps: [step({ key: 'a', tier: 'optional', skippable: true, skipped: true })],
      }),
    });
    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });
});

// =============================================================================
// The five coupled breakpoint gates stay five
// =============================================================================

describe('the breakpoint-gate rule', () => {
  it('uses no useMediaQuery anywhere in the onboarding component or context source', () => {
    // ⚠ CLAUDE.md's Settings UI Pattern rule 5: the coupled breakpoint gates
    // are exactly five and move together or not at all. A `useMediaQuery` in a
    // component two settings surfaces mount would be a sixth — and one nobody
    // remembers to move with the other five. Every responsive decision in this
    // epic is an `sx`/`Grid` breakpoint object resolved in CSS.
    const sources = readdirSync(ONBOARDING_DIR)
      .filter((name) => name.endsWith('.tsx') || name.endsWith('.ts'))
      .map((name) => resolve(ONBOARDING_DIR, name));

    expect(sources.length).toBeGreaterThan(0);

    for (const file of [...sources, CONTEXT_SOURCE]) {
      const code = readFileSync(file, 'utf8')
        // The headers argue about `useMediaQuery` by name to explain why it is
        // absent, so comments are stripped first — otherwise this test could
        // only be satisfied by files that do not explain themselves.
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1');
      expect(code, `${file} must not reach for useMediaQuery`).not.toContain(
        'useMediaQuery',
      );
    }
  });
});
