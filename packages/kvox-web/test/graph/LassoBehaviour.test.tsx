import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { LassoBehaviour } from '../../src/graph/ui/components/explorer/connect/LassoBehaviour.js';

/**
 * The lasso's event handling, over a fake sigma: the real canvas needs WebGL, so what is proved here is the
 * gesture (which presses start a loop, what it selects, that sigma never sees the press) while
 * `lassoGeometry.test.ts` proves the geometry.
 */

const fake = vi.hoisted(() => ({ container: null as HTMLElement | null }));

vi.mock('@react-sigma/core', () => {
  // ONE object, like sigma's own hook: a fresh one per render would re-run the effect forever.
  const sigma = {
    getContainer: () => fake.container,
    // The fake graph's coordinates ARE viewport pixels.
    graphToViewport: (point: { x: number; y: number }) => point,
    scaleSize: (size: number) => size,
  };
  return { useSigma: () => sigma };
});

const NODES: Record<string, { x: number; y: number; size: number }> = {
  a: { x: 20, y: 20, size: 6 },
  b: { x: 80, y: 20, size: 6 },
  c: { x: 50, y: 80, size: 6 },
  far: { x: 300, y: 300, size: 6 },
};
const graph = {
  hasNode: (id: string) => id in NODES,
  getNodeAttributes: (id: string) => NODES[id]!,
};
const visibleIds = new Set(Object.keys(NODES));

let host: HTMLElement;
let container: HTMLElement;
let sigmaSawPress: Mock<() => void>;
let sigmaSawClick: Mock<() => void>;

beforeEach(() => {
  host = document.createElement('div');
  container = document.createElement('div');
  host.append(container);
  document.body.append(host);
  fake.container = container;
  // What sigma itself would listen to.
  sigmaSawPress = vi.fn<() => void>();
  sigmaSawClick = vi.fn<() => void>();
  container.addEventListener('mousedown', sigmaSawPress);
  container.addEventListener('click', sigmaSawClick);
});

afterEach(() => {
  host.remove();
  fake.container = null;
});

function mount(props: { selectTool?: boolean; onLasso?: (ids: string[]) => void } = {}) {
  const onLasso = props.onLasso ?? vi.fn();
  render(<LassoBehaviour graph={graph} visibleIds={visibleIds} selectTool={props.selectTool ?? false} onLasso={onLasso} />, {
    container,
  });
  return onLasso;
}

/** Press at `from`, drag through `via`, release. */
function drag(from: [number, number], via: Array<[number, number]>, init: MouseEventInit = {}) {
  fireEvent.mouseDown(container, { button: 0, clientX: from[0], clientY: from[1], ...init });
  for (const [x, y] of via) fireEvent.mouseMove(window, { clientX: x, clientY: y });
  fireEvent.mouseUp(window);
}

const AROUND_ABC: Array<[number, number]> = [[110, 0], [110, 110], [0, 110]];

describe('LassoBehaviour', () => {
  it('Shift+drag on the stage selects the nodes inside the loop and keeps sigma from panning', () => {
    const onLasso = mount();
    drag([0, 0], AROUND_ABC, { shiftKey: true });
    expect(onLasso).toHaveBeenCalledTimes(1);
    expect((onLasso as ReturnType<typeof vi.fn>).mock.calls[0][0].sort()).toEqual(['a', 'b', 'c']);
    // Sigma never saw the press, so the camera did not move under the loop.
    expect(sigmaSawPress).not.toHaveBeenCalled();
  });

  it('a plain drag is left to sigma (it pans) unless the Select tool is on', () => {
    const onLasso = mount();
    drag([0, 0], AROUND_ABC);
    expect(onLasso).not.toHaveBeenCalled();
    expect(sigmaSawPress).toHaveBeenCalledTimes(1);
  });

  it('with the Select tool on, a plain drag lassos', () => {
    const onLasso = mount({ selectTool: true });
    drag([0, 0], AROUND_ABC);
    expect(onLasso).toHaveBeenCalledTimes(1);
    expect(sigmaSawPress).not.toHaveBeenCalled();
  });

  it('a Shift press that lands on a node is sigma\'s (shift-click toggles that node)', () => {
    const onLasso = mount();
    fireEvent.mouseDown(container, { button: 0, shiftKey: true, clientX: 21, clientY: 21 });
    fireEvent.mouseUp(window);
    expect(onLasso).not.toHaveBeenCalled();
    expect(sigmaSawPress).toHaveBeenCalledTimes(1);
  });

  it('a click or a tiny wobble selects nothing, and the follow-up click does not reach sigma', () => {
    const onLasso = mount();
    drag([200, 200], [[201, 201]], { shiftKey: true });
    expect(onLasso).not.toHaveBeenCalled();
    fireEvent.click(container);
    // The browser's click after the press would clear the selection; it is swallowed once.
    expect(sigmaSawClick).not.toHaveBeenCalled();
    fireEvent.click(container);
    expect(sigmaSawClick).toHaveBeenCalledTimes(1);
  });

  it('a loop around empty stage selects nothing', () => {
    const onLasso = mount();
    drag([200, 0], [[250, 0], [250, 50], [200, 50]], { shiftKey: true });
    expect(onLasso).not.toHaveBeenCalled();
  });

  it('draws the loop while dragging and removes it afterwards', () => {
    mount();
    fireEvent.mouseDown(container, { button: 0, shiftKey: true, clientX: 0, clientY: 0 });
    fireEvent.mouseMove(window, { clientX: 50, clientY: 0 });
    fireEvent.mouseMove(window, { clientX: 50, clientY: 50 });
    expect(screen.getByTestId('lasso-overlay')).toBeInTheDocument();
    fireEvent.mouseUp(window);
    expect(screen.queryByTestId('lasso-overlay')).not.toBeInTheDocument();
  });

  it('Escape cancels the loop', () => {
    const onLasso = mount();
    fireEvent.mouseDown(container, { button: 0, shiftKey: true, clientX: 0, clientY: 0 });
    fireEvent.mouseMove(window, { clientX: 110, clientY: 0 });
    fireEvent.mouseMove(window, { clientX: 110, clientY: 110 });
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.mouseUp(window);
    expect(onLasso).not.toHaveBeenCalled();
    expect(screen.queryByTestId('lasso-overlay')).not.toBeInTheDocument();
  });

  it('ignores a right or middle button, and does not select hidden nodes', () => {
    const onLasso = vi.fn();
    render(
      <LassoBehaviour graph={graph} visibleIds={new Set(['a'])} selectTool={false} onLasso={onLasso} />,
      { container },
    );
    drag([0, 0], AROUND_ABC, { shiftKey: true, button: 2 });
    expect(onLasso).not.toHaveBeenCalled();
    drag([0, 0], AROUND_ABC, { shiftKey: true });
    expect(onLasso).toHaveBeenCalledWith(['a']);
  });
});
