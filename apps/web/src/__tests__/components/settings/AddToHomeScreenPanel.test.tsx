import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { render } from '../../utils/test-utils';
import { AddToHomeScreenPanel } from '../../../components/settings/AddToHomeScreenPanel';

/**
 * Issue #231, epic #215. `AddToHomeScreenPanel` is deliberately dumb — no
 * props, no platform detection, no capability lookup of its own (see the
 * component's file header) — so this is deliberately a thin smoke test, not
 * an attempt to pin every word of the copy.
 */
describe('AddToHomeScreenPanel', () => {
  it('renders without crashing, with the Share-button step, the Add to Home Screen step, and the iOS-only-when-installed explanation', () => {
    render(<AddToHomeScreenPanel />);

    // The Share-button step.
    expect(screen.getByText(/Tap the Share button/i)).toBeInTheDocument();

    // The Add to Home Screen step.
    expect(screen.getByText(/Choose "Add to Home Screen"/i)).toBeInTheDocument();

    // The explanation that iOS/iPadOS permit notifications only for an
    // installed app, never a plain Safari tab.
    expect(
      screen.getByText(/permit web notifications only for an app added to the Home Screen/i),
    ).toBeInTheDocument();
  });
});
