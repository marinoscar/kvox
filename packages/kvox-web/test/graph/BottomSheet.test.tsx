import { createTheme, ThemeProvider } from '@mui/material/styles';
import { fireEvent, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';

import {
  BottomSheet,
  SHEET_PEEK_MIN_PX,
  resolveSnap,
  snapDown,
  snapHeights,
  snapUp,
  type SheetSnap,
} from '../../src/graph/ui/components/explorer/shell/BottomSheet.js';
import { mockMedia, REDUCED_MOTION } from './shellMedia.js';

describe('snap points', () => {
  it('are 25% (never under 148px), 50% and 92% of the container', () => {
    const tall = snapHeights(800);
    expect(tall.peek).toBe(200);
    expect(tall.half).toBe(400);
    expect(tall.full).toBeCloseTo(736);
    // A short container: the peek keeps room for a title and actions, never above half.
    expect(snapHeights(480).peek).toBe(SHEET_PEEK_MIN_PX);
    expect(snapHeights(200).peek).toBe(100);
  });

  it('step up and down and stop at the ends', () => {
    expect(snapUp('peek')).toBe('half');
    expect(snapUp('half')).toBe('full');
    expect(snapUp('full')).toBe('full');
    expect(snapDown('full')).toBe('half');
    expect(snapDown('peek')).toBe('peek');
  });
});

describe('resolveSnap', () => {
  const containerHeight = 800; // peek 200, half 400, full 736

  it('settles on the nearest snap when released at rest', () => {
    expect(resolveSnap({ height: 230, velocity: 0, containerHeight })).toBe('peek');
    expect(resolveSnap({ height: 330, velocity: 0, containerHeight })).toBe('half');
    expect(resolveSnap({ height: 650, velocity: 0, containerHeight })).toBe('full');
  });

  it('carries a fast fling to the next snap (inertia)', () => {
    // 1.2px/ms up for 200ms = 240px of carry.
    expect(resolveSnap({ height: 220, velocity: 1.2, containerHeight })).toBe('half');
    expect(resolveSnap({ height: 420, velocity: 1.5, containerHeight })).toBe('full');
    expect(resolveSnap({ height: 700, velocity: -1.5, containerHeight })).toBe('half');
  });

  it('closes on a swipe down off the peek, and only then', () => {
    expect(resolveSnap({ height: 150, velocity: -1, containerHeight })).toBe('close');
    expect(resolveSnap({ height: 60, velocity: 0, containerHeight })).toBe('close');
    expect(resolveSnap({ height: 190, velocity: 0, containerHeight })).toBe('peek');
  });
});

function Harness({ initial = 'peek' as SheetSnap, onClose = () => undefined, onSnap = (_: SheetSnap) => undefined }) {
  const [snap, setSnap] = useState<SheetSnap>(initial);
  const [open, setOpen] = useState(true);
  return (
    <ThemeProvider theme={createTheme()}>
      <div style={{ position: 'relative', height: 800 }}>
        <BottomSheet
          open={open}
          snap={snap}
          onSnapChange={(next) => {
            onSnap(next);
            setSnap(next);
          }}
          onClose={() => {
            onClose();
            setOpen(false);
          }}
          label="Inspector"
        >
          <h2>Acme Corp</h2>
          <button type="button">Expand</button>
        </BottomSheet>
      </div>
    </ThemeProvider>
  );
}

describe('BottomSheet', () => {
  afterEach(() => vi.restoreAllMocks());

  it('renders nothing while closed', () => {
    render(
      <ThemeProvider theme={createTheme()}>
        <BottomSheet open={false} snap="peek" onSnapChange={() => undefined} onClose={() => undefined} label="Inspector" />
      </ThemeProvider>,
    );
    expect(screen.queryByRole('region')).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('is a region at peek and half and a dialog only at full', () => {
    render(<Harness initial="peek" />);
    expect(screen.getByRole('region', { name: 'Inspector' })).toHaveAttribute('data-snap', 'peek');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('is a dialog when it opens at full', () => {
    render(<Harness initial="full" />);
    expect(screen.getByRole('dialog', { name: 'Inspector' })).toHaveAttribute('data-snap', 'full');
  });

  it('moves focus into the sheet when it opens', () => {
    render(<Harness />);
    expect(screen.getByRole('region', { name: 'Inspector' })).toHaveFocus();
  });

  it('closes on Escape', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<Harness onClose={onClose} />);
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('region')).not.toBeInTheDocument();
  });

  it('steps through the snaps from the keyboard and becomes a dialog at full', async () => {
    const onSnap = vi.fn();
    const user = userEvent.setup();
    render(<Harness onSnap={onSnap} />);
    const handle = screen.getByRole('button', { name: /Resize Inspector/ });
    expect(handle).toHaveAttribute('aria-expanded', 'false');

    handle.focus();
    await user.keyboard('{ArrowUp}');
    expect(onSnap).toHaveBeenLastCalledWith('half');
    expect(screen.getByRole('region', { name: 'Inspector' })).toHaveAttribute('data-snap', 'half');
    expect(handle).toHaveAttribute('aria-expanded', 'true');

    await user.keyboard('{ArrowUp}');
    expect(screen.getByRole('dialog', { name: 'Inspector' })).toHaveAttribute('data-snap', 'full');

    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('region', { name: 'Inspector' })).toHaveAttribute('data-snap', 'half');

    await user.keyboard('{End}');
    expect(screen.getByRole('dialog', { name: 'Inspector' })).toBeInTheDocument();
    await user.keyboard('{Home}');
    expect(screen.getByRole('region', { name: 'Inspector' })).toHaveAttribute('data-snap', 'peek');

    await user.keyboard('{Enter}');
    expect(onSnap).toHaveBeenLastCalledWith('half');
  });

  it('a tap on the handle or on the peek itself goes up one snap; a tap on a control does not', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const sheet = screen.getByRole('region', { name: 'Inspector' });

    await user.click(screen.getByRole('button', { name: 'Expand' }));
    expect(sheet).toHaveAttribute('data-snap', 'peek');

    await user.click(screen.getByRole('heading', { name: 'Acme Corp' }));
    expect(sheet).toHaveAttribute('data-snap', 'half');
  });

  describe('dragging the handle', () => {
    function mockGeometry() {
      Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 800 });
      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
        height: 200,
        width: 390,
        top: 600,
        left: 0,
        right: 390,
        bottom: 800,
        x: 0,
        y: 600,
        toJSON: () => ({}),
      });
    }

    afterEach(() => {
      delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientHeight;
    });

    it('a fast drag up from peek lands on full', () => {
      mockGeometry();
      const onSnap = vi.fn();
      render(<Harness onSnap={onSnap} />);
      const handle = screen.getByRole('button', { name: /Resize Inspector/ });
      fireEvent.pointerDown(handle, { pointerId: 1, clientY: 700, button: 0 });
      fireEvent.pointerMove(handle, { pointerId: 1, clientY: 500 });
      fireEvent.pointerMove(handle, { pointerId: 1, clientY: 200 });
      fireEvent.pointerUp(handle, { pointerId: 1, clientY: 200 });
      expect(onSnap).toHaveBeenLastCalledWith('full');
      expect(screen.getByRole('dialog', { name: 'Inspector' })).toBeInTheDocument();
    });

    it('a drag down off the peek closes the sheet', () => {
      mockGeometry();
      const onClose = vi.fn();
      render(<Harness onClose={onClose} />);
      const handle = screen.getByRole('button', { name: /Resize Inspector/ });
      fireEvent.pointerDown(handle, { pointerId: 1, clientY: 700, button: 0 });
      fireEvent.pointerMove(handle, { pointerId: 1, clientY: 760 });
      fireEvent.pointerMove(handle, { pointerId: 1, clientY: 800 });
      fireEvent.pointerUp(handle, { pointerId: 1, clientY: 800 });
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('a cancelled gesture changes nothing', () => {
      mockGeometry();
      const onSnap = vi.fn();
      const onClose = vi.fn();
      render(<Harness onSnap={onSnap} onClose={onClose} />);
      const handle = screen.getByRole('button', { name: /Resize Inspector/ });
      fireEvent.pointerDown(handle, { pointerId: 1, clientY: 700, button: 0 });
      fireEvent.pointerMove(handle, { pointerId: 1, clientY: 300 });
      fireEvent.pointerCancel(handle, { pointerId: 1 });
      expect(onSnap).not.toHaveBeenCalled();
      expect(onClose).not.toHaveBeenCalled();
      expect(screen.getByRole('region', { name: 'Inspector' })).toHaveAttribute('data-snap', 'peek');
    });
  });

  it('has no spring animation under prefers-reduced-motion', () => {
    mockMedia({ [REDUCED_MOTION]: true });
    render(<Harness />);
    expect(getComputedStyle(screen.getByRole('region', { name: 'Inspector' })).transition).toMatch(/^none/);
  });

  it('animates the height otherwise', () => {
    render(<Harness />);
    expect(getComputedStyle(screen.getByRole('region', { name: 'Inspector' })).transition).toMatch(/height 240ms/);
  });

  it('has no axe violations at peek and at full', async () => {
    const user = userEvent.setup();
    const { container } = render(<Harness />);
    const options = { rules: { 'color-contrast': { enabled: false } } };
    expect(await axe(container, options)).toHaveNoViolations();
    await user.click(screen.getByRole('button', { name: /Resize Inspector/ }));
    await user.click(screen.getByRole('button', { name: /Resize Inspector/ }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(await axe(container, options)).toHaveNoViolations();
  });
});
