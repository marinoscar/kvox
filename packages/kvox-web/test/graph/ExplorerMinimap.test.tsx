import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import {
  ExplorerMinimap,
  MINIMAP_HEIGHT,
  MINIMAP_WIDTH,
} from '../../src/graph/ui/components/explorer/ExplorerMinimap.js';

/**
 * The minimap's frame (GIC-09; G6's `minimap` plugin draws into it since #775). The picture is the
 * plugin's; what is pinned here is the contract with the page and the canvas: a hidden-from-assistive-tech
 * box of the documented size whose element is handed over, and taken back on unmount.
 */
describe('ExplorerMinimap', () => {
  it('renders an aria-hidden frame and hands its element to the canvas', () => {
    const onContainer = vi.fn();
    render(<ExplorerMinimap onContainer={onContainer} />);
    const frame = screen.getByTestId('explorer-minimap');
    expect(frame).toHaveAttribute('aria-hidden', 'true');
    expect(onContainer.mock.calls.some((call) => call[0] === frame)).toBe(true);
  });

  it('takes the element back on unmount, so the canvas drops its minimap', () => {
    const onContainer = vi.fn();
    const { unmount } = render(<ExplorerMinimap onContainer={onContainer} />);
    unmount();
    expect(onContainer.mock.lastCall?.[0]).toBeNull();
  });

  it('keeps the documented size', () => {
    expect(MINIMAP_WIDTH).toBe(168);
    expect(MINIMAP_HEIGHT).toBe(112);
  });
});
