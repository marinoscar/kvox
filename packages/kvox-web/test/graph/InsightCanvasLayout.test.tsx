import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { useEffect, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';

import {
  InsightCanvasLayout,
  useInsightCanvas,
  type InsightCanvasContextValue,
} from '../../src/graph/ui/components/explorer/shell/InsightCanvasLayout.js';
import { PANE_LIMITS, paneStorageKey } from '../../src/graph/ui/components/explorer/shell/paneStorage.js';
import { setViewportWidth } from '../../src/core/testing/index.js';
import { render } from './helpers.js';
import { mockTouchInput } from './shellMedia.js';

/**
 * The Insight Canvas shell (GIC-08, #669): one tree, three window classes.
 * jsdom has no layout, so these tests pin STRUCTURE, ARIA, focus and
 * persistence; the geometry is the Playwright specs' (tests/visual).
 */

const AXE_OPTIONS = { rules: { 'color-contrast': { enabled: false } } };

let mounts = 0;
let lastContext: InsightCanvasContextValue | null = null;

function Canvas() {
  const context = useInsightCanvas();
  lastContext = context;
  useEffect(() => {
    mounts += 1;
  }, []);
  return (
    <div role="application" aria-label="Graph canvas" tabIndex={0}>
      canvas
    </div>
  );
}

function Harness(props: { initialOpen?: boolean; withTimeBar?: boolean; onOpenChange?: (open: boolean) => void }) {
  const [open, setOpen] = useState(props.initialOpen ?? false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        open inspector
      </button>
      <InsightCanvasLayout
        topBar={<h1>Explore</h1>}
        facets={<button type="button">Person</button>}
        canvas={<Canvas />}
        inspector={<h2>Acme Corp</h2>}
        timeBar={props.withTimeBar ? <div>histogram</div> : undefined}
        inspectorOpen={open}
        onInspectorOpenChange={(next) => {
          props.onOpenChange?.(next);
          setOpen(next);
        }}
        facetsActiveCount={2}
      />
    </>
  );
}

function renderLayout(width: number, props: Parameters<typeof Harness>[0] = {}) {
  setViewportWidth(width);
  return render(<Harness {...props} />);
}

afterEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
  mounts = 0;
  lastContext = null;
});

describe('InsightCanvasLayout — expanded (>= 1200)', () => {
  it('shows the facets pane, the canvas and, when open, the inspector pane', () => {
    renderLayout(1440, { initialOpen: true });
    expect(screen.getByRole('region', { name: 'Filters' })).toBeInTheDocument();
    expect(screen.getByRole('application', { name: 'Graph canvas' })).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Inspector' })).getByRole('heading', { name: 'Acme Corp' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Filters' })).not.toBeInTheDocument();
    expect(lastContext?.windowClass).toBe('expanded');
  });

  it('has keyboard-operable separators, in px, within the limits', async () => {
    const user = userEvent.setup();
    renderLayout(1440, { initialOpen: true });
    const facets = screen.getByRole('separator', { name: 'Resize filters' });
    expect(facets).toHaveAttribute('aria-valuenow', '280');
    expect(facets).toHaveAttribute('aria-valuemin', '220');
    expect(facets).toHaveAttribute('aria-valuemax', '400');

    facets.focus();
    await user.keyboard('{ArrowRight}');
    expect(facets).toHaveAttribute('aria-valuenow', '296');
    await user.keyboard('{Shift>}{ArrowRight}{/Shift}');
    expect(facets).toHaveAttribute('aria-valuenow', '344');
    await user.keyboard('{End}');
    expect(facets).toHaveAttribute('aria-valuenow', '400');
    await user.keyboard('{ArrowRight}');
    expect(facets).toHaveAttribute('aria-valuenow', '400');
    await user.keyboard('{Home}');
    expect(facets).toHaveAttribute('aria-valuenow', String(PANE_LIMITS.facets.min));

    // The inspector grows to the LEFT.
    const inspector = screen.getByRole('separator', { name: 'Resize inspector' });
    expect(inspector).toHaveAttribute('aria-valuenow', '360');
    inspector.focus();
    await user.keyboard('{ArrowLeft}');
    expect(inspector).toHaveAttribute('aria-valuenow', '376');
    await user.keyboard('{End}');
    expect(inspector).toHaveAttribute('aria-valuenow', '520');
  });

  it('resizes by dragging', () => {
    renderLayout(1440);
    const separator = screen.getByRole('separator', { name: 'Resize filters' });
    fireEvent.pointerDown(separator, { pointerId: 1, clientX: 300, button: 0 });
    fireEvent.pointerMove(separator, { pointerId: 1, clientX: 340 });
    expect(separator).toHaveAttribute('aria-valuenow', '320');
    fireEvent.pointerMove(separator, { pointerId: 1, clientX: 900 });
    expect(separator).toHaveAttribute('aria-valuenow', '400');
    fireEvent.pointerUp(separator, { pointerId: 1 });
    fireEvent.pointerMove(separator, { pointerId: 1, clientX: 310 });
    expect(separator).toHaveAttribute('aria-valuenow', '400');
  });

  it('persists widths and collapse across a reload, per class', async () => {
    const user = userEvent.setup();
    const first = renderLayout(1440);
    screen.getByRole('separator', { name: 'Resize filters' }).focus();
    await user.keyboard('{ArrowRight}{ArrowRight}');
    await user.click(screen.getByRole('button', { name: 'Hide filters' }));
    expect(screen.queryByRole('region', { name: 'Filters' })).not.toBeInTheDocument();
    first.unmount();

    const stored = JSON.parse(window.localStorage.getItem(paneStorageKey(first.host.viewer()?.userId, 'expanded')) ?? 'null');
    expect(stored).toMatchObject({ facetsWidth: 312, facetsCollapsed: true });

    // "Reload": a fresh mount reads it back.
    render(<Harness />);
    expect(screen.queryByRole('region', { name: 'Filters' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Show filters' }));
    expect(screen.getByRole('separator', { name: 'Resize filters' })).toHaveAttribute('aria-valuenow', '312');
  });

  it('keeps working when storage throws', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const user = userEvent.setup();
    renderLayout(1440);
    const separator = screen.getByRole('separator', { name: 'Resize filters' });
    expect(separator).toHaveAttribute('aria-valuenow', '280');
    separator.focus();
    await user.keyboard('{ArrowRight}');
    expect(separator).toHaveAttribute('aria-valuenow', '296');
  });

  it('shows the time bar below the panes', () => {
    renderLayout(1440, { withTimeBar: true });
    expect(within(screen.getByRole('group', { name: 'Time bar' })).getByText('histogram')).toBeInTheDocument();
  });
});

describe('InsightCanvasLayout — medium (600-1199)', () => {
  it('has a 56px chip rail whose chip opens the facets in a popover', async () => {
    const user = userEvent.setup();
    renderLayout(820);
    expect(lastContext?.windowClass).toBe('medium');
    expect(screen.queryByRole('region', { name: 'Filters' })).not.toBeInTheDocument();
    const chip = screen.getByRole('button', { name: 'Filters' });
    expect(chip).toHaveAttribute('aria-haspopup', 'dialog');
    expect(within(chip).getByText('2')).toBeInTheDocument(); // the active-filter badge

    await user.click(chip);
    const popover = await screen.findByRole('dialog', { name: 'Filters' });
    expect(within(popover).getByRole('button', { name: 'Person' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('collapses the rail to a button and brings it back', async () => {
    const user = userEvent.setup();
    renderLayout(820);
    await user.click(screen.getByRole('button', { name: 'Hide the filter rail' }));
    expect(screen.queryByRole('button', { name: 'Filters' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Show filters' }));
    expect(screen.getByRole('button', { name: 'Filters' })).toBeInTheDocument();
  });

  it('opens the inspector as a closable right overlay that tells the canvas what it covers', async () => {
    const onOpenChange = vi.fn();
    const user = userEvent.setup();
    renderLayout(820, { initialOpen: true, onOpenChange });
    const overlay = screen.getByRole('region', { name: 'Inspector' });
    expect(within(overlay).getByRole('heading', { name: 'Acme Corp' })).toBeInTheDocument();
    expect(lastContext?.canvasInsets).toEqual({ top: 0, right: 360, bottom: 0, left: 0 });

    await user.click(within(overlay).getByRole('button', { name: 'Close inspector' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(screen.queryByRole('region', { name: 'Inspector' })).not.toBeInTheDocument();
    expect(lastContext?.canvasInsets).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
  });

  it('shows a full time bar', () => {
    renderLayout(820, { withTimeBar: true });
    expect(screen.getByRole('group', { name: 'Time bar' })).toBeInTheDocument();
  });
});

describe('InsightCanvasLayout — compact (< 600)', () => {
  it('puts the facets in a left drawer behind a Filters button, and focus moves in and back to the canvas', async () => {
    const user = userEvent.setup();
    renderLayout(390);
    expect(lastContext?.windowClass).toBe('compact');
    expect(screen.queryByRole('region', { name: 'Filters' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Filters' }));
    const drawer = await screen.findByRole('dialog', { name: 'Filters' });
    expect(within(drawer).getByRole('button', { name: 'Person' })).toBeInTheDocument();
    await waitFor(() => expect(drawer.contains(document.activeElement)).toBe(true));

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.getByRole('application', { name: 'Graph canvas' })).toHaveFocus());
  });

  it('opens the inspector as a bottom sheet at peek, takes focus, and returns it to the canvas on Escape', async () => {
    const onOpenChange = vi.fn();
    const user = userEvent.setup();
    renderLayout(390, { onOpenChange });
    await user.click(screen.getByRole('button', { name: 'open inspector' }));

    const sheet = await screen.findByRole('region', { name: 'Inspector' });
    expect(sheet).toHaveAttribute('data-snap', 'peek');
    expect(sheet).toHaveFocus();
    expect(within(sheet).getByRole('heading', { name: 'Acme Corp' })).toBeInTheDocument();

    await user.keyboard('{Escape}');
    expect(onOpenChange).toHaveBeenCalledWith(false);
    await waitFor(() => expect(screen.getByRole('application', { name: 'Graph canvas' })).toHaveFocus());
    expect(screen.queryByRole('region', { name: 'Inspector' })).not.toBeInTheDocument();
  });

  it('reopens at peek every time', async () => {
    const user = userEvent.setup();
    renderLayout(390, { initialOpen: true });
    await user.click(screen.getByRole('button', { name: /Resize Inspector/ }));
    expect(screen.getByRole('region', { name: 'Inspector' })).toHaveAttribute('data-snap', 'half');
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: 'open inspector' }));
    expect(await screen.findByRole('region', { name: 'Inspector' })).toHaveAttribute('data-snap', 'peek');
  });

  it('shows a mini time-strip that expands on tap', async () => {
    const user = userEvent.setup();
    renderLayout(390, { withTimeBar: true });
    const toggle = screen.getByRole('button', { name: 'Expand the time bar' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await user.click(toggle);
    expect(screen.getByRole('button', { name: 'Collapse the time bar' })).toHaveAttribute('aria-expanded', 'true');
  });
});

describe('InsightCanvasLayout — one tree', () => {
  it('never remounts the canvas across window classes (a rotation keeps the camera and the selection)', async () => {
    renderLayout(1440, { initialOpen: true });
    expect(mounts).toBe(1);
    const canvas = screen.getByRole('application', { name: 'Graph canvas' });

    for (const width of [820, 390, 1180, 1440]) {
      act(() => setViewportWidth(width));
      expect(screen.getByRole('application', { name: 'Graph canvas' })).toBe(canvas);
    }
    expect(mounts).toBe(1);
    // The inspector was open throughout, in whichever form the class gives it.
    expect(screen.getByRole('region', { name: 'Inspector' })).toBeInTheDocument();
  });

  it('closes the drawer when the window grows out of compact', async () => {
    const user = userEvent.setup();
    renderLayout(390);
    await user.click(screen.getByRole('button', { name: 'Filters' }));
    await screen.findByRole('dialog', { name: 'Filters' });
    act(() => setViewportWidth(1440));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByRole('region', { name: 'Filters' })).toBeInTheDocument();
  });

  it('reads the input modality independently of the width', () => {
    mockTouchInput();
    renderLayout(1440);
    expect(lastContext?.windowClass).toBe('expanded');
    expect(lastContext?.inputModality).toBe('touch');
    // A touch laptop is as constrained as a phone.
    expect(lastContext?.budgets.visibleNodeCap).toBe(120);
  });

  it('throws a helpful error for a slot used outside the layout', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => render(<Canvas />)).toThrow(/inside <InsightCanvasLayout>/);
    spy.mockRestore();
  });

  it.each([
    ['expanded', 1440],
    ['medium', 820],
    ['compact', 390],
  ])('has no axe violations in the %s class, closed and with the inspector open', async (_name, width) => {
    const { container } = renderLayout(width, { initialOpen: true, withTimeBar: true });
    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });

  it('has no axe violations with the compact drawer open', async () => {
    const user = userEvent.setup();
    renderLayout(390);
    await user.click(screen.getByRole('button', { name: 'Filters' }));
    await screen.findByRole('dialog', { name: 'Filters' });
    expect(await axe(document.body, AXE_OPTIONS)).toHaveNoViolations();
  });
});
