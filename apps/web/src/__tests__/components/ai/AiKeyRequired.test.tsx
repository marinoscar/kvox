/**
 * `AiKeyRequired` (issue #55, epic #45).
 *
 * The component is trivial to render and its whole value is a promise about
 * CONSISTENCY: issues #56, #57, #58 and #59 each render this and nothing else
 * when `keyConfigured` is false, so "one message, one destination" has to be
 * assertable rather than merely intended. That is what this suite checks —
 * the destination is `/settings/ai` and only `/settings/ai`, the billing fact
 * is stated at the point of the ask, and the component takes no props through
 * which a caller could make its copy differ from a sibling's.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';

import { render } from '../../utils/test-utils';
import { AiKeyRequired, AI_KEY_SETTINGS_PATH } from '../../../components/ai/AiKeyRequired';

const AXE_OPTIONS = { rules: { 'color-contrast': { enabled: false } } };

describe('AiKeyRequired', () => {
  afterEach(() => {
    localStorage.clear();
  });

  it('names the one destination as /settings/ai', () => {
    // The constant is exported so the four consuming surfaces can link to it
    // without each hard-coding a string that could drift.
    expect(AI_KEY_SETTINGS_PATH).toBe('/settings/ai');
  });

  it('renders a single link to /settings/ai and nowhere else', () => {
    const { container } = render(<AiKeyRequired />);

    const links = container.querySelectorAll('a[href]');
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute('href', '/settings/ai');
    expect(links[0]).toHaveTextContent(/set up your ai key/i);
  });

  it('states that the key is the user’s own account and their own spend', () => {
    // The reason this component exists rather than four bespoke empty states:
    // "add a key" alone reads like a chore the application is imposing.
    render(<AiKeyRequired />);

    const region = screen.getByRole('region', { name: /add your ai key to use this/i });
    expect(within(region).getByText(/your own provider account/i)).toBeInTheDocument();
    expect(
      within(region).getByText(/this application has no ai key of its own/i),
    ).toBeInTheDocument();
  });

  it('is a named landmark, so it is reachable rather than loose text', () => {
    render(<AiKeyRequired />);

    expect(
      screen.getByRole('region', { name: /add your ai key to use this/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: /add your ai key to use this/i }),
    ).toBeInTheDocument();
  });

  it('renders nothing that could hold or ask for a key', () => {
    // It is a signpost, not a second place to paste a secret. A key field here
    // would be a fifth copy of the form `/settings/ai` already owns.
    const { container } = render(<AiKeyRequired />);

    expect(container.querySelector('input')).toBeNull();
    expect(container.querySelector('form')).toBeNull();
  });

  describe('accessibility', () => {
    beforeEach(() => {
      localStorage.clear();
    });

    it('passes axe in the light theme', async () => {
      localStorage.setItem('theme_mode', 'light');
      const { container } = render(<AiKeyRequired />);

      expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
    });

    it('passes axe in the dark theme', async () => {
      localStorage.setItem('theme_mode', 'dark');
      const { container } = render(<AiKeyRequired />);

      expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
    });
  });
});
