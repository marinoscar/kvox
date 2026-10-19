/**
 * `renderKvoxRoutes` (issue #629): the permission gate and the redirect.
 */

import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { LocalIdentityProvider } from '@marinoscar/platform-web/identity/headless';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { KvoxRouteDef } from '../../src/core/ui/index.js';
import { renderKvoxRoutes } from '../../src/shell/index.js';

const ROUTES: readonly KvoxRouteDef[] = [
  { path: '/open', Component: () => <p>open page</p> },
  { path: '/notes', permission: 'notes:read', Component: () => <p>notes page</p> },
  {
    path: '/transcripts/new',
    permission: 'transcripts:write',
    redirectTo: '/transcripts',
    Component: () => <p>new transcript page</p>,
  },
];

function renderAt(path: string, permissions: string[], fallback?: string, extra: ReactNode = null) {
  return render(
    <LocalIdentityProvider userId="local" permissions={permissions}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          {renderKvoxRoutes(ROUTES, fallback === undefined ? undefined : { fallback })}
          <Route path="/" element={<p>home page</p>} />
          <Route path="/transcripts" element={<p>transcripts list</p>} />
          <Route path="/elsewhere" element={<p>elsewhere page</p>} />
        </Routes>
        {extra}
      </MemoryRouter>
    </LocalIdentityProvider>,
  );
}

describe('renderKvoxRoutes', () => {
  it('renders one keyed route per entry, in order', () => {
    const elements = renderKvoxRoutes(ROUTES);
    expect(elements.map((element) => element.key)).toEqual(['/open', '/notes', '/transcripts/new']);
  });

  it('renders an ungated route for anyone', () => {
    renderAt('/open', []);
    expect(screen.getByText('open page')).toBeInTheDocument();
  });

  it('renders a gated route for a viewer who holds the permission', () => {
    renderAt('/notes', ['notes:read']);
    expect(screen.getByText('notes page')).toBeInTheDocument();
  });

  it('sends a viewer without the permission home', () => {
    renderAt('/notes', ['transcripts:read']);
    expect(screen.queryByText('notes page')).not.toBeInTheDocument();
    expect(screen.getByText('home page')).toBeInTheDocument();
  });

  it('sends a viewer without the permission to the route redirectTo when it names one', () => {
    renderAt('/transcripts/new', ['transcripts:read']);
    expect(screen.queryByText('new transcript page')).not.toBeInTheDocument();
    expect(screen.getByText('transcripts list')).toBeInTheDocument();
  });

  it('sends a viewer without the permission to the host fallback when given', () => {
    renderAt('/notes', [], '/elsewhere');
    expect(screen.getByText('elsewhere page')).toBeInTheDocument();
  });
});
