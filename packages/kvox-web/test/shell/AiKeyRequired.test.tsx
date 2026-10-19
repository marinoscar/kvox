/**
 * `AiKeyRequired` (issue #55, epic #45; packaged by #629).
 *
 * The component is trivial to render and its whole value is a promise about
 * CONSISTENCY: every AI surface renders this and nothing else when the viewer has
 * no key, so "one message, one destination" has to be assertable rather than
 * merely intended. The host names the destination, the billing fact is stated at
 * the point of the ask, and the only other input is the provider's name.
 */

import { describe, it, expect } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { ThemeProvider } from '@mui/material/styles';
import { render, screen, within } from '@testing-library/react';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';

import { createKvoxTheme } from '../../src/brand/index.js';
import { AiKeyRequired } from '../../src/shell/index.js';

const PATH = '/settings/ai';

function renderKeyRequired(props: Partial<Parameters<typeof AiKeyRequired>[0]> = {}, mode: 'light' | 'dark' = 'light') {
  return render(
    <ThemeProvider theme={createKvoxTheme(mode)}>
      <MemoryRouter>
        <AiKeyRequired settingsPath={PATH} {...props} />
      </MemoryRouter>
    </ThemeProvider>,
  );
}

const AXE_OPTIONS = { rules: { 'color-contrast': { enabled: false } } };

describe('AiKeyRequired', () => {
  it('renders a single link to the path the host passes and nowhere else', () => {
    const { container } = renderKeyRequired();

    const links = container.querySelectorAll('a[href]');
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute('href', PATH);
    expect(links[0]).toHaveTextContent(/set up your ai key/i);
  });

  it('keeps a hash in the host path (Desktop deep-links a card of its settings hub)', () => {
    const { container } = renderKeyRequired({ settingsPath: '/settings#ai-provider' });
    expect(container.querySelector('a[href]')).toHaveAttribute('href', '/settings#ai-provider');
  });

  it('names the provider when the host knows which one is needed', () => {
    const { container } = renderKeyRequired({ providerName: 'OpenAI' });
    expect(screen.getByRole('heading', { name: 'Add your OpenAI key to use this' })).toBeInTheDocument();
    expect(container.querySelector('a[href]')).toHaveTextContent('Set up your OpenAI key');
  });

  it('states that the key is the user’s own account and their own spend', () => {
    // The reason this component exists rather than four bespoke empty states:
    // "add a key" alone reads like a chore the application is imposing.
    renderKeyRequired();

    const region = screen.getByRole('region', { name: /add your ai key to use this/i });
    expect(within(region).getByText(/your own provider account/i)).toBeInTheDocument();
    expect(
      within(region).getByText(/this application has no ai key of its own/i),
    ).toBeInTheDocument();
  });

  it('is a named landmark, so it is reachable rather than loose text', () => {
    renderKeyRequired();

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
    const { container } = renderKeyRequired();

    expect(container.querySelector('input')).toBeNull();
    expect(container.querySelector('form')).toBeNull();
  });

  describe('accessibility', () => {
    it('passes axe in the light theme', async () => {
      const { container } = renderKeyRequired({}, 'light');

      expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
    });

    it('passes axe in the dark theme', async () => {
      const { container } = renderKeyRequired({}, 'dark');

      expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
    });
  });
});
