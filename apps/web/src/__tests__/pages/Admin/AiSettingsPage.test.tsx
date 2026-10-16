/**
 * `/admin/settings/ai` (issue #477, epic #472): a THIN binding over the
 * platform's `AiConfigPage`.
 *
 * The packaged page and this app's sections have their own suites; what this
 * file pins is the binding: the page IS the platform's, this app's sections ride
 * in its `Sections` slot at the BOTTOM only (they are content inside one
 * destination, never a tab), and the slots object is a module constant so the
 * platform does not remount the slot on every render.
 */

import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';

import type { PageSectionsSlotProps } from '@marinoscar/platform-web/core';

const captured = vi.hoisted(() => ({ slots: [] as unknown[] }));

// A stand-in for the packaged page that renders its `Sections` slot at both
// ends of the body, as the real one does.
vi.mock('@marinoscar/platform-web/ai/ui', () => ({
  AiConfigPage: ({
    slots,
  }: {
    slots?: { Sections?: (props: PageSectionsSlotProps) => React.ReactNode };
  }) => {
    captured.slots.push(slots);
    return (
      <div>
        <h1>Platform AI Config Page</h1>
        <div data-testid="top">{slots?.Sections?.({ position: 'top' })}</div>
        <p>platform content</p>
        <div data-testid="bottom">{slots?.Sections?.({ position: 'bottom' })}</div>
      </div>
    );
  },
}));

vi.mock('../../../components/admin/AiTasksSettingsSections', () => ({
  AiTasksSettingsSections: () => <section aria-label="kvox sections">kvox sections</section>,
}));

import { render } from '../../utils/test-utils';
import AiSettingsPage from '../../../pages/Admin/AiSettingsPage';

describe('AiSettingsPage', () => {
  it('renders the platform AiConfigPage', () => {
    render(<AiSettingsPage />);

    expect(screen.getByRole('heading', { level: 1, name: 'Platform AI Config Page' })).toBeInTheDocument();
  });

  it('mounts this app’s sections in the Sections slot, at the bottom only', () => {
    render(<AiSettingsPage />);

    expect(screen.getByTestId('bottom')).toHaveTextContent('kvox sections');
    expect(screen.getByTestId('top')).toBeEmptyDOMElement();
    expect(screen.getAllByText('kvox sections')).toHaveLength(1);
  });

  it('hands the platform the same slots object on every render', () => {
    captured.slots.length = 0;
    const { rerender } = render(<AiSettingsPage />);
    rerender(<AiSettingsPage />);

    expect(captured.slots.length).toBeGreaterThanOrEqual(2);
    expect(new Set(captured.slots).size).toBe(1);
  });

  it('has no key field of its own: keys are the platform page’s and the user’s', () => {
    render(<AiSettingsPage />);

    expect(screen.queryByLabelText(/api key/i)).toBeNull();
    expect(screen.queryByPlaceholderText(/sk-/i)).toBeNull();
  });
});
