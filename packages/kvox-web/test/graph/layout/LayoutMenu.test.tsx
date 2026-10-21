import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { LayoutMenu } from '../../../src/graph/ui/components/explorer/LayoutMenu.js';

function setup(overrides: Partial<Parameters<typeof LayoutMenu>[0]> = {}) {
  const props = {
    layout: 'forceatlas' as const,
    onLayoutChange: vi.fn(),
    onRelayoutAll: vi.fn(),
    pinnedCount: 0,
    onUnpinAll: vi.fn(),
    ...overrides,
  };
  render(<LayoutMenu {...props} />);
  fireEvent.click(screen.getByRole('button', { name: 'Layout' }));
  return props;
}

describe('LayoutMenu', () => {
  it('offers Force, Concentric by hop and Static and marks the one in force', () => {
    setup();
    const items = screen.getAllByRole('menuitemradio');
    expect(items.map((item) => item.textContent)).toEqual([
      expect.stringContaining('Force'),
      expect.stringContaining('Concentric by hop'),
      expect.stringContaining('Static'),
    ]);
    expect(items[0]).toHaveAttribute('aria-checked', 'true');
    expect(items[1]).toHaveAttribute('aria-checked', 'false');
  });

  it('reports a chosen layout, but not the one already in force', () => {
    const props = setup();
    fireEvent.click(screen.getByRole('menuitemradio', { name: /Force/ }));
    expect(props.onLayoutChange).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Layout' }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: /Concentric by hop/ }));
    expect(props.onLayoutChange).toHaveBeenCalledWith('concentric');
  });

  it('re-lays out everything and unpins', () => {
    const props = setup({ pinnedCount: 2 });
    fireEvent.click(screen.getByRole('menuitem', { name: /Re-layout all/ }));
    expect(props.onRelayoutAll).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Layout' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Unpin all \(2\)/ }));
    expect(props.onUnpinAll).toHaveBeenCalledTimes(1);
  });

  it('disables Unpin all with no pins and Re-layout all for the static layout', () => {
    setup({ layout: 'static' });
    expect(screen.getByRole('menuitem', { name: /Unpin all/ })).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('menuitem', { name: /Re-layout all/ })).toHaveAttribute('aria-disabled', 'true');
  });
});
