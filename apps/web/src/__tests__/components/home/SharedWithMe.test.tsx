import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

import { render } from '../../utils/test-utils';
import { SharedWithMe } from '../../../components/home/SharedWithMe';
import { AXE_OPTIONS, transcript } from './homeFixtures';

/**
 * The shared list. The question this section exists to answer that "Recent"
 * does not is "what am I allowed to do with it" — so most of what is asserted
 * here is the role chip.
 */

const SHARED = [
  { ...transcript({ id: 's1', title: 'Design review', access: 'viewer' }), ownerName: 'Ana Ruiz' },
  { ...transcript({ id: 's2', title: 'Roadmap sync', access: 'editor' }), ownerName: 'Ben Olsen' },
];

beforeEach(() => {
  mockNavigate.mockClear();
});

describe('SharedWithMe', () => {
  it('renders nothing when nobody has shared anything', () => {
    // Most accounts in most deployments are never shared anything at all; a
    // permanent empty block would be dead space on the majority of home pages.
    const { container } = render(<SharedWithMe items={[]} />);

    expect(container).toBeEmptyDOMElement();
  });

  it('heads the section "Shared with me"', () => {
    render(<SharedWithMe items={SHARED} />);

    expect(screen.getByRole('heading', { name: 'Shared with me' })).toBeInTheDocument();
  });

  it('labels the section region for a screen reader', () => {
    render(<SharedWithMe items={SHARED} />);

    expect(screen.getByRole('region', { name: 'Shared with me' })).toBeInTheDocument();
  });

  it('renders one row per share', () => {
    render(<SharedWithMe items={SHARED} />);

    expect(within(screen.getByRole('list')).getAllByRole('listitem')).toHaveLength(2);
  });

  it('names who shared each one', () => {
    render(<SharedWithMe items={SHARED} />);

    expect(screen.getByText('Shared by Ana Ruiz')).toBeInTheDocument();
    expect(screen.getByText('Shared by Ben Olsen')).toBeInTheDocument();
  });

  it('chips a read-only share as Viewer', () => {
    render(<SharedWithMe items={SHARED} />);

    expect(screen.getByText('Viewer')).toBeInTheDocument();
  });

  it('chips an editable share as Editor', () => {
    // The one fact about a shared row that is NOT true of the user's own, and
    // the alternative to learning it by finding the editor disabled.
    render(<SharedWithMe items={SHARED} />);

    expect(screen.getByText('Editor')).toBeInTheDocument();
  });

  it('still shows the title and metadata line', () => {
    render(<SharedWithMe items={SHARED} />);

    expect(screen.getByRole('heading', { name: 'Design review' })).toBeInTheDocument();
    expect(screen.getAllByText(/ago · 15 min · 3 speakers/)).toHaveLength(2);
  });

  it('falls back to "Shared with you" when the API sends no owner name', () => {
    render(<SharedWithMe items={[transcript({ id: 's3', access: 'viewer' })]} />);

    expect(screen.getByText('Shared with you')).toBeInTheDocument();
  });

  it('opens a shared transcript when tapped', async () => {
    const user = userEvent.setup();
    render(<SharedWithMe items={SHARED} />);

    await user.click(screen.getByRole('heading', { name: 'Roadmap sync' }));

    expect(mockNavigate).toHaveBeenCalledWith('/transcripts/s2');
  });

  it('renders up to eight without complaint', () => {
    const eight = Array.from({ length: 8 }, (_, index) => ({
      ...transcript({ id: `s${index}`, title: `Share ${index}`, access: 'viewer' }),
      ownerName: `Owner ${index}`,
    }));
    render(<SharedWithMe items={eight} />);

    expect(within(screen.getByRole('list')).getAllByRole('listitem')).toHaveLength(8);
  });

  it('has no accessibility violations', async () => {
    const { container } = render(<SharedWithMe items={SHARED} />);

    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });
});
