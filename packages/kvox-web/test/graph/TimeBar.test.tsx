import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';

import type { GraphActivityResponse } from '../../src/graph/headless/clients/graph.js';
import { TimeBar, type TimeBarProps } from '../../src/graph/ui/components/explorer/timebar/TimeBar.js';
import type { TimeRange } from '../../src/graph/ui/components/explorer/timebar/timeAxis.js';
import { render } from './helpers.js';

/**
 * The TimeBar (GIC-15, #676) over a FAKE histogram. jsdom has no layout, so the
 * bar falls back to a 640px-wide plot: the first of the six months in the fake
 * domain spans x 0..106. Geometry belongs to the Playwright specs.
 */

const AXE_OPTIONS = { rules: { 'color-contrast': { enabled: false } } };
const NOW = new Date('2026-06-15T12:00:00Z');

// 15 months of activity, so the axis counts in months and a quarter step is real.
const ACTIVITY: GraphActivityResponse = {
  bucket: 'month',
  series: [
    { start: '2025-01-01', total: 2, byType: { Person: 2 } },
    { start: '2025-06-01', total: 3, byType: { Person: 1, Project: 2 } },
    { start: '2026-02-01', total: 6, byType: { Person: 2, Project: 3, Organization: 1 } },
    { start: '2026-03-01', total: 1, byType: { Project: 1 } },
  ],
  byEntity: {
    joe: [
      { start: '2025-06-01', count: 1 },
      { start: '2026-02-01', count: 2 },
    ],
    copilot: [{ start: '2026-02-01', count: 3 }],
  },
};

function Harness(
  props: Partial<TimeBarProps> & { initial?: TimeRange | null; onRange?: (range: TimeRange | null) => void },
) {
  const { initial = null, onRange, ...rest } = props;
  const [range, setRange] = useState<TimeRange | null>(initial);
  return (
    <div style={{ height: 112 }}>
      <TimeBar
        activity={ACTIVITY}
        bucket="month"
        onBucketChange={() => undefined}
        range={range}
        onRangeChange={(next) => {
          onRange?.(next);
          setRange(next);
        }}
        now={NOW}
        windowClass="expanded"
        inputModality="pointer"
        reducedMotion={false}
        {...rest}
      />
    </div>
  );
}

const plot = () => screen.getByTestId('timebar-plot');

afterEach(() => {
  vi.useRealTimers();
});

describe('TimeBar histogram', () => {
  it('draws a stacked column per bucket with evidence, from the fake histogram', () => {
    render(<Harness />);
    const columns = screen.getAllByTestId('timebar-column');
    expect(columns.map((c) => [c.getAttribute('data-start'), c.getAttribute('data-total')])).toEqual([
      ['2025-01-01', '2'],
      ['2025-06-01', '3'],
      ['2026-02-01', '6'],
      ['2026-03-01', '1'],
    ]);
    // Stacked: one rect per type present in the column.
    expect(columns[2].querySelectorAll('rect')).toHaveLength(3);
    expect(screen.getByRole('img', { name: /12 items in 4 months/ })).toBeInTheDocument();
    expect(screen.getByTestId('timebar-status')).toHaveTextContent('All time');
  });

  it('says so when there is nothing dated, and does not offer Play', () => {
    render(<Harness activity={{ bucket: 'month', series: [], byEntity: {} }} />);
    expect(screen.queryAllByTestId('timebar-column')).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Play' })).toBeDisabled();
    expect(screen.getByTestId('timebar-status')).toHaveTextContent('No dated evidence yet');
  });

  it('overlays the selected nodes as a line and not otherwise', () => {
    const { rerender } = render(<Harness />);
    expect(screen.queryByTestId('timebar-overlay')).not.toBeInTheDocument();
    rerender(<Harness selectedIds={['joe']} />);
    expect(screen.getByTestId('timebar-overlay')).toBeInTheDocument();
    expect(screen.getByTestId('timebar-status')).toHaveTextContent('line: selected');
    // A node with no activity draws no line.
    rerender(<Harness selectedIds={['nobody']} />);
    expect(screen.queryByTestId('timebar-overlay')).not.toBeInTheDocument();
  });

  it('asks for weeks when the visible span is short and stays on months for a long one', () => {
    const onBucketChange = vi.fn();
    render(<Harness onBucketChange={onBucketChange} />);
    expect(onBucketChange).not.toHaveBeenCalled();

    const short: GraphActivityResponse = {
      bucket: 'month',
      series: [{ start: '2026-04-01', total: 1, byType: { Person: 1 } }],
      byEntity: {},
    };
    render(<Harness activity={short} onBucketChange={onBucketChange} />);
    expect(onBucketChange).toHaveBeenCalledWith('week');
  });

  it('zooms the axis with the wheel, around the pointer (here its left edge)', () => {
    const onBucketChange = vi.fn();
    render(<Harness onBucketChange={onBucketChange} />);
    const before = screen.getAllByTestId('timebar-column')[0].querySelector('rect')!.getAttribute('width');
    // jsdom has no layout: give the plot a box so the anchor is the pointer's.
    plot().getBoundingClientRect = () => ({ left: 0, top: 0, right: 640, bottom: 80, width: 640, height: 80, x: 0, y: 0, toJSON: () => ({}) });
    // The wheel listener is native and non-passive; fire a native event.
    act(() => {
      for (let i = 0; i < 6; i += 1) {
        plot().dispatchEvent(new WheelEvent('wheel', { deltaY: -100, clientX: 2, bubbles: true, cancelable: true }));
      }
    });
    const after = screen.getAllByTestId('timebar-column')[0]?.querySelector('rect')?.getAttribute('width');
    expect(Number(after)).toBeGreaterThan(Number(before));
    // Narrow enough to count in weeks.
    expect(onBucketChange).toHaveBeenCalledWith('week');
  });
});

describe('TimeBar brush', () => {
  it('a tap on a bar brushes that one bucket', () => {
    const onRange = vi.fn();
    render(<Harness onRange={onRange} />);
    // The domain starts at Jan 2025; 18 months over 640px is ~35px a month, so x=5 is Jan 2025.
    fireEvent.click(plot(), { clientX: 5 });
    expect(onRange).toHaveBeenLastCalledWith({ from: '2025-01-01', to: '2025-02-01' });
    expect(screen.getByTestId('timebar-brush')).toBeInTheDocument();
    expect(screen.getByTestId('timebar-status')).toHaveTextContent('Jan 2025');
  });

  it('a double-click and the Clear button remove it', () => {
    const onRange = vi.fn();
    render(<Harness initial={{ from: '2026-02-01', to: '2026-04-01' }} onRange={onRange} />);
    expect(screen.getByTestId('timebar-status')).toHaveTextContent('Feb 2026 to Mar 2026');
    fireEvent.click(screen.getByRole('button', { name: 'Clear the range' }));
    expect(onRange).toHaveBeenLastCalledWith(null);
    expect(screen.queryByTestId('timebar-brush')).not.toBeInTheDocument();

    onRange.mockClear();
    render(<Harness initial={{ from: '2026-02-01', to: '2026-04-01' }} onRange={onRange} />);
    fireEvent.doubleClick(screen.getAllByTestId('timebar-plot').at(-1)!);
    expect(onRange).toHaveBeenLastCalledWith(null);
  });

  it('a drag across the bars brushes the buckets it covers', () => {
    const onRange = vi.fn();
    render(<Harness onRange={onRange} />);
    // ~35px a month from Jan 2025: x 5 to x 80 is Jan to Mar 2025.
    fireEvent.pointerDown(plot(), { clientX: 5, pointerId: 1, pointerType: 'mouse', button: 0 });
    fireEvent.pointerMove(plot(), { clientX: 80, pointerId: 1, pointerType: 'mouse' });
    fireEvent.pointerUp(plot(), { clientX: 80, pointerId: 1, pointerType: 'mouse' });
    expect(onRange).toHaveBeenLastCalledWith({ from: '2025-01-01', to: '2025-04-01' });
  });

  it('reports the bucket under the mouse so the canvas can light its nodes', () => {
    const onHoverBucket = vi.fn();
    render(<Harness onHoverBucket={onHoverBucket} />);
    fireEvent.pointerMove(plot(), { clientX: 5, pointerId: 1, pointerType: 'mouse' });
    const last = onHoverBucket.mock.calls.at(-1)![0] as { start: number; end: number };
    expect(new Date(last.start).toISOString().slice(0, 10)).toBe('2025-01-01');
    expect(new Date(last.end).toISOString().slice(0, 10)).toBe('2025-02-01');
    expect(screen.getByTestId('timebar-status')).toHaveTextContent('Jan 2025: 2 items (Person 2)');
    fireEvent.pointerLeave(plot());
    expect(onHoverBucket.mock.calls.at(-1)![0]).toBeNull();
  });
});

describe('TimeBar keyboard', () => {
  const range = { from: '2026-02-01', to: '2026-04-01' };

  it('exposes two handles as sliders with values and text', () => {
    render(<Harness initial={range} />);
    const start = screen.getByRole('slider', { name: 'Range start' });
    const end = screen.getByRole('slider', { name: 'Range end' });
    expect(start).toHaveAttribute('aria-valuetext', 'Range starts Feb 2026');
    expect(end).toHaveAttribute('aria-valuetext', 'Range ends Mar 2026');
    expect(Number(end.getAttribute('aria-valuenow'))).toBe(Number(start.getAttribute('aria-valuenow')) + 2);
    expect(start).toHaveAttribute('tabindex', '0');
  });

  it('arrows move a handle by one bucket and Shift+arrows by a quarter, committing once the keys stop', async () => {
    const onRange = vi.fn();
    render(<Harness initial={range} onRange={onRange} />);
    const end = screen.getByRole('slider', { name: 'Range end' });
    fireEvent.keyDown(end, { key: 'ArrowRight' });
    fireEvent.keyDown(end, { key: 'ArrowRight' });
    // Shown at once, committed after the pause.
    expect(screen.getByRole('slider', { name: 'Range end' })).toHaveAttribute('aria-valuetext', 'Range ends May 2026');
    expect(onRange).not.toHaveBeenCalled();
    await waitFor(() => expect(onRange).toHaveBeenCalledTimes(1));
    expect(onRange).toHaveBeenLastCalledWith({ from: '2026-02-01', to: '2026-06-01' });

    const start = screen.getByRole('slider', { name: 'Range start' });
    fireEvent.keyDown(start, { key: 'ArrowLeft', shiftKey: true });
    await waitFor(() => expect(onRange).toHaveBeenCalledTimes(2));
    expect(onRange).toHaveBeenLastCalledWith({ from: '2025-11-01', to: '2026-06-01' });
  });

  it('never lets the handles cross', async () => {
    const onRange = vi.fn();
    render(<Harness initial={{ from: '2026-02-01', to: '2026-03-01' }} onRange={onRange} />);
    fireEvent.keyDown(screen.getByRole('slider', { name: 'Range end' }), { key: 'ArrowLeft', shiftKey: true });
    await waitFor(() => expect(onRange).toHaveBeenCalled());
    expect(onRange).toHaveBeenLastCalledWith({ from: '2026-02-01', to: '2026-03-01' });
  });

  it('Home and End go to the ends of the axis', async () => {
    const onRange = vi.fn();
    render(<Harness initial={range} onRange={onRange} />);
    fireEvent.keyDown(screen.getByRole('slider', { name: 'Range start' }), { key: 'Home' });
    await waitFor(() => expect(onRange).toHaveBeenCalled());
    expect(onRange).toHaveBeenLastCalledWith({ from: '2025-01-01', to: '2026-04-01' });
  });
});

describe('TimeBar Set range sheet (the accessible alternative)', () => {
  it('sets a range from two dates, widened to whole buckets', async () => {
    const onRange = vi.fn();
    render(<Harness onRange={onRange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Set range' }));
    const dialog = await screen.findByRole('dialog', { name: 'Set the time range' });
    fireEvent.change(within(dialog).getByLabelText('From'), { target: { value: '2026-02-10' } });
    fireEvent.change(within(dialog).getByLabelText('To (included)'), { target: { value: '2026-03-20' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Apply' }));
    expect(onRange).toHaveBeenLastCalledWith({ from: '2026-02-01', to: '2026-04-01' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('refuses a start after the end and clears the range', async () => {
    const onRange = vi.fn();
    render(<Harness initial={{ from: '2026-02-01', to: '2026-04-01' }} onRange={onRange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Set range' }));
    const dialog = await screen.findByRole('dialog', { name: 'Set the time range' });
    expect(within(dialog).getByLabelText('From')).toHaveValue('2026-02-01');
    expect(within(dialog).getByLabelText('To (included)')).toHaveValue('2026-03-31');
    fireEvent.change(within(dialog).getByLabelText('From'), { target: { value: '2026-05-01' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Apply' }));
    expect(within(dialog).getByText('The start date must not be after the end date.')).toBeInTheDocument();
    expect(onRange).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Clear range' }));
    expect(onRange).toHaveBeenLastCalledWith(null);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });
});

describe('TimeBar play', () => {
  it('steps the window forward one bucket every 800ms and stops at the end', () => {
    vi.useFakeTimers();
    const onRange = vi.fn();
    render(<Harness onRange={onRange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Play' }));
    // The first window is the first bucket of the data.
    expect(onRange).toHaveBeenLastCalledWith({ from: '2025-01-01', to: '2025-02-01' });
    expect(screen.getByRole('button', { name: 'Pause' })).toHaveAttribute('aria-pressed', 'true');

    act(() => {
      vi.advanceTimersByTime(799);
    });
    expect(onRange).toHaveBeenCalledTimes(1);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(onRange).toHaveBeenLastCalledWith({ from: '2025-02-01', to: '2025-03-01' });
    act(() => {
      vi.advanceTimersByTime(800);
    });
    expect(onRange).toHaveBeenLastCalledWith({ from: '2025-03-01', to: '2025-04-01' });

    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    const calls = onRange.mock.calls.length;
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(onRange).toHaveBeenCalledTimes(calls);
  });

  it('keeps the width of an existing brush while it slides', () => {
    vi.useFakeTimers();
    const onRange = vi.fn();
    render(<Harness initial={{ from: '2026-01-01', to: '2026-03-01' }} onRange={onRange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Play' }));
    act(() => {
      vi.advanceTimersByTime(800);
    });
    expect(onRange).toHaveBeenLastCalledWith({ from: '2026-02-01', to: '2026-04-01' });
  });

  it('is disabled under prefers-reduced-motion', () => {
    render(<Harness reducedMotion />);
    const play = screen.getByRole('button', { name: 'Play' });
    expect(play).toBeDisabled();
  });
});

describe('TimeBar window classes', () => {
  it('compact: a 28px sparkline strip that expands on tap', () => {
    const onExpand = vi.fn();
    render(<Harness windowClass="compact" inputModality="touch" stripExpanded={false} onStripExpandedChange={onExpand} />);
    expect(screen.queryByTestId('timebar-plot')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Time bar\. Evidence over time.*Tap to expand/ }));
    expect(onExpand).toHaveBeenCalledWith(true);
  });

  it('compact expanded: 44px handles and touch-sized controls', () => {
    render(
      <Harness
        windowClass="compact"
        inputModality="touch"
        stripExpanded
        initial={{ from: '2026-02-01', to: '2026-04-01' }}
      />,
    );
    expect(screen.getByRole('slider', { name: 'Range start' })).toHaveStyle({ width: '44px' });
    expect(screen.getByRole('button', { name: 'Play' })).toHaveStyle({ width: '44px', height: '44px' });
    expect(screen.getByRole('button', { name: 'Set range' })).toBeInTheDocument();
  });

  it('is accessible', async () => {
    const { container } = render(<Harness initial={{ from: '2026-02-01', to: '2026-04-01' }} selectedIds={['joe']} />);
    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });

  it('is accessible as the compact strip', async () => {
    const { container } = render(<Harness windowClass="compact" stripExpanded={false} />);
    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });
});
