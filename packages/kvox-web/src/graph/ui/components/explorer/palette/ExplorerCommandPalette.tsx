/**
 * `ExplorerCommandPalette` — search and commands for the Insight Canvas
 * (GIC-09, #670; epic #661), opened with Ctrl/Cmd+K, `/`, or the search field in
 * the top bar.
 *
 * SECTIONS, in this order:
 *   - On canvas: a local fuzzy match over the labels of the nodes already drawn.
 *     Choosing one flies the camera there and selects it.
 *   - In your graph: `GET /graph/entities?q=` (trigram over labels and aliases).
 *     Enter adds the entity as a starting point (seed); Alt+Enter replaces the
 *     seeds. The seed cap of {@link MAX_PALETTE_SEEDS} is kept, with a message.
 *   - Actions: what the page offers right now (expand, hide, re-layout, switch
 *     view, "Connect A and B"). The Lenses are NOT here until their story
 *     ships: the page adds an action to `actions` only when the capability exists.
 *
 * `type:Person joe` narrows both result sections to a type.
 *
 * ACCESSIBILITY. The input is a `combobox` that controls a `listbox` of
 * `option`s grouped by section; focus stays in the input and the active option
 * is `aria-activedescendant`. The result count is announced in a live region
 * INSIDE the dialog (a modal hides the rest of the page from assistive tech).
 * Escape closes; the page then returns focus to the canvas.
 *
 * LAYOUT. A full-screen sheet on a compact window with 44px rows, a 640px
 * centred modal on the others.
 */

import AddIcon from '@mui/icons-material/Add';
import CloseIcon from '@mui/icons-material/Close';
import SearchIcon from '@mui/icons-material/Search';
import SwapHorizIcon from '@mui/icons-material/SwapHoriz';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import IconButton from '@mui/material/IconButton';
import InputAdornment from '@mui/material/InputAdornment';
import TextField from '@mui/material/TextField';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Typography from '@mui/material/Typography';
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

import { useKvoxHost } from '../../../../../core/headless/index.js';
import { listGraphEntities, type GraphEntitySummary } from '../../../../headless/clients/graph.js';
import { visuallyHidden } from '../../../visuallyHidden.js';
import { EntityTypeIcon } from '../../entityTypeIcon.js';
import type { ExplorerGraph } from '../explorerModel.js';
import type { WindowClass } from '../shell/useWindowClass.js';
import {
  GRAPH_RESULT_LIMIT,
  MAX_PALETTE_SEEDS,
  canvasMatches,
  fuzzyScore,
  parsePaletteQuery,
  seedPlan,
  type PaletteTypeOption,
} from './paletteModel.js';

/** Accessible name of the palette dialog and its input. */
export const PALETTE_LABEL = 'Search the graph and run commands';
/** How long typing pauses before the graph is searched (ms). */
export const PALETTE_DEBOUNCE_MS = 200;

/** A command the page offers in the palette's Actions section. */
export interface PaletteAction {
  /** A stable id, also the option's DOM id suffix. */
  id: string;
  /** The words shown and matched, such as `Expand selection`. */
  label: string;
  /** A short second line, such as the name of the selected node. */
  hint?: string;
  /** Not available right now; shown dimmed and cannot be chosen. */
  disabled?: boolean;
  /** An icon drawn before the label. */
  icon?: ReactNode;
  /** Runs the command; the palette closes first. */
  run: () => void;
}

/** Props of {@link ExplorerCommandPalette}. */
export interface ExplorerCommandPaletteProps {
  /** Whether the palette is open. */
  open: boolean;
  /** Called on Escape, a backdrop click, the close button, and after a choice. */
  onClose: () => void;
  /** Compact: a full-screen sheet; otherwise a 640px modal. */
  windowClass: WindowClass;
  /** The graph on the canvas, for the "On canvas" section. */
  graph: ExplorerGraph;
  /** The nodes the canvas draws. */
  visibleIds: ReadonlySet<string>;
  /** Increments when `graph` is mutated, so the matches are recomputed. */
  version: number;
  /** The node types a `type:` token may name. */
  typeOptions: readonly PaletteTypeOption[];
  /** The current seeds. */
  seedIds: readonly string[];
  /** Fly to and select a node already on the canvas. */
  onSelectNode: (id: string) => void;
  /** Make these the seeds (the page writes `?seed=`). */
  onSetSeeds: (seedIds: string[]) => void;
  /** What the Actions section offers. */
  actions: readonly PaletteAction[];
  /** Largest number of seeds; defaults to {@link MAX_PALETTE_SEEDS}. */
  maxSeeds?: number;
}

type Row =
  | { key: string; section: 'canvas'; id: string; label: string; type: string }
  | { key: string; section: 'graph'; entity: GraphEntitySummary }
  | { key: string; section: 'action'; action: PaletteAction };

const SECTION_TITLES = { canvas: 'On canvas', graph: 'In your graph', action: 'Actions' } as const;

/** The palette. Its body mounts only while open, so every opening starts empty. */
export function ExplorerCommandPalette(props: ExplorerCommandPaletteProps) {
  const { open, onClose, windowClass } = props;
  const compact = windowClass === 'compact';
  return (
    <Dialog
      open={open}
      onClose={onClose}
      fullScreen={compact}
      fullWidth
      maxWidth={false}
      // The page puts focus back on the canvas (or the control that opened the palette).
      disableRestoreFocus
      slotProps={{
        paper: {
          'aria-label': PALETTE_LABEL,
          sx: compact
            ? undefined
            : { width: 640, maxWidth: 'calc(100vw - 32px)', alignSelf: 'flex-start', mt: '12vh', maxHeight: '70vh' },
        },
      }}
      sx={compact ? undefined : { '& .MuiDialog-container': { alignItems: 'flex-start' } }}
    >
      <PaletteBody {...props} compact={compact} />
    </Dialog>
  );
}

function PaletteBody({
  onClose,
  compact,
  graph,
  visibleIds,
  version,
  typeOptions,
  seedIds,
  onSelectNode,
  onSetSeeds,
  actions,
  maxSeeds = MAX_PALETTE_SEEDS,
}: ExplorerCommandPaletteProps & { compact: boolean }) {
  const host = useKvoxHost();
  const baseId = useId();
  const listboxId = `${baseId}-listbox`;
  const [input, setInput] = useState('');
  const [debounced, setDebounced] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const [mode, setMode] = useState<'add' | 'replace'>('add');
  const [message, setMessage] = useState<string | null>(null);
  const [remote, setRemote] = useState<{ key: string; items: GraphEntitySummary[]; error: boolean } | null>(null);
  const activeRef = useRef<HTMLElement | null>(null);

  const query = useMemo(() => parsePaletteQuery(input, typeOptions), [input, typeOptions]);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(input), PALETTE_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [input]);
  const settled = useMemo(() => parsePaletteQuery(debounced, typeOptions), [debounced, typeOptions]);

  // The entity index only knows entity types; an item kind (lowercase key) never matches there.
  const remoteTypes = settled.types.filter((key) => /^[A-Z]/.test(key));
  const remoteWanted =
    settled.unknownTypes.length === 0 &&
    (settled.text !== '' || remoteTypes.length > 0) &&
    !(settled.types.length > 0 && remoteTypes.length === 0);
  const remoteKey = `${settled.text}|${remoteTypes.join(',')}`;

  useEffect(() => {
    if (!remoteWanted) return undefined;
    const controller = new AbortController();
    listGraphEntities(
      host,
      {
        q: settled.text || undefined,
        type: remoteTypes.length > 0 ? remoteTypes : undefined,
        limit: GRAPH_RESULT_LIMIT,
      },
      controller.signal,
    )
      .then((page) => {
        if (!controller.signal.aborted) setRemote({ key: remoteKey, items: page.items, error: false });
      })
      .catch(() => {
        if (!controller.signal.aborted) setRemote({ key: remoteKey, items: [], error: true });
      });
    return () => controller.abort();
    // `remoteKey` carries every input of the request.
  }, [host, remoteWanted, remoteKey]);

  const searching = remoteWanted && (debounced !== input || remote?.key !== remoteKey);

  const canvasRows = useMemo<Row[]>(
    () =>
      canvasMatches(graph, visibleIds, query).map((match) => ({
        key: `canvas-${match.id}`,
        section: 'canvas' as const,
        ...match,
      })),
    // `version`: the graph is mutated in place.
    [graph, visibleIds, query, version],
  );
  const onCanvas = useMemo(() => new Set(canvasRows.map((row) => (row.section === 'canvas' ? row.id : ''))), [canvasRows]);

  const graphRows = useMemo<Row[]>(() => {
    if (!remoteWanted || remote?.key !== remoteKey) return [];
    return remote.items
      .filter((entity) => !onCanvas.has(entity.id))
      .map((entity) => ({ key: `graph-${entity.id}`, section: 'graph' as const, entity }));
  }, [remoteWanted, remote, remoteKey, onCanvas]);

  const actionRows = useMemo<Row[]>(() => {
    if (query.types.length > 0 || query.unknownTypes.length > 0) return [];
    return actions
      .filter((action) => query.text === '' || fuzzyScore(action.label, query.text) !== null)
      .map((action) => ({ key: `action-${action.id}`, section: 'action' as const, action }));
  }, [actions, query]);

  const rows = useMemo(() => [...canvasRows, ...graphRows, ...actionRows], [canvasRows, graphRows, actionRows]);
  const enabledIndexes = useMemo(
    () => rows.map((row, index) => (row.section === 'action' && row.action.disabled ? -1 : index)).filter((i) => i >= 0),
    [rows],
  );

  // A new result list starts at its first enabled row.
  const rowsSignature = rows.map((row) => row.key).join('|');
  useEffect(() => {
    setActiveIndex(enabledIndexes[0] ?? -1);
  }, [rowsSignature]);

  useEffect(() => {
    activeRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [activeIndex]);

  const optionId = (row: Row) => `${baseId}-${row.key}`;
  const activeRow = activeIndex >= 0 ? rows[activeIndex] : undefined;

  const choose = (row: Row, replace: boolean) => {
    if (row.section === 'canvas') {
      onClose();
      onSelectNode(row.id);
      return;
    }
    if (row.section === 'action') {
      if (row.action.disabled) return;
      onClose();
      row.action.run();
      return;
    }
    const plan = seedPlan(seedIds, row.entity.id, replace ? 'replace' : 'add', maxSeeds);
    if (plan.kind === 'refused') {
      setMessage(plan.message);
      return;
    }
    onClose();
    onSetSeeds(plan.seedIds);
  };

  const move = (delta: 1 | -1) => {
    if (enabledIndexes.length === 0) return;
    const at = enabledIndexes.indexOf(activeIndex);
    const next = at === -1 ? 0 : (at + delta + enabledIndexes.length) % enabledIndexes.length;
    setActiveIndex(enabledIndexes[next]);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        move(1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        move(-1);
        break;
      case 'Enter':
        if (event.nativeEvent.isComposing) return;
        event.preventDefault();
        if (activeRow) choose(activeRow, event.altKey || mode === 'replace');
        break;
      default:
        break;
    }
  };

  const total = rows.length;
  const hasQuery = query.text !== '' || query.types.length > 0 || query.unknownTypes.length > 0;
  const announcement = !hasQuery
    ? ''
    : searching
      ? 'Searching your graph'
      : total === 0
        ? 'No results'
        : `${total} ${total === 1 ? 'result' : 'results'}`;

  const sections = (['canvas', 'graph', 'action'] as const)
    .map((section) => ({ section, rows: rows.filter((row) => row.section === section) }))
    .filter((group) => group.rows.length > 0);

  const rowHeight = compact ? 52 : 44;

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 }}>
      <Box sx={{ p: 1.5, display: 'flex', gap: 1, alignItems: 'center', borderBottom: 1, borderColor: 'divider' }}>
        <TextField
          autoFocus
          fullWidth
          value={input}
          onChange={(event) => {
            setInput(event.target.value);
            setMessage(null);
          }}
          onKeyDown={onKeyDown}
          placeholder="Search people, projects, topics, or type a command"
          size={compact ? 'medium' : 'small'}
          slotProps={{
            input: {
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon fontSize="small" />
                </InputAdornment>
              ),
              endAdornment: searching ? (
                <InputAdornment position="end">
                  <CircularProgress size={16} aria-label="Searching" />
                </InputAdornment>
              ) : undefined,
              sx: compact ? { fontSize: '1.125rem' } : undefined,
            },
            htmlInput: {
              role: 'combobox',
              'aria-label': PALETTE_LABEL,
              'aria-autocomplete': 'list',
              'aria-expanded': total > 0,
              'aria-controls': listboxId,
              'aria-activedescendant': activeRow ? optionId(activeRow) : undefined,
              autoComplete: 'off',
              spellCheck: false,
              enterKeyHint: 'go',
            },
          }}
        />
        {compact && (
          <IconButton aria-label="Close search" onClick={onClose} sx={{ width: 44, height: 44 }}>
            <CloseIcon />
          </IconButton>
        )}
      </Box>

      {message && (
        <Alert severity="warning" role="alert" sx={{ m: 1.5, mb: 0 }}>
          {message}
        </Alert>
      )}
      {query.unknownTypes.length > 0 && (
        <Typography variant="body2" color="text.secondary" sx={{ px: 2, pt: 1.5 }}>
          {`No type called "${query.unknownTypes.join('", "')}". Try ${typeOptions
            .slice(0, 3)
            .map((option) => `type:${option.key}`)
            .join(', ')}.`}
        </Typography>
      )}

      <Box sx={{ flex: 1, overflowY: 'auto', minHeight: 0, py: 0.5 }}>
        <Box role="listbox" id={listboxId} aria-label="Results" sx={{ outline: 'none' }}>
          {sections.map(({ section, rows: group }) => {
            const headingId = `${baseId}-${section}-heading`;
            return (
              <Box key={section} role="group" aria-labelledby={headingId}>
                <Typography
                  id={headingId}
                  variant="overline"
                  color="text.secondary"
                  component="div"
                  sx={{ px: 2, pt: 1, display: 'block', lineHeight: 2 }}
                >
                  {SECTION_TITLES[section]}
                </Typography>
                {group.map((row) => {
                  const index = rows.indexOf(row);
                  const active = index === activeIndex;
                  const disabled = row.section === 'action' && row.action.disabled;
                  return (
                    <Box
                      key={row.key}
                      id={optionId(row)}
                      role="option"
                      aria-selected={active}
                      aria-disabled={disabled || undefined}
                      ref={active ? (node: HTMLElement | null) => void (activeRef.current = node) : undefined}
                      // Keep focus in the input while the pointer chooses.
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={(event) => choose(row, event.altKey || mode === 'replace')}
                      onMouseMove={() => {
                        if (!disabled && !active) setActiveIndex(index);
                      }}
                      sx={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 1.5,
                        px: 2,
                        minHeight: rowHeight,
                        cursor: disabled ? 'default' : 'pointer',
                        opacity: disabled ? 0.5 : 1,
                        bgcolor: active ? 'action.selected' : undefined,
                        '&:hover': disabled ? undefined : { bgcolor: 'action.hover' },
                      }}
                    >
                      <RowContent row={row} />
                    </Box>
                  );
                })}
              </Box>
            );
          })}
        </Box>
        {!hasQuery && sections.length === 0 && (
          <Typography variant="body2" color="text.secondary" sx={{ p: 2 }}>
            Type a name. Use type:Person to narrow the results to one kind of thing.
          </Typography>
        )}
        {hasQuery && !searching && total === 0 && query.unknownTypes.length === 0 && (
          <Typography variant="body2" color="text.secondary" sx={{ p: 2 }}>
            Nothing in your graph matches.
          </Typography>
        )}
      </Box>

      {graphRows.length > 0 && (
        <Box
          sx={{
            px: 2,
            py: 1,
            borderTop: 1,
            borderColor: 'divider',
            display: 'flex',
            alignItems: 'center',
            gap: 1.5,
            flexWrap: 'wrap',
          }}
        >
          <ToggleButtonGroup
            exclusive
            size="small"
            value={mode}
            onChange={(_event, next: 'add' | 'replace' | null) => {
              if (next) setMode(next);
            }}
            aria-label="What choosing a result from your graph does"
          >
            <ToggleButton value="add" sx={{ textTransform: 'none', minHeight: compact ? 44 : undefined, px: 1.5 }}>
              <AddIcon fontSize="small" sx={{ mr: 0.5 }} />
              Add as a start
            </ToggleButton>
            <ToggleButton value="replace" sx={{ textTransform: 'none', minHeight: compact ? 44 : undefined, px: 1.5 }}>
              <SwapHorizIcon fontSize="small" sx={{ mr: 0.5 }} />
              Replace the starts
            </ToggleButton>
          </ToggleButtonGroup>
          {!compact && (
            <Typography variant="caption" color="text.secondary">
              Enter adds. Alt+Enter replaces.
            </Typography>
          )}
        </Box>
      )}

      <Box role="status" aria-live="polite" sx={visuallyHidden}>
        {announcement}
      </Box>
    </Box>
  );
}

function RowContent({ row }: { row: Row }) {
  if (row.section === 'canvas') {
    return (
      <>
        <EntityTypeIcon type={row.type} fontSize="small" sx={{ color: 'text.secondary' }} />
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="body2" noWrap>
            {row.label}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            {row.type}
          </Typography>
        </Box>
      </>
    );
  }
  if (row.section === 'graph') {
    return (
      <>
        <EntityTypeIcon type={row.entity.type} fontSize="small" sx={{ color: 'text.secondary' }} />
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="body2" noWrap>
            {row.entity.label}
          </Typography>
          <Typography variant="caption" color="text.secondary" noWrap component="div">
            {[row.entity.type, row.entity.aliases[0]].filter(Boolean).join(' · ')}
          </Typography>
        </Box>
      </>
    );
  }
  return (
    <>
      {row.action.icon && <Box sx={{ display: 'flex', color: 'text.secondary' }}>{row.action.icon}</Box>}
      <Box sx={{ minWidth: 0 }}>
        <Typography variant="body2" noWrap>
          {row.action.label}
        </Typography>
        {row.action.hint && (
          <Typography variant="caption" color="text.secondary" noWrap component="div">
            {row.action.hint}
          </Typography>
        )}
      </Box>
    </>
  );
}
