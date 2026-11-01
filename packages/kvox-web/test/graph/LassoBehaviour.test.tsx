import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import {
  LassoBehaviour,
  type LassoTarget,
} from '../../src/graph/ui/components/explorer/connect/LassoBehaviour.js';

/**
 * The lasso's event handling (GIC-14; renderer-agnostic since #775). The G6 canvas is stood in for by a
 * child element that records the presses it would receive: what is proved here is the gesture (which
 * presses start a loop, what it selects, that the canvas never sees the press) while
 * `lassoGeometry.test.ts` proves the geometry.
 */

const NODES: LassoTarget[] = [
  { id: 'person-a', x: 20, y: 20, radius: 9 },
  { id: 'org-alpha', x: 80, y: 20, radius: 9 },
  { id: 'project-p1', x: 50, y: 80, radius: 9 },
  { id: 'product-x', x: 300, y: 300, radius: 9 },
];

let container: HTMLElement;
let canvas: HTMLElement;
let canvasSawPress: Mock<() => void>;
let canvasSawClick: Mock<() => void>;

beforeEach(() => {
  container = document.createElement('div');
  canvas = document.createElement('canvas');
  container.append(canvas);
  document.body.append(container);
  // What G6 itself would listen to, on its own canvas element.
  canvasSawPress = vi.fn<() => void>();
  canvasSawClick = vi.fn<() => void>();
  canvas.addEventListener('pointerdown', canvasSawPress);
  canvas.addEventListener('click', canvasSawClick);
});

afterEach(() => {
  container.remove();
});

function mount(props: { selectTool?: boolean; onLasso?: (ids: string[]) => void; nodes?: LassoTarget[] } = {}) {
  const onLasso = props.onLasso ?? vi.fn();
  const overlay = document.createElement('div');
  container.append(overlay);
  render(
    <LassoBehaviour
      container={container}
      positions={() => props.nodes ?? NODES}
      selectTool={props.selectTool ?? false}
      onLasso={onLasso}
    />,
    { container: overlay },
  );
  return onLasso;
}

/** Press at `from` on the canvas, drag through `via`, release. */
function drag(from: [number, number], via: Array<[number, number]>, init: PointerEventInit = {}) {
  fireEvent.pointerDown(canvas, { button: 0, pointerType: 'mouse', clientX: from[0], clientY: from[1], ...init });
  for (const [x, y] of via) fireEvent.pointerMove(window, { clientX: x, clientY: y });
  fireEvent.pointerUp(window);
}

const AROUND_THREE: Array<[number, number]> = [[110, 0], [110, 110], [0, 110]];

describe('LassoBehaviour', () => {
  it('Shift+drag on the stage selects the nodes inside the loop and keeps the canvas from panning', () => {
    const onLasso = mount();
    drag([0, 0], AROUND_THREE, { shiftKey: true });
    expect(onLasso).toHaveBeenCalledTimes(1);
    expect((onLasso as ReturnType<typeof vi.fn>).mock.calls[0][0].sort()).toEqual(['org-alpha', 'person-a', 'project-p1']);
    expect(canvasSawPress).not.toHaveBeenCalled();
  });

  it('a plain drag is left to the canvas (it pans) unless the Select tool is on', () => {
    const onLasso = mount();
    drag([0, 0], AROUND_THREE);
    expect(onLasso).not.toHaveBeenCalled();
    expect(canvasSawPress).toHaveBeenCalledTimes(1);
  });

  it('with the Select tool on, a plain drag lassos', () => {
    const onLasso = mount({ selectTool: true });
    drag([0, 0], AROUND_THREE);
    expect(onLasso).toHaveBeenCalledTimes(1);
    expect(canvasSawPress).not.toHaveBeenCalled();
  });

  it("a Shift press that lands on a node is the canvas's (shift-click toggles that node)", () => {
    const onLasso = mount();
    fireEvent.pointerDown(canvas, { button: 0, pointerType: 'mouse', shiftKey: true, clientX: 21, clientY: 21 });
    fireEvent.pointerUp(window);
    expect(onLasso).not.toHaveBeenCalled();
    expect(canvasSawPress).toHaveBeenCalledTimes(1);
  });

  it('a touch press is never a lasso (a finger pans and long-presses)', () => {
    const onLasso = mount({ selectTool: true });
    drag([0, 0], AROUND_THREE, { pointerType: 'touch' });
    expect(onLasso).not.toHaveBeenCalled();
    expect(canvasSawPress).toHaveBeenCalledTimes(1);
  });

  it('a click or a tiny wobble selects nothing, and the follow-up click does not reach the canvas', () => {
    const onLasso = mount();
    drag([200, 200], [[201, 201]], { shiftKey: true });
    expect(onLasso).not.toHaveBeenCalled();
    fireEvent.click(canvas);
    expect(canvasSawClick).not.toHaveBeenCalled();
    fireEvent.click(canvas);
    expect(canvasSawClick).toHaveBeenCalledTimes(1);
  });

  it('a loop around empty stage selects nothing', () => {
    const onLasso = mount();
    drag([200, 0], [[250, 0], [250, 50], [200, 50]], { shiftKey: true });
    expect(onLasso).not.toHaveBeenCalled();
  });

  it('draws the loop while dragging and removes it afterwards', () => {
    mount();
    fireEvent.pointerDown(canvas, { button: 0, pointerType: 'mouse', shiftKey: true, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(window, { clientX: 50, clientY: 0 });
    fireEvent.pointerMove(window, { clientX: 50, clientY: 50 });
    expect(screen.getByTestId('lasso-overlay')).toBeInTheDocument();
    fireEvent.pointerUp(window);
    expect(screen.queryByTestId('lasso-overlay')).not.toBeInTheDocument();
  });

  it('Escape cancels the loop', () => {
    const onLasso = mount();
    fireEvent.pointerDown(canvas, { button: 0, pointerType: 'mouse', shiftKey: true, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(window, { clientX: 110, clientY: 0 });
    fireEvent.pointerMove(window, { clientX: 110, clientY: 110 });
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.pointerUp(window);
    expect(onLasso).not.toHaveBeenCalled();
    expect(screen.queryByTestId('lasso-overlay')).not.toBeInTheDocument();
  });

  it('ignores a right or middle button, and selects only the nodes the canvas reports', () => {
    const onLasso = mount({ nodes: [NODES[0]!] });
    drag([0, 0], AROUND_THREE, { shiftKey: true, button: 2 });
    expect(onLasso).not.toHaveBeenCalled();
    drag([0, 0], AROUND_THREE, { shiftKey: true });
    expect(onLasso).toHaveBeenCalledWith(['person-a']);
  });

  it('does nothing before the canvas element exists', () => {
    const onLasso = vi.fn();
    render(<LassoBehaviour container={null} positions={() => NODES} selectTool onLasso={onLasso} />);
    drag([0, 0], AROUND_THREE, { shiftKey: true });
    expect(onLasso).not.toHaveBeenCalled();
  });
});
