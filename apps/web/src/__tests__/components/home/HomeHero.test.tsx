import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';
import { TAGLINE } from '@app/shared';

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

import type React from 'react';

import { render, mockAdminUser, mockUser } from '../../utils/test-utils';
import { HomeHero, firstNameOf, searchPathFor } from '@marinoscar/kvox-web/home/ui';
import type { HomeHeroProps } from '@marinoscar/kvox-web/home/ui';
import { NewTranscriptButton } from '../../../components/home/NewTranscriptButton';
import { AXE_OPTIONS, homeUser } from './homeFixtures';

/**
 * The hero, and the `NewTranscriptButton` it owns.
 *
 * The two are tested together rather than apart because every interesting
 * question about either is about the PAIR: whether a user who cannot transcribe
 * is told why, and whether the person who could fix that is offered the way to.
 */

beforeEach(() => {
  mockNavigate.mockClear();
});

/**
 * The hero as KVox web binds it: the packaged `HomeHero` with the product tagline and
 * the web-only "New transcript" button in its `actions` slot, which is what
 * `pages/HomePage.tsx` does. The pair is what every question below is about.
 */
function WebHero({
  transcriptionAvailable,
  isCheckingTranscription = false,
  ...rest
}: Omit<HomeHeroProps, 'actions' | 'tagline'> & {
  transcriptionAvailable: boolean;
  isCheckingTranscription?: boolean;
}) {
  return (
    <HomeHero
      tagline={TAGLINE}
      {...rest}
      actions={
        <NewTranscriptButton
          available={transcriptionAvailable}
          isChecking={isCheckingTranscription}
        />
      }
    />
  );
}

/** Every bare render here is an ordinary account that CAN record something. */
function renderHero(ui: React.ReactElement, user = homeUser) {
  return render(ui, { wrapperOptions: { user } });
}

describe('firstNameOf', () => {
  it('takes the word before the first space', () => {
    expect(firstNameOf('Ana Ruiz')).toBe('Ana');
  });

  it('returns a single-word name unchanged', () => {
    expect(firstNameOf('Prince')).toBe('Prince');
  });

  it('ignores surrounding whitespace', () => {
    expect(firstNameOf('   Ana   Ruiz  ')).toBe('Ana');
  });

  it('returns null for null', () => {
    expect(firstNameOf(null)).toBeNull();
  });

  it('returns null for undefined', () => {
    expect(firstNameOf(undefined)).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(firstNameOf('')).toBeNull();
  });

  it('returns null for a name that is only whitespace', () => {
    // The dangling-comma case: "Hi, " is worse than "Hi there".
    expect(firstNameOf('   ')).toBeNull();
  });
});

describe('HomeHero', () => {
  it('greets the user by their first name only', () => {
    renderHero(<WebHero displayName="Ana Ruiz" transcriptionAvailable />);

    expect(screen.getByRole('heading', { level: 1, name: 'Hi, Ana' })).toBeInTheDocument();
  });

  it('greets a user with no display name without a dangling comma', () => {
    renderHero(<WebHero displayName={null} transcriptionAvailable />);

    expect(screen.getByRole('heading', { level: 1, name: 'Hi there' })).toBeInTheDocument();
  });

  it('renders the greeting as the page h1', () => {
    renderHero(<WebHero displayName="Ana Ruiz" transcriptionAvailable />);

    expect(screen.getByRole('heading', { name: 'Hi, Ana' }).tagName).toBe('H1');
  });

  // The point of the whole `TAGLINE` export: the assertion reads the shared
  // constant rather than the current wording, so a fork that rewrites its
  // promise keeps this green and a component that hardcodes one goes red.
  it('renders the tagline from the shared identity file', () => {
    renderHero(<WebHero displayName="Ana" transcriptionAvailable />);

    expect(screen.getByText(TAGLINE)).toBeInTheDocument();
  });

  it('does not restate the tagline as a literal anywhere in the component', () => {
    renderHero(<WebHero displayName="Ana" transcriptionAvailable />);

    // Exactly one node carries it — a second would mean a hardcoded copy.
    expect(screen.getAllByText(TAGLINE)).toHaveLength(1);
  });

  it('labels its section with the greeting', () => {
    renderHero(<WebHero displayName="Ana" transcriptionAvailable />);

    expect(screen.getByRole('region', { name: 'Hi, Ana' })).toBeInTheDocument();
  });

  it('no longer says "Welcome back"', () => {
    renderHero(<WebHero displayName="Ana Ruiz" transcriptionAvailable />);

    expect(screen.queryByText(/welcome back/i)).not.toBeInTheDocument();
  });

  it('has no accessibility violations', async () => {
    const { container } = renderHero(<WebHero displayName="Ana" transcriptionAvailable />);

    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });
});

describe('HomeHero — the New transcript button', () => {
  it('offers New transcript when transcription is available', () => {
    renderHero(<WebHero displayName="Ana" transcriptionAvailable />);

    expect(screen.getByRole('button', { name: 'New transcript' })).toBeEnabled();
  });

  it('navigates to the New-transcript flow when pressed', async () => {
    const user = userEvent.setup();
    renderHero(<WebHero displayName="Ana" transcriptionAvailable />);

    await user.click(screen.getByRole('button', { name: 'New transcript' }));

    expect(mockNavigate).toHaveBeenCalledWith('/transcripts/new');
  });

  it('hides the button entirely from a user without transcripts:write', () => {
    // No button rather than a disabled one: `/transcripts/new` is guarded on
    // exactly this permission, so a disabled control would advertise something
    // they will never be able to do.
    renderHero(<WebHero displayName="Ana" transcriptionAvailable />, {
      ...mockUser,
      permissions: ['user_settings:read'],
    });

    expect(screen.queryByRole('button', { name: 'New transcript' })).not.toBeInTheDocument();
  });

  it('disables the button when transcription is not configured', () => {
    renderHero(<WebHero displayName="Ana" transcriptionAvailable={false} />);

    expect(screen.getByRole('button', { name: 'New transcript' })).toBeDisabled();
  });

  it('explains why the button is disabled', () => {
    renderHero(<WebHero displayName="Ana" transcriptionAvailable={false} />);

    expect(screen.getByText(/transcription is not set up for this workspace yet/i))
      .toBeInTheDocument();
  });

  it('ties the explanation to the disabled button with aria-describedby', () => {
    renderHero(<WebHero displayName="Ana" transcriptionAvailable={false} />);

    const button = screen.getByRole('button', { name: 'New transcript' });
    const describedBy = button.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy!)).toHaveTextContent(
      /transcription is not set up/i,
    );
  });

  it('says nothing about availability while the probe is still in flight', () => {
    // A half-second of "not set up yet" before the probe answers is a lie the
    // user has time to read.
    renderHero(
      <WebHero displayName="Ana" transcriptionAvailable={false} isCheckingTranscription />,
    );

    expect(screen.queryByText(/transcription is not set up/i)).not.toBeInTheDocument();
  });

  it('still keeps the button disabled while the probe is in flight', () => {
    renderHero(
      <WebHero displayName="Ana" transcriptionAvailable={false} isCheckingTranscription />,
    );

    expect(screen.getByRole('button', { name: 'New transcript' })).toBeDisabled();
  });

  it('offers a set-up link to a user holding system_settings:read', () => {
    renderHero(<WebHero displayName="Admin" transcriptionAvailable={false} />, mockAdminUser);

    expect(screen.getByRole('button', { name: 'Set up transcription' })).toBeInTheDocument();
  });

  it('sends the set-up link to the transcription settings page', async () => {
    const user = userEvent.setup();
    renderHero(<WebHero displayName="Admin" transcriptionAvailable={false} />, mockAdminUser);

    await user.click(screen.getByRole('button', { name: 'Set up transcription' }));

    expect(mockNavigate).toHaveBeenCalledWith('/admin/settings/transcription');
  });

  it('withholds the set-up link from a user who cannot read system settings', () => {
    // Gated on the permission the transcription settings controller enforces,
    // not on the admin role — offering a link that redirects straight back is
    // worse than not offering it.
    renderHero(<WebHero displayName="Ana" transcriptionAvailable={false} />, homeUser);

    expect(screen.queryByRole('button', { name: 'Set up transcription' })).not.toBeInTheDocument();
  });

  it('shows no set-up link when transcription is working, even for an admin', () => {
    renderHero(<WebHero displayName="Admin" transcriptionAvailable />, mockAdminUser);

    expect(screen.queryByRole('button', { name: 'Set up transcription' })).not.toBeInTheDocument();
  });

  it('has no accessibility violations in the unavailable-for-an-admin state', async () => {
    const { container } = renderHero(
      <WebHero displayName="Admin" transcriptionAvailable={false} />,
      mockAdminUser,
    );

    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });
});

// =============================================================================
// The New note action — issue #173, epic #166
// =============================================================================

describe('HomeHero — the New note button', () => {
  it('offers New note to a caller that may create one', () => {
    renderHero(<WebHero displayName="Ana" transcriptionAvailable canCreateNote />);

    expect(screen.getByRole('button', { name: 'New note' })).toBeEnabled();
  });

  it('navigates to the New-note flow when pressed', async () => {
    // The SAME path `RecentNotes`' zero-state button uses and the same one
    // `App.tsx` registers — the two affordances must never disagree about
    // where "new note" is.
    const user = userEvent.setup();
    renderHero(<WebHero displayName="Ana" transcriptionAvailable canCreateNote />);

    await user.click(screen.getByRole('button', { name: 'New note' }));

    expect(mockNavigate).toHaveBeenCalledWith('/notes/new');
  });

  it('hides it entirely when the caller may not create a note', () => {
    // No button rather than a disabled one, exactly as `NewTranscriptButton`
    // treats a missing `transcripts:write`: `/notes/new` is guarded on
    // `notes:write`, so a disabled control would advertise something the
    // router would bounce them off.
    renderHero(<WebHero displayName="Ana" transcriptionAvailable canCreateNote={false} />);

    expect(screen.queryByRole('button', { name: 'New note' })).not.toBeInTheDocument();
  });

  it('defaults to hiding it when the prop is omitted altogether', () => {
    // Default-DENY. A forgotten prop must cost an action, never manufacture
    // one the API would refuse.
    renderHero(<WebHero displayName="Ana" transcriptionAvailable />);

    expect(screen.queryByRole('button', { name: 'New note' })).not.toBeInTheDocument();
  });

  it('keeps New transcript as the primary action and New note as the secondary', () => {
    // The hero must still have ONE obvious first move; two filled buttons side
    // by side is a hero with none.
    renderHero(<WebHero displayName="Ana" transcriptionAvailable canCreateNote />);

    expect(screen.getByRole('button', { name: 'New transcript' })).toHaveClass(
      'MuiButton-contained',
    );
    expect(screen.getByRole('button', { name: 'New note' })).toHaveClass('MuiButton-outlined');
  });

  it('puts New transcript before New note in the document', () => {
    // Capture is still the front of Capture → Correct → Transform, and on a
    // phone the two are a single stacked column read top to bottom.
    //
    // THE WHOLE HERO'S BUTTON ORDER, not just the pair's: since #172 there is a
    // third control below them, and the reason it is below them is the same
    // reason these two are in this order (see `HomeHero`'s header). Asserting
    // the full list is what makes a future reshuffle of any of the three fail
    // here rather than silently.
    renderHero(<WebHero displayName="Ana" transcriptionAvailable canCreateNote />);

    const buttons = screen
      .getAllByRole('button')
      // The search submit is an icon button, so its NAME is an `aria-label`
      // rather than text — read both, in the order a screen reader would.
      .map((element) => element.getAttribute('aria-label') ?? element.textContent);
    expect(buttons).toEqual(['New transcript', 'New note', 'Search']);
  });

  it('names the two actions distinctly', () => {
    renderHero(<WebHero displayName="Ana" transcriptionAvailable canCreateNote />);

    expect(screen.getByRole('button', { name: 'New transcript' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New note' })).toBeInTheDocument();
  });

  it('still offers New note when transcription is not configured', () => {
    // The two gates are independent: a deployment with no speech-to-text
    // provider can still generate a note from an uploaded document, which is
    // most of the point of putting this action here at all.
    renderHero(<WebHero displayName="Ana" transcriptionAvailable={false} canCreateNote />);

    expect(screen.getByRole('button', { name: 'New note' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'New transcript' })).toBeDisabled();
  });

  it('still offers New note to a user who cannot create a transcript', () => {
    // `NewTranscriptButton` renders nothing at all for them, so New note is
    // the only action left in the hero — and it is a real one.
    renderHero(<WebHero displayName="Ana" transcriptionAvailable canCreateNote />, {
      ...mockUser,
      permissions: ['user_settings:read'],
    });

    expect(screen.queryByRole('button', { name: 'New transcript' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New note' })).toBeEnabled();
  });

  it('has no accessibility violations with both actions present', async () => {
    const { container } = renderHero(
      <WebHero displayName="Ana" transcriptionAvailable canCreateNote />,
    );

    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });

  it('has no accessibility violations with both actions and a disabled transcript button', async () => {
    const { container } = renderHero(
      <WebHero displayName="Admin" transcriptionAvailable={false} canCreateNote />,
      mockAdminUser,
    );

    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });
});

// =============================================================================
// The search entry point — issue #172, epic #166
// =============================================================================

describe('searchPathFor', () => {
  it('builds the library path for an ordinary term', () => {
    expect(searchPathFor('standup')).toBe('/transcripts?q=standup');
  });

  it('trims before building the path', () => {
    expect(searchPathFor('  standup  ')).toBe('/transcripts?q=standup');
  });

  it('returns null for an empty term', () => {
    expect(searchPathFor('')).toBeNull();
  });

  it('returns null for a whitespace-only term', () => {
    // A user who leaned on the space bar is not a query: `?q=%20%20%20` would
    // land them in a library filtered to nothing, with no visible reason why.
    expect(searchPathFor('   ')).toBeNull();
  });

  it('encodes a term containing an ampersand', () => {
    // Unencoded, `&` starts a SECOND query parameter and the search silently
    // becomes "budget ".
    expect(searchPathFor('budget & scope')).toBe('/transcripts?q=budget%20%26%20scope');
  });

  it('encodes a term containing a hash', () => {
    // Unencoded, `#` truncates the term into a fragment the server never sees.
    expect(searchPathFor('sprint #4')).toBe('/transcripts?q=sprint%20%234');
  });

  it('encodes a term containing a space', () => {
    expect(searchPathFor('weekly standup')).toBe('/transcripts?q=weekly%20standup');
  });

  it('encodes a term containing a question mark and a plus', () => {
    expect(searchPathFor('a+b?')).toBe('/transcripts?q=a%2Bb%3F');
  });
});

describe('HomeHero — the search field', () => {
  /** The field, by the accessible name the component gives it. */
  function field() {
    return screen.getByRole('searchbox', { name: 'Search transcripts' });
  }

  it('renders a named search field', () => {
    renderHero(<WebHero displayName="Ana" transcriptionAvailable canCreateNote />);

    expect(field()).toBeInTheDocument();
  });

  it('renders a search landmark around it', () => {
    // A `search` landmark, so the control a returning user most wants is
    // jumpable-to rather than scrolled-to.
    renderHero(<WebHero displayName="Ana" transcriptionAvailable />);

    expect(screen.getByRole('search')).toBeInTheDocument();
  });

  it('names the submit button distinctly from the field', () => {
    // Two identically-named controls would be two indistinguishable entries in
    // a screen reader's forms list.
    renderHero(<WebHero displayName="Ana" transcriptionAvailable />);

    expect(screen.getByRole('button', { name: 'Search' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Search' })).toHaveAttribute('type', 'submit');
  });

  it('navigates to the transcripts library when the term is submitted with Enter', async () => {
    // A REAL form: Enter works because it is a form, not because of an
    // `onKeyDown` handler.
    const user = userEvent.setup();
    renderHero(<WebHero displayName="Ana" transcriptionAvailable />);

    await user.type(field(), 'standup{Enter}');

    expect(mockNavigate).toHaveBeenCalledWith('/transcripts?q=standup');
  });

  it('navigates when the submit button is clicked', async () => {
    const user = userEvent.setup();
    renderHero(<WebHero displayName="Ana" transcriptionAvailable />);

    await user.type(field(), 'standup');
    await user.click(screen.getByRole('button', { name: 'Search' }));

    expect(mockNavigate).toHaveBeenCalledWith('/transcripts?q=standup');
  });

  it('does not navigate when the term is empty', async () => {
    const user = userEvent.setup();
    renderHero(<WebHero displayName="Ana" transcriptionAvailable />);

    await user.click(field());
    await user.keyboard('{Enter}');
    await user.click(screen.getByRole('button', { name: 'Search' }));

    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('does not navigate when the term is only whitespace', async () => {
    const user = userEvent.setup();
    renderHero(<WebHero displayName="Ana" transcriptionAvailable />);

    await user.type(field(), '   {Enter}');
    await user.click(screen.getByRole('button', { name: 'Search' }));

    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('trims the term before navigating', async () => {
    const user = userEvent.setup();
    renderHero(<WebHero displayName="Ana" transcriptionAvailable />);

    await user.type(field(), '  standup  {Enter}');

    expect(mockNavigate).toHaveBeenCalledWith('/transcripts?q=standup');
  });

  it('encodes a term carrying URL-significant characters', async () => {
    // The end-to-end version of the `searchPathFor` cases above: an unencoded
    // `&` or `#` would silently search for a prefix of what was typed.
    const user = userEvent.setup();
    renderHero(<WebHero displayName="Ana" transcriptionAvailable />);

    await user.type(field(), 'budget & scope #4{Enter}');

    expect(mockNavigate).toHaveBeenCalledWith('/transcripts?q=budget%20%26%20scope%20%234');
  });

  it('keeps typing local — nothing is dispatched until submit', async () => {
    // The control's entire contract: it types locally and navigates ONCE. A
    // navigate per keystroke would be the dropdown this component's header
    // rejects, wearing a different bug.
    const user = userEvent.setup();
    renderHero(<WebHero displayName="Ana" transcriptionAvailable />);

    await user.type(field(), 'standup');

    expect(mockNavigate).not.toHaveBeenCalled();
    expect(field()).toHaveValue('standup');
  });

  it('withholds the field from a user without transcripts:read', () => {
    // `/transcripts` is gated on exactly this string, so a field that
    // navigates somewhere the router bounces them off is worse than no field —
    // the same argument `NewTranscriptButton` makes about `transcripts:write`.
    renderHero(<WebHero displayName="Ana" transcriptionAvailable />, {
      ...mockUser,
      permissions: ['user_settings:read'],
    });

    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Search' })).not.toBeInTheDocument();
  });

  it('names the field, the submit button and both actions distinctly', async () => {
    renderHero(<WebHero displayName="Ana" transcriptionAvailable canCreateNote />);

    expect(screen.getByRole('searchbox', { name: 'Search transcripts' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Search' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New transcript' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New note' })).toBeInTheDocument();
  });

  it('has no accessibility violations with the field and both actions present', async () => {
    const { container } = renderHero(
      <WebHero displayName="Ana" transcriptionAvailable canCreateNote />,
    );

    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });

  it('has no accessibility violations once a term has been typed', async () => {
    const user = userEvent.setup();
    const { container } = renderHero(
      <WebHero displayName="Ana" transcriptionAvailable canCreateNote />,
    );

    await user.type(field(), 'standup');

    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });
});

// =============================================================================
// Layout guarantees — issue #563
// =============================================================================

/**
 * jsdom does no layout, so a "the greeting is not one letter per line" test
 * cannot measure anything. What it CAN pin is the CSS the fix relies on: read
 * back from the rules emotion injected for an element's classes, split into the
 * base declarations and the ones inside `@media (min-width:600px)` (the `sm`
 * breakpoint), which `getComputedStyle` cannot see.
 */
interface ElementCss {
  base: Record<string, string>;
  sm: Record<string, string>;
}

function cssOf(element: HTMLElement): ElementCss {
  const classes = Array.from(element.classList);
  const out: ElementCss = { base: {}, sm: {} };

  const collect = (rule: CSSStyleRule, into: Record<string, string>) => {
    const selectors = rule.selectorText.split(',').map((s) => s.trim());
    const matches = selectors.some((selector) =>
      classes.some((cls) => selector === `.${cls}`),
    );
    if (!matches) return;
    for (let i = 0; i < rule.style.length; i += 1) {
      const prop = rule.style[i];
      into[prop] = rule.style.getPropertyValue(prop);
    }
  };

  const sheets = Array.from(document.styleSheets);
  // Base rules first, then media rules, so a later declaration wins as in CSS.
  for (const sheet of sheets) {
    for (const rule of Array.from(sheet.cssRules)) {
      if (rule instanceof CSSStyleRule) collect(rule, out.base);
    }
  }
  // MUI emits the `xs` value inside `@media (min-width:0px)`: that is base too.
  for (const sheet of sheets) {
    for (const rule of Array.from(sheet.cssRules)) {
      if (
        rule instanceof CSSMediaRule &&
        /min-width:\s*0(px)?\)/.test(rule.conditionText ?? rule.media.mediaText)
      ) {
        for (const inner of Array.from(rule.cssRules)) {
          if (inner instanceof CSSStyleRule) collect(inner, out.base);
        }
      }
    }
  }
  for (const sheet of sheets) {
    for (const rule of Array.from(sheet.cssRules)) {
      if (
        rule instanceof CSSMediaRule &&
        /min-width:\s*600px/.test(rule.conditionText ?? rule.media.mediaText)
      ) {
        for (const inner of Array.from(rule.cssRules)) {
          if (inner instanceof CSSStyleRule) collect(inner, out.sm);
        }
      }
    }
  }
  return out;
}

describe('HomeHero — the greeting survives a long blocked-state sentence (#563)', () => {
  function renderBlocked() {
    renderHero(<WebHero displayName="Ana" transcriptionAvailable={false} canCreateNote />);
    const heading = screen.getByRole('heading', { level: 1, name: 'Hi, Ana' });
    const explanation = screen.getByText(/transcription is not set up for this workspace yet/i);
    const greetingColumn = heading.parentElement as HTMLElement;
    // button -> NewTranscriptButton's wrapper -> the actions container.
    const actions = screen.getByRole('button', { name: 'New transcript' }).parentElement!
      .parentElement as HTMLElement;
    return { heading, explanation, greetingColumn, actions };
  }

  it('does not let the h1 break between any two letters', () => {
    const { heading } = renderBlocked();
    const css = cssOf(heading);

    // `anywhere` counts every character as a break opportunity when computing
    // min-content, which is what let the column collapse to one letter wide.
    expect(css.base['overflow-wrap']).toBe('break-word');
    expect(css.base['overflow-wrap']).not.toBe('anywhere');
  });

  it('gives the greeting column a growth factor and a width floor at sm and up', () => {
    const { greetingColumn } = renderBlocked();
    const css = cssOf(greetingColumn);

    expect(css.sm['flex']).toBe('1 1 240px');
    expect(css.sm['min-width']).toBe('240px');
  });

  it('does not put a width floor on the greeting column in the phone layout', () => {
    // In the stacked column `flex-basis` would set a HEIGHT, so the floor is sm+.
    const { greetingColumn } = renderBlocked();
    const css = cssOf(greetingColumn);

    expect(css.base['min-width']).toBe('0px');
    expect(css.base['flex']).toBe('0 0 auto');
  });

  it('lets the hero row wrap at sm and up', () => {
    const { greetingColumn } = renderBlocked();
    const row = greetingColumn.parentElement as HTMLElement;
    const css = cssOf(row);

    expect(css.sm['flex-wrap']).toBe('wrap');
  });

  it('lets the actions wrap at sm and up and caps their width', () => {
    const { actions } = renderBlocked();
    const css = cssOf(actions);

    expect(css.sm['flex-wrap']).toBe('wrap');
    expect(css.sm['max-width']).toBe('min(100%, 480px)');
    expect(css.base['max-width']).toBe('100%');
  });

  it('lets the actions shrink instead of refusing to', () => {
    const { actions } = renderBlocked();
    const css = cssOf(actions);

    expect(css.sm['flex']).toBe('0 1 auto');
  });

  it('bounds the width of the "not set up" explanation', () => {
    const { explanation } = renderBlocked();
    const css = cssOf(explanation);

    expect(css.base['max-width']).toBe('36ch');
    expect(css.base['overflow-wrap']).toBe('break-word');
  });
});
