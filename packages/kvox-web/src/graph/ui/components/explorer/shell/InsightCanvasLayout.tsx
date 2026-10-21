/**
 * `InsightCanvasLayout` — the responsive shell every Insight Canvas panel
 * renders into (GIC-08, #669; epic #661). One component tree that adapts by
 * window class and input modality, never by platform sniffing.
 *
 * Slots: `topBar`, `facets`, `canvas`, `inspector`, `timeBar`.
 *
 * | Region    | Compact, under 600           | Medium 600-1199                  | Expanded, 1200 and up              |
 * |-----------|------------------------------|----------------------------------|------------------------------------|
 * | Canvas    | full-bleed                   | full width                       | centre pane                        |
 * | Facets    | left drawer behind a FAB     | 56px chip rail, chip = popover   | left pane 280px (220-400), collapse|
 * | Inspector | bottom sheet (peek/half/full)| right overlay 360px, closable    | right pane 360px (300-520), collapse|
 * | TimeBar   | 28px strip above the sheet   | 96px bar                         | 112px bar                          |
 *
 * It lives INSIDE the page `<main>` and reads no app chrome: the five
 * platform breakpoint gates are untouched.
 *
 * THE CANVAS NEVER REMOUNTS. The slots sit at fixed positions in the tree
 * whatever the class, so a rotation or a resize across a class boundary keeps
 * sigma, its camera and the page's selection exactly as they were.
 *
 * What the slots can read: {@link useInsightCanvas} gives the window class, the
 * input modality, the performance budgets and the `canvasInsets` (the part of
 * the canvas the inspector covers, so the canvas can keep the selection in the
 * visible rest). `canvas` may be a function of the same value.
 *
 * Focus: opening the bottom sheet or the filter drawer moves focus into it;
 * closing either (Escape, swipe down, or the page clearing the selection)
 * returns it to the canvas.
 */

import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import CloseIcon from '@mui/icons-material/Close';
import FilterListIcon from '@mui/icons-material/FilterList';
import UnfoldMoreIcon from '@mui/icons-material/UnfoldMore';
import Badge from '@mui/material/Badge';
import Box from '@mui/material/Box';
import Drawer from '@mui/material/Drawer';
import Fab from '@mui/material/Fab';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import type { SxProps, Theme } from '@mui/material/styles';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';

import { useKvoxHost } from '../../../../../core/headless/index.js';
import { BottomSheet, type SheetSnap } from './BottomSheet.js';
import { FacetsRail } from './FacetsRail.js';
import { PaneResizer } from './PaneResizer.js';
import { explorerBudgets, type ExplorerBudgets } from './explorerBudgets.js';
import {
  PANE_LIMITS,
  paneStorageKey,
  readPaneState,
  writePaneState,
  type PaneState,
} from './paneStorage.js';
import { useInputModality, type InputModality } from './useInputModality.js';
import { useReducedMotion } from './useReducedMotion.js';
import { useWindowClass, type WindowClass } from './useWindowClass.js';

/** Width in px of the medium window's inspector overlay. */
export const INSPECTOR_OVERLAY_WIDTH = 360;
/** TimeBar heights in px: compact strip, compact expanded, medium, expanded. */
export const TIME_BAR_HEIGHT = { strip: 28, stripExpanded: 120, medium: 96, expanded: 112 } as const;
/** Width of a collapsed pane's expand rail in px. */
const COLLAPSED_RAIL_PX = 40;

/**
 * The part of the canvas something else covers, in px.
 *
 * @stability experimental
 */
export interface CanvasInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

const NO_INSETS: CanvasInsets = { top: 0, right: 0, bottom: 0, left: 0 };

/**
 * What the shell tells its slots.
 *
 * @stability experimental
 */
export interface InsightCanvasContextValue {
  windowClass: WindowClass;
  inputModality: InputModality;
  budgets: ExplorerBudgets;
  /** The part of the canvas the open inspector covers (zeros while the inspector is a pane). */
  canvasInsets: CanvasInsets;
  /** The sheet's snap point on a compact window. */
  sheetSnap: SheetSnap;
  /** Moves focus to the canvas. */
  focusCanvas: () => void;
}

const InsightCanvasContext = createContext<InsightCanvasContextValue | null>(null);

/**
 * The shell's state, for a component rendered inside a slot.
 *
 * @stability experimental
 */
export function useInsightCanvas(): InsightCanvasContextValue {
  const value = useContext(InsightCanvasContext);
  if (!value) throw new Error('useInsightCanvas must be used inside <InsightCanvasLayout>.');
  return value;
}

/**
 * Props of {@link InsightCanvasLayout}.
 *
 * @stability experimental
 */
export interface InsightCanvasLayoutProps {
  /** The bar above everything: title, search, view controls. */
  topBar?: ReactNode;
  /** The facets: filters, legend, insights. A drawer, a popover or a pane by class. */
  facets?: ReactNode;
  /** The drawing surface, or a function of the shell's state. It is never remounted by a class change. */
  canvas: ReactNode | ((context: InsightCanvasContextValue) => ReactNode);
  /** The inspector content. Shown while `inspectorOpen`. */
  inspector?: ReactNode;
  /** The time bar (GIC-15). Omitted: no bar and no strip. */
  timeBar?: ReactNode;
  /** Whether the inspector is open. */
  inspectorOpen: boolean;
  /** Called when the user closes the inspector (Escape, swipe down off the peek). */
  onInspectorOpenChange: (open: boolean) => void;
  /** Accessible name of the inspector region. Default "Inspector". */
  inspectorLabel?: string;
  /** Accessible name of the facets. Default "Filters". */
  facetsLabel?: string;
  /** How many facets narrow the graph; badges the chip and the FAB. */
  facetsActiveCount?: number;
  /** Fixed height of the whole layout. `false`: the layout is as tall as its content (the list view). Default `true`. */
  fillHeight?: boolean;
  /** Overrides the detected window class (tests, previews). */
  windowClass?: WindowClass;
  /** Overrides the detected input modality (tests, previews). */
  inputModality?: InputModality;
  /** Styles of the root. */
  sx?: SxProps<Theme>;
}

/** The root's height when it fills the window: what is left under the app bar, the page title and the bottom bar. */
const FILL_HEIGHT = {
  compact: 'max(480px, calc(100dvh - 176px))',
  medium: 'max(520px, calc(100dvh - 148px))',
  expanded: 'max(560px, calc(100dvh - 148px))',
} as const;

/**
 * The pane state of one window class, persisted per user. A class change reads that class's saved state.
 */
function usePaneState(windowClass: WindowClass): [PaneState, (patch: Partial<PaneState>) => void] {
  const host = useKvoxHost();
  const key = paneStorageKey(host.viewer()?.userId, windowClass);
  const [store, setStore] = useState(() => ({ key, value: readPaneState(key) }));
  let current = store;
  if (store.key !== key) {
    // Adjusting state while rendering, from the key: the class changed.
    current = { key, value: readPaneState(key) };
    setStore(current);
  }
  const update = useCallback(
    (patch: Partial<PaneState>) => {
      setStore((previous) => {
        const value = { ...previous.value, ...patch };
        writePaneState(previous.key, value);
        return { key: previous.key, value };
      });
    },
    [],
  );
  return [current.value, update];
}

/**
 * The slot-based, responsive Insight Canvas layout: compact (bottom sheet and filter drawer), medium (chip rail and overlay) and expanded (three resizable panes).
 *
 * @stability experimental
 */
export function InsightCanvasLayout(props: InsightCanvasLayoutProps) {
  const {
    topBar,
    facets,
    canvas,
    inspector,
    timeBar,
    inspectorOpen,
    onInspectorOpenChange,
    inspectorLabel = 'Inspector',
    facetsLabel = 'Filters',
    facetsActiveCount = 0,
    fillHeight = true,
    sx,
  } = props;
  const detectedClass = useWindowClass();
  const detectedModality = useInputModality();
  const windowClass = props.windowClass ?? detectedClass;
  const inputModality = props.inputModality ?? detectedModality;
  const reducedMotion = useReducedMotion();
  const budgets = useMemo(() => explorerBudgets({ windowClass, inputModality }), [windowClass, inputModality]);

  const [panes, updatePanes] = usePaneState(windowClass);
  const canvasRef = useRef<HTMLDivElement | null>(null);

  // --- Compact state -----------------------------------------------------------
  const [sheetSnap, setSheetSnap] = useState<SheetSnap>('peek');
  const [sheetHeight, setSheetHeight] = useState(0);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [timeBarExpanded, setTimeBarExpanded] = useState(false);
  // The sheet opens at peek every time (adjusting state while rendering, from the prop).
  const [wasOpen, setWasOpen] = useState(inspectorOpen);
  if (wasOpen !== inspectorOpen) {
    setWasOpen(inspectorOpen);
    if (inspectorOpen) setSheetSnap('peek');
    else setSheetHeight(0);
  }

  const focusCanvas = useCallback(() => {
    const root = canvasRef.current;
    if (!root) return;
    const target = root.querySelector<HTMLElement>('[role="application"], [data-canvas-focus]') ?? root;
    target.focus({ preventScroll: true });
  }, []);

  // The inspector closing (Escape, swipe, the page clearing the selection) returns focus to the canvas
  // when the closed surface took it with it.
  const previousOpen = useRef(inspectorOpen);
  useEffect(() => {
    const was = previousOpen.current;
    previousOpen.current = inspectorOpen;
    if (!was || inspectorOpen) return;
    const active = document.activeElement;
    if (!active || active === document.body) focusCanvas();
  }, [inspectorOpen, focusCanvas]);

  const closeInspector = useCallback(() => {
    onInspectorOpenChange(false);
    // The surface unmounts this render; focus the canvas once it is gone.
    requestAnimationFrame(focusCanvas);
  }, [focusCanvas, onInspectorOpenChange]);

  const closeDrawer = useCallback(() => {
    setDrawerOpen(false);
    requestAnimationFrame(focusCanvas);
  }, [focusCanvas]);

  // A class change away from compact must not leave a drawer open behind it.
  useEffect(() => {
    if (windowClass !== 'compact') setDrawerOpen(false);
  }, [windowClass]);

  const compact = windowClass === 'compact';
  const medium = windowClass === 'medium';
  const expanded = windowClass === 'expanded';
  const showInspector = inspectorOpen && inspector !== undefined && inspector !== null;
  const hasFacets = facets !== undefined && facets !== null;
  const hasTimeBar = timeBar !== undefined && timeBar !== null;

  const canvasInsets = useMemo<CanvasInsets>(() => {
    if (!showInspector) return NO_INSETS;
    if (compact) return { ...NO_INSETS, bottom: sheetHeight };
    if (medium) return { ...NO_INSETS, right: INSPECTOR_OVERLAY_WIDTH };
    return NO_INSETS;
  }, [showInspector, compact, medium, sheetHeight]);

  const context = useMemo<InsightCanvasContextValue>(
    () => ({ windowClass, inputModality, budgets, canvasInsets, sheetSnap, focusCanvas }),
    [windowClass, inputModality, budgets, canvasInsets, sheetSnap, focusCanvas],
  );

  const onInspectorKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      closeInspector();
    }
  };

  const transition = reducedMotion ? 'none' : 'width 160ms ease';

  // --- Panes (expanded) and the rail (medium) -----------------------------------
  let leftArea: ReactNode = null;
  if (hasFacets && expanded) {
    leftArea = panes.facetsCollapsed ? (
      <CollapsedRail side="left" label={`Show ${facetsLabel.toLowerCase()}`} onClick={() => updatePanes({ facetsCollapsed: false })} />
    ) : (
      <>
        <Box
          component="section"
          aria-label={facetsLabel}
          sx={{
            flex: `0 0 ${panes.facetsWidth}px`,
            width: panes.facetsWidth,
            minWidth: 0,
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
            bgcolor: 'background.paper',
            transition,
          }}
        >
          <PaneHeader
            title={facetsLabel}
            hideLabel={`Hide ${facetsLabel.toLowerCase()}`}
            side="left"
            onHide={() => updatePanes({ facetsCollapsed: true })}
          />
          <Box sx={{ flex: 1, minHeight: 0, overflowY: 'auto', px: 1.5, pb: 1.5 }}>{facets}</Box>
        </Box>
        <PaneResizer
          pane="left"
          label={`Resize ${facetsLabel.toLowerCase()}`}
          value={panes.facetsWidth}
          min={PANE_LIMITS.facets.min}
          max={PANE_LIMITS.facets.max}
          onChange={(facetsWidth) => updatePanes({ facetsWidth })}
        />
      </>
    );
  } else if (hasFacets && medium && !panes.facetsCollapsed) {
    leftArea = (
      <FacetsRail
        label={facetsLabel}
        activeCount={facetsActiveCount}
        onCollapse={() => updatePanes({ facetsCollapsed: true })}
      >
        {facets}
      </FacetsRail>
    );
  }

  let rightArea: ReactNode = null;
  if (expanded && showInspector) {
    rightArea = panes.inspectorCollapsed ? (
      <CollapsedRail side="right" label={`Show ${inspectorLabel.toLowerCase()}`} onClick={() => updatePanes({ inspectorCollapsed: false })} />
    ) : (
      <>
        <PaneResizer
          pane="right"
          label={`Resize ${inspectorLabel.toLowerCase()}`}
          value={panes.inspectorWidth}
          min={PANE_LIMITS.inspector.min}
          max={PANE_LIMITS.inspector.max}
          onChange={(inspectorWidth) => updatePanes({ inspectorWidth })}
        />
        <Box
          component="section"
          aria-label={inspectorLabel}
          onKeyDown={onInspectorKeyDown}
          sx={{
            flex: `0 0 ${panes.inspectorWidth}px`,
            width: panes.inspectorWidth,
            minWidth: 0,
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
            bgcolor: 'background.paper',
            transition,
          }}
        >
          <PaneHeader
            title={inspectorLabel}
            hideLabel={`Hide ${inspectorLabel.toLowerCase()}`}
            side="right"
            onHide={() => updatePanes({ inspectorCollapsed: true })}
          />
          <Box sx={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>{inspector}</Box>
        </Box>
      </>
    );
  }

  const timeBarHeight = compact
    ? timeBarExpanded
      ? TIME_BAR_HEIGHT.stripExpanded
      : TIME_BAR_HEIGHT.strip
    : medium
      ? TIME_BAR_HEIGHT.medium
      : TIME_BAR_HEIGHT.expanded;

  return (
    <InsightCanvasContext.Provider value={context}>
      <Box
        data-window-class={windowClass}
        data-input-modality={inputModality}
        sx={[
          {
            display: 'flex',
            flexDirection: 'column',
            minWidth: 0,
            width: '100%',
            height: fillHeight ? FILL_HEIGHT[windowClass] : undefined,
            minHeight: fillHeight ? undefined : 320,
            // Notched phones: keep the content off the sensor housing in landscape.
            pl: 'env(safe-area-inset-left)',
            pr: 'env(safe-area-inset-right)',
            border: 1,
            borderColor: 'divider',
            borderRadius: 2,
            overflow: 'hidden',
            bgcolor: 'background.default',
          },
          ...(Array.isArray(sx) ? sx : sx ? [sx] : []),
        ]}
      >
        {topBar !== undefined && topBar !== null && (
          <Box sx={{ flex: '0 0 auto', px: { xs: 1, sm: 1.5 }, pt: 1, pb: 1, minWidth: 0 }}>{topBar}</Box>
        )}
        <Box sx={{ flex: 1, minHeight: 0, display: 'flex', minWidth: 0, borderTop: 1, borderColor: 'divider' }}>
          {leftArea}
          <Box
            sx={{
              position: 'relative',
              flex: 1,
              minWidth: 0,
              minHeight: 0,
              overflow: 'hidden',
              bgcolor: 'background.paper',
            }}
          >
            {/* The canvas is ALWAYS the first child here: a class change must never remount it. */}
            <Box ref={canvasRef} sx={{ position: 'absolute', inset: 0 }}>
              {typeof canvas === 'function' ? canvas(context) : canvas}
            </Box>

            {hasFacets && medium && panes.facetsCollapsed && (
              <Tooltip title={`Show ${facetsLabel.toLowerCase()}`}>
                <IconButton
                  aria-label={`Show ${facetsLabel.toLowerCase()}`}
                  onClick={() => updatePanes({ facetsCollapsed: false })}
                  sx={{ position: 'absolute', top: 8, left: 8, zIndex: 2, bgcolor: 'background.paper', border: 1, borderColor: 'divider', width: 44, height: 44 }}
                >
                  <ChevronRightIcon />
                </IconButton>
              </Tooltip>
            )}

            {hasFacets && compact && !(showInspector && sheetSnap === 'full') && (
              <Fab
                variant="extended"
                size="medium"
                color="primary"
                aria-label={facetsLabel}
                aria-haspopup="dialog"
                aria-expanded={drawerOpen}
                onClick={() => setDrawerOpen(true)}
                sx={{
                  position: 'absolute',
                  left: 16,
                  bottom: `calc(16px + ${showInspector ? sheetHeight : 0}px + ${hasTimeBar ? timeBarHeight : 0}px)`,
                  zIndex: 2,
                  minHeight: 44,
                }}
              >
                <Badge color="secondary" badgeContent={facetsActiveCount} invisible={facetsActiveCount === 0}>
                  <FilterListIcon sx={{ mr: 1 }} />
                </Badge>
                {facetsLabel}
              </Fab>
            )}

            {compact && hasTimeBar && (
              <Box
                role="group"
                aria-label="Time bar"
                sx={{
                  position: 'absolute',
                  left: 0,
                  right: 0,
                  bottom: showInspector ? sheetHeight : 0,
                  height: timeBarHeight,
                  zIndex: 2,
                  display: 'flex',
                  alignItems: 'stretch',
                  bgcolor: 'background.paper',
                  borderTop: 1,
                  borderColor: 'divider',
                  transition: reducedMotion ? 'none' : 'height 160ms ease',
                }}
              >
                <Box sx={{ flex: 1, minWidth: 0, overflow: 'hidden' }}>{timeBar}</Box>
                <Tooltip title={timeBarExpanded ? 'Collapse the time bar' : 'Expand the time bar'}>
                  <IconButton
                    size="small"
                    aria-label={timeBarExpanded ? 'Collapse the time bar' : 'Expand the time bar'}
                    aria-expanded={timeBarExpanded}
                    onClick={() => setTimeBarExpanded((value) => !value)}
                    sx={{ width: 44, borderRadius: 0 }}
                  >
                    <UnfoldMoreIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
              </Box>
            )}

            {medium && showInspector && (
              <Box
                component="section"
                aria-label={inspectorLabel}
                onKeyDown={onInspectorKeyDown}
                sx={(theme) => ({
                  position: 'absolute',
                  top: 0,
                  right: 0,
                  bottom: 0,
                  width: INSPECTOR_OVERLAY_WIDTH,
                  maxWidth: '100%',
                  zIndex: 3,
                  display: 'flex',
                  flexDirection: 'column',
                  bgcolor: 'background.paper',
                  borderLeft: 1,
                  borderColor: 'divider',
                  boxShadow: theme.shadows[8],
                })}
              >
                <Box sx={{ display: 'flex', alignItems: 'center', px: 1.5, pt: 0.5 }}>
                  <Typography variant="overline" color="text.secondary" sx={{ flex: 1 }}>
                    {inspectorLabel}
                  </Typography>
                  <IconButton size="small" aria-label={`Close ${inspectorLabel.toLowerCase()}`} onClick={closeInspector}>
                    <CloseIcon fontSize="small" />
                  </IconButton>
                </Box>
                <Box sx={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>{inspector}</Box>
              </Box>
            )}

            {compact && (
              <BottomSheet
                open={showInspector}
                snap={sheetSnap}
                onSnapChange={setSheetSnap}
                onClose={closeInspector}
                label={inspectorLabel}
                onHeightChange={setSheetHeight}
              >
                {inspector}
              </BottomSheet>
            )}
          </Box>
          {rightArea}
        </Box>
        {hasTimeBar && !compact && (
          <Box
            role="group"
            aria-label="Time bar"
            sx={{ flex: `0 0 ${timeBarHeight}px`, minWidth: 0, borderTop: 1, borderColor: 'divider', bgcolor: 'background.paper', overflow: 'hidden' }}
          >
            {timeBar}
          </Box>
        )}
      </Box>

      {hasFacets && compact && (
        <Drawer
          anchor="left"
          open={drawerOpen}
          onClose={closeDrawer}
          disableRestoreFocus
          transitionDuration={reducedMotion ? 0 : undefined}
          slotProps={{
            paper: {
              role: 'dialog',
              'aria-modal': true,
              'aria-label': facetsLabel,
              sx: { width: 'min(320px, 86vw)', pt: 'env(safe-area-inset-top)', pl: 'env(safe-area-inset-left)' },
            },
          }}
        >
          <Box sx={{ display: 'flex', alignItems: 'center', px: 2, pt: 1 }}>
            <Typography variant="h6" component="h2" sx={{ flex: 1 }}>
              {facetsLabel}
            </Typography>
            <IconButton aria-label={`Close ${facetsLabel.toLowerCase()}`} onClick={closeDrawer} edge="end">
              <CloseIcon />
            </IconButton>
          </Box>
          <Box sx={{ flex: 1, overflowY: 'auto', p: 2 }}>{facets}</Box>
        </Drawer>
      )}
    </InsightCanvasContext.Provider>
  );
}

function PaneHeader(props: { title: string; hideLabel: string; side: 'left' | 'right'; onHide: () => void }) {
  const { title, hideLabel, side, onHide } = props;
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', px: 1.5, pt: 0.5, pb: 0.5, flex: '0 0 auto' }}>
      <Typography variant="overline" color="text.secondary" sx={{ flex: 1 }}>
        {title}
      </Typography>
      <Tooltip title={hideLabel}>
        <IconButton size="small" aria-label={hideLabel} onClick={onHide}>
          {side === 'left' ? <ChevronRightIcon fontSize="small" sx={{ transform: 'scaleX(-1)' }} /> : <ChevronRightIcon fontSize="small" />}
        </IconButton>
      </Tooltip>
    </Box>
  );
}

function CollapsedRail(props: { side: 'left' | 'right'; label: string; onClick: () => void }) {
  const { side, label, onClick } = props;
  return (
    <Box
      sx={{
        flex: `0 0 ${COLLAPSED_RAIL_PX}px`,
        width: COLLAPSED_RAIL_PX,
        display: 'flex',
        justifyContent: 'center',
        pt: 1,
        bgcolor: 'background.paper',
        [side === 'left' ? 'borderRight' : 'borderLeft']: 1,
        borderColor: 'divider',
      }}
    >
      <Tooltip title={label} placement={side === 'left' ? 'right' : 'left'}>
        <IconButton size="small" aria-label={label} onClick={onClick}>
          <ChevronRightIcon fontSize="small" sx={side === 'right' ? { transform: 'scaleX(-1)' } : undefined} />
        </IconButton>
      </Tooltip>
    </Box>
  );
}
