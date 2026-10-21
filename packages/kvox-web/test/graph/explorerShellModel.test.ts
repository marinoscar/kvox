import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  COARSE_HIT_TARGET_PX,
  COMPACT_BUDGETS,
  COMPACT_NODE_CAP,
  DEFAULT_BUDGETS,
  explorerBudgets,
} from '../../src/graph/ui/components/explorer/shell/explorerBudgets.js';
import {
  capPixelRatio,
  createLongPress,
  LONG_PRESS_MS,
  pickNearestNode,
  revealDelta,
} from '../../src/graph/ui/components/explorer/shell/canvasGestures.js';
import {
  DEFAULT_PANE_STATE,
  PANE_LIMITS,
  clampWidth,
  paneStorageKey,
  readPaneState,
  sanitizePaneState,
  writePaneState,
} from '../../src/graph/ui/components/explorer/shell/paneStorage.js';
import { windowClassForWidth } from '../../src/graph/ui/components/explorer/shell/useWindowClass.js';
import { EXPLORER_NODE_CAP } from '../../src/graph/ui/components/explorer/explorerModel.js';

describe('windowClassForWidth', () => {
  it.each([
    [0, 'compact'],
    [390, 'compact'],
    [599, 'compact'],
    [600, 'medium'],
    [820, 'medium'],
    [1199, 'medium'],
    [1200, 'expanded'],
    [1440, 'expanded'],
  ] as const)('%ipx is %s', (width, expected) => {
    expect(windowClassForWidth(width)).toBe(expected);
  });
});

describe('explorerBudgets', () => {
  it('a compact window gets the phone budgets', () => {
    const budgets = explorerBudgets({ windowClass: 'compact', inputModality: 'pointer' });
    expect(budgets).toBe(COMPACT_BUDGETS);
    expect(budgets.visibleNodeCap).toBe(120);
    expect(budgets.layoutTimeBoxMs).toBe(1500);
    expect(budgets.pixelRatioCap).toBe(2);
    expect(budgets.hideEdgesOnMoveAbove).toBe(500);
    expect(budgets.labelDensity).toBe('reduced');
    expect(budgets.hitTargetPx).toBe(COARSE_HIT_TARGET_PX);
    expect(budgets.listViewDefaultAbove).toBe(COMPACT_NODE_CAP);
  });

  it('a roomy window with a precise pointer gets the defaults, with the existing node cap', () => {
    const budgets = explorerBudgets({ windowClass: 'expanded', inputModality: 'pointer' });
    expect(budgets).toBe(DEFAULT_BUDGETS);
    expect(budgets.visibleNodeCap).toBe(EXPLORER_NODE_CAP);
    expect(budgets.visibleNodeCap).toBe(300);
    expect(budgets.layoutTimeBoxMs).toBe(3000);
    expect(budgets.pixelRatioCap).toBeNull();
    expect(budgets.hideEdgesOnMoveAbove).toBe(1000);
    expect(budgets.labelDensity).toBe('default');
  });

  it('a coarse pointer is constrained whatever the width (a large tablet)', () => {
    for (const windowClass of ['medium', 'expanded'] as const) {
      const budgets = explorerBudgets({ windowClass, inputModality: 'touch' });
      expect(budgets.visibleNodeCap).toBe(120);
      expect(budgets.pixelRatioCap).toBe(2);
      // The list-view default is a phone-window rule: a tablet keeps the graph.
      expect(budgets.listViewDefaultAbove).toBe(Number.POSITIVE_INFINITY);
    }
  });

  it('a narrowed desktop window with a mouse is still the roomy budget', () => {
    expect(explorerBudgets({ windowClass: 'medium', inputModality: 'pointer' })).toBe(DEFAULT_BUDGETS);
  });
});

describe('paneStorage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    window.localStorage.clear();
  });

  it('keys by user and window class', () => {
    expect(paneStorageKey('u1', 'expanded')).toBe('kvox.explorer.panes.v1.u1.expanded');
    expect(paneStorageKey(null, 'medium')).toBe('kvox.explorer.panes.v1.anonymous.medium');
  });

  it('clamps widths and replaces junk with the fallback', () => {
    expect(clampWidth(100, 220, 400, 280)).toBe(220);
    expect(clampWidth(999, 220, 400, 280)).toBe(400);
    expect(clampWidth(301.4, 220, 400, 280)).toBe(301);
    expect(clampWidth('wide', 220, 400, 280)).toBe(280);
    expect(clampWidth(Number.NaN, 220, 400, 280)).toBe(280);
  });

  it('sanitises whatever was stored', () => {
    expect(sanitizePaneState(null)).toEqual(DEFAULT_PANE_STATE);
    expect(sanitizePaneState('x')).toEqual(DEFAULT_PANE_STATE);
    expect(
      sanitizePaneState({ facetsWidth: 9999, inspectorWidth: 10, facetsCollapsed: true, inspectorCollapsed: 'yes' }),
    ).toEqual({
      facetsWidth: PANE_LIMITS.facets.max,
      inspectorWidth: PANE_LIMITS.inspector.min,
      facetsCollapsed: true,
      inspectorCollapsed: false,
    });
  });

  it('round-trips through localStorage', () => {
    const state = { facetsWidth: 333, inspectorWidth: 444, facetsCollapsed: true, inspectorCollapsed: false };
    writePaneState('k', state);
    expect(readPaneState('k')).toEqual(state);
  });

  it('reads the defaults from an empty or corrupt entry', () => {
    expect(readPaneState('missing')).toEqual(DEFAULT_PANE_STATE);
    window.localStorage.setItem('bad', '{not json');
    expect(readPaneState('bad')).toEqual(DEFAULT_PANE_STATE);
  });

  it('survives storage that throws on read and on write', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError');
    });
    expect(readPaneState('k')).toEqual(DEFAULT_PANE_STATE);
    expect(() => writePaneState('k', DEFAULT_PANE_STATE)).not.toThrow();
  });
});

describe('createLongPress', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('fires once after 500ms with the haptic tick', () => {
    vi.useFakeTimers();
    const vibrate = vi.fn();
    vi.stubGlobal('navigator', { vibrate });
    const onLongPress = vi.fn();
    const press = createLongPress({ onLongPress });
    press.start({ x: 10, y: 20 });
    vi.advanceTimersByTime(LONG_PRESS_MS - 1);
    expect(onLongPress).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onLongPress).toHaveBeenCalledTimes(1);
    expect(onLongPress).toHaveBeenCalledWith({ x: 10, y: 20 });
    expect(vibrate).toHaveBeenCalledWith(10);
    expect(press.fired()).toBe(true);
    vi.advanceTimersByTime(2000);
    expect(onLongPress).toHaveBeenCalledTimes(1);
  });

  it('works where there is no vibrate API', () => {
    vi.useFakeTimers();
    vi.stubGlobal('navigator', {});
    const onLongPress = vi.fn();
    createLongPress({ onLongPress }).start({ x: 0, y: 0 });
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(onLongPress).toHaveBeenCalledTimes(1);
  });

  it('is cancelled by lifting, by a wander past the slop, but not by a small tremor', () => {
    vi.useFakeTimers();
    const onLongPress = vi.fn();
    const press = createLongPress({ onLongPress });

    press.start({ x: 0, y: 0 });
    vi.advanceTimersByTime(200);
    press.cancel();
    vi.advanceTimersByTime(1000);
    expect(onLongPress).not.toHaveBeenCalled();
    expect(press.fired()).toBe(false);

    press.start({ x: 0, y: 0 });
    press.move({ x: 40, y: 0 });
    vi.advanceTimersByTime(1000);
    expect(onLongPress).not.toHaveBeenCalled();

    press.start({ x: 0, y: 0 });
    press.move({ x: 4, y: 3 });
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(onLongPress).toHaveBeenCalledTimes(1);
  });

  it('forgets that it fired when the next press starts', () => {
    vi.useFakeTimers();
    const press = createLongPress({ onLongPress: () => undefined });
    press.start({ x: 0, y: 0 });
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(press.fired()).toBe(true);
    press.start({ x: 0, y: 0 });
    expect(press.fired()).toBe(false);
  });
});

describe('pickNearestNode', () => {
  const at: Record<string, { x: number; y: number; size?: number }> = {
    a: { x: 100, y: 100, size: 6 },
    b: { x: 130, y: 100, size: 6 },
    far: { x: 400, y: 400, size: 6 },
    big: { x: 300, y: 300, size: 60 },
  };
  const positions = (id: string) => at[id] ?? null;

  it('hits a node within the enlarged radius, not only its drawn disc', () => {
    // 20px from `a`: outside its 6px disc, inside a 22px target.
    expect(pickNearestNode(['a', 'b', 'far'], positions, { x: 100, y: 120 }, 22)).toBe('a');
    expect(pickNearestNode(['a', 'b', 'far'], positions, { x: 100, y: 120 }, 5)).toBeNull();
  });

  it('prefers the nearer of two candidates', () => {
    expect(pickNearestNode(['a', 'b'], positions, { x: 118, y: 100 }, 22)).toBe('b');
  });

  it('keeps a big node its own larger disc, skips hidden nodes and misses empty space', () => {
    expect(pickNearestNode(['big'], positions, { x: 300, y: 350 }, 22)).toBe('big');
    expect(pickNearestNode(['ghost'], positions, { x: 0, y: 0 }, 22)).toBeNull();
    expect(pickNearestNode(['a'], positions, { x: 250, y: 250 }, 22)).toBeNull();
  });
});

describe('capPixelRatio', () => {
  afterEach(() => vi.unstubAllGlobals());

  function fakeSigma() {
    const sigma = { pixelRatio: 3, pickingDownSizingRatio: 6, resize: vi.fn() };
    return sigma;
  }

  it('caps a 3x display at 2 and restores it', () => {
    vi.stubGlobal('devicePixelRatio', 3);
    const sigma = fakeSigma();
    const restore = capPixelRatio(sigma, 2);
    expect(sigma.pixelRatio).toBe(2);
    expect(sigma.pickingDownSizingRatio).toBe(4);
    // Sigma re-assigns the native ratio on every resize; the cap must hold.
    sigma.pixelRatio = 3;
    expect(sigma.pixelRatio).toBe(2);
    expect(sigma.resize).toHaveBeenCalledWith(true);
    restore();
    expect(sigma.pixelRatio).toBe(3);
    expect(sigma.pickingDownSizingRatio).toBe(6);
  });

  it('leaves a display at or under the cap alone', () => {
    vi.stubGlobal('devicePixelRatio', 2);
    const sigma = fakeSigma();
    sigma.pixelRatio = 2;
    capPixelRatio(sigma, 2)();
    expect(sigma.resize).not.toHaveBeenCalled();
    expect(sigma.pixelRatio).toBe(2);
  });
});

describe('revealDelta', () => {
  const size = { width: 800, height: 600 };
  const none = { top: 0, right: 0, bottom: 0, left: 0 };

  it('is null for a node that is already visible', () => {
    expect(revealDelta({ x: 200, y: 200 }, size, { ...none, right: 360 })).toBeNull();
  });

  it('pans a node hidden under the right overlay into the middle of the free part', () => {
    // The overlay covers x >= 440. A node at x=600 is under it; the free part's middle is x=220.
    const delta = revealDelta({ x: 600, y: 300 }, size, { ...none, right: 360 });
    expect(delta).toEqual({ x: 220 - 600, y: 0 });
  });

  it('pans a node hidden under the bottom sheet up', () => {
    const delta = revealDelta({ x: 400, y: 560 }, size, { ...none, bottom: 200 });
    expect(delta).toEqual({ x: 0, y: 200 - 560 });
  });

  it('gives up when nothing is left to show', () => {
    expect(revealDelta({ x: 10, y: 10 }, size, { ...none, right: 790 })).toBeNull();
  });
});
