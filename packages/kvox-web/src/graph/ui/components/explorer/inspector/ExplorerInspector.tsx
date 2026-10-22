/**
 * `ExplorerInspector` — the evidence-first inspector of the Insight Canvas
 * (GIC-11, #672; epic #661). It replaces `ExplorerSidePanel` in the shell's
 * `inspector` slot, which supplies the container: the bottom sheet on a phone,
 * the right overlay on a tablet, the right pane on a laptop. This component
 * reads no breakpoint of its own: the page hands it the shell's window class
 * and input modality, and the sheet's snap comes from the shell's context.
 *
 * WHAT IT SHOWS
 *
 *   - a NODE: type glyph and label, aliases, first and last seen, mentions,
 *     the actions (Focus, Expand with its by-type menu, Open page, Pin, Hide,
 *     Ask), and the tabs Overview, Evidence, Connections, Timeline and Ask;
 *   - an EDGE: its label, ends, role and stance chips, validity, confidence and
 *     evidence count, and the tabs Evidence (the default) and Overview;
 *   - SEVERAL marked nodes: the Selection view.
 *
 * Every number and every quote comes from the API; the inspector arranges them.
 * The Ask tab exists only when the host passes the `AskPanel` slot.
 *
 * COMPACT. At the sheet's peek only the header, the three primary actions and
 * "N evidence" show; the tab strip (scrollable) appears from half height.
 *
 * ARIA. The root is a named group (the node's label or the edge's relation);
 * the tabs follow the ARIA tabs pattern (MUI `Tabs`, with `aria-controls` and
 * `aria-labelledby` pairs).
 */

import CloseIcon from '@mui/icons-material/Close';
import MoreHorizIcon from '@mui/icons-material/MoreHoriz';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import IconButton from '@mui/material/IconButton';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';
import Typography from '@mui/material/Typography';
import { useTheme } from '@mui/material/styles';
import { Fragment, useId, useMemo, useState, type ComponentType, type ReactNode } from 'react';
import { Link as RouterLink } from 'react-router-dom';

import type { GraphOntology } from '../../../../headless/clients/graph.js';
import { useGraphEntity } from '../../../../headless/hooks/useGraphEntity.js';
import { formatPrecisionDate } from '../../../../headless/utils/graphDisplay.js';
import type { ExpandOnly } from '../../../hooks/useGraphExplorer.js';
import type { GraphEntityAskPanelProps } from '../../../pages/GraphEntityPage.js';
import { entityPath } from '../../EntityListRow.js';
import type { ExplorerGraph } from '../explorerModel.js';
import type { InputModality } from '../shell/useInputModality.js';
import { useOptionalInsightCanvas } from '../shell/InsightCanvasLayout.js';
import type { WindowClass } from '../shell/useWindowClass.js';
import { AskTab } from './AskTab.js';
import { ConnectionsTab } from './ConnectionsTab.js';
import { EvidenceTab } from './EvidenceTab.js';
import { ExpandControl } from './ExpandControl.js';
import { EdgeChips, EdgeOverview, EntityOverview, ItemOverview, formatValidity } from './OverviewTab.js';
import { SelectionView } from './SelectionView.js';
import { TimelineTab } from './TimelineTab.js';
import { TypeGlyph } from './TypeGlyph.js';
import {
  INSPECTOR_TAB_LABELS,
  defaultTabFor,
  evidenceSubjectForNode,
  expandMenuModel,
  tabsFor,
  type EdgeSelection,
  type ExplorerSelection,
  type InspectorTab,
  type NodeSelection,
  type SelectionSummary,
} from './inspectorModel.js';

/**
 * Props of {@link ExplorerInspector}.
 *
 * @stability experimental
 */
export interface ExplorerInspectorProps {
  /** The selected node or edge, or `null`. */
  selection: ExplorerSelection | null;
  /** Two or more marked nodes: the Selection view replaces the single selection. */
  multi?: SelectionSummary | null;
  /** The explorer's graph, read for the Connections tab and the Selection view. */
  graph: ExplorerGraph;
  /** Changes whenever the graph does. */
  version: number;
  /** The ontology, for labels. */
  ontology: GraphOntology | null;
  /** The type label function. */
  typeLabel: (type: string) => string;
  /** The shell's window class: decides what is inline and what sits behind the `⋯` menu. */
  windowClass: WindowClass;
  /** The shell's input modality: a coarse pointer gets 44px targets. */
  inputModality: InputModality;
  /** The node cap is reached: every expand is refused. */
  atCap: boolean;
  /** The node an expand is in flight for. */
  expandingId: string | null;
  /** Relation types the user's filters hide (their Expand choices are disabled). */
  hiddenRelationTypes: ReadonlySet<string>;
  /** Node types the user's filters hide. */
  hiddenTypes: ReadonlySet<string>;
  /** The open tab, from the URL; `null` for the selection's default. */
  tab: InspectorTab | null;
  /** The user picked a tab. */
  onTabChange: (tab: InspectorTab) => void;
  /** Expand a node, optionally only along one relation type or to one entity type. */
  onExpand: (id: string, only?: ExpandOnly) => void;
  /** Expand several nodes, one after the other. */
  onExpandAll: (ids: string[]) => void;
  /** Hide a node. */
  onHide: (id: string) => void;
  /** Hide several nodes (seeds stay). */
  onHideAll: (ids: string[]) => void;
  /** Make a node a starting point ("Focus"). */
  onMakeSeed: (id: string) => void;
  /** Pin or unpin a node in the layout. */
  onPin: (id: string) => void;
  /** Select another node. */
  onSelectNode: (id: string) => void;
  /** Ring these nodes on the canvas. */
  onShowOnCanvas: (ids: string[]) => void;
  /** Close the inspector (and unmark a multi-selection). */
  onClose: () => void;
  /** Set the TimeBar's brush to the bucket holding an event's date (`YYYY-MM-DD` or an ISO instant): the Timeline tab's "Show in TimeBar". Without it the link is not offered. */
  onShowInTimeBar?: (at: string) => void;
  /** The host's Ask panel (the entity page's `AskPanel` slot); without it there is no Ask tab. */
  AskPanel?: ComponentType<GraphEntityAskPanelProps>;
  /** Actions from later stories ("Path to…", GIC-13), drawn as the third primary action. */
  extraActions?: ReactNode;
  /** Actions for the Selection view from later stories ("Find connections", "Ask about selection"). */
  selectionExtraActions?: ReactNode;
  /** Actions drawn above the edge overview ("Ask about this selection", GIC-17). */
  edgeExtraActions?: ReactNode;
}

/**
 * The tabbed inspector for the selected node or edge, or the Selection view for several marked nodes.
 *
 * @stability experimental
 */
export function ExplorerInspector(props: ExplorerInspectorProps) {
  const { selection, multi } = props;
  const touch = props.inputModality === 'touch';
  if (multi && multi.ids.length >= 2) {
    return (
      <SelectionView
        summary={multi}
        typeLabel={props.typeLabel}
        atCap={props.atCap}
        busy={props.expandingId !== null}
        onExpandAll={props.onExpandAll}
        onHideAll={props.onHideAll}
        onSelectNode={props.onSelectNode}
        onClose={props.onClose}
        extraActions={props.selectionExtraActions}
        touch={touch}
      />
    );
  }
  if (!selection) return null;
  // Keyed by the selection, so a new node never shows the previous one's tabs, detail or quotes.
  return <SelectedInspector key={`${selection.kind}:${selection.id}`} {...props} selection={selection} />;
}

function SelectedInspector(props: ExplorerInspectorProps & { selection: ExplorerSelection }) {
  const {
    selection,
    graph,
    version,
    ontology,
    typeLabel,
    windowClass,
    atCap,
    expandingId,
    hiddenRelationTypes,
    hiddenTypes,
    tab,
    onTabChange,
    onExpand,
    onSelectNode,
    onShowOnCanvas,
    onClose,
    onShowInTimeBar,
    AskPanel,
    extraActions,
  } = props;
  const touch = props.inputModality === 'touch';
  const shell = useOptionalInsightCanvas();
  const peek = shell?.windowClass === 'compact' && shell.sheetSnap === 'peek';
  const baseId = useId();

  const node = selection.kind === 'node' ? selection : null;
  const isEntity = node?.nodeKind === 'entity';
  const entity = useGraphEntity(isEntity ? node.id : undefined);
  const detail = isEntity ? entity.data : null;

  const tabs = tabsFor(selection, AskPanel !== undefined);
  const active: InspectorTab = tab && tabs.includes(tab) ? tab : defaultTabFor(selection);
  const title = selection.kind === 'node' ? selection.label : selection.relationLabel;

  const expandModel = useMemo(
    () =>
      expandMenuModel({ counts: detail?.counts, ontology, typeLabel, hiddenRelationTypes, hiddenTypes }),
    [detail?.counts, ontology, typeLabel, hiddenRelationTypes, hiddenTypes],
  );

  const evidenceCount =
    selection.kind === 'edge' ? selection.evidenceCount : isEntity ? (detail?.counts.evidence ?? null) : null;

  return (
    // A named group, not a landmark: the shell's region around it carries the landmark.
    <Box role="group" aria-label={title}>
      <Box sx={{ p: 2, pb: peek ? 1 : 1.5, display: 'flex', flexDirection: 'column', gap: 1 }}>
        {selection.kind === 'node' ? (
          <NodeHeader
            node={selection}
            title={title}
            aliases={detail?.aliases.map((a) => a.alias) ?? []}
            firstSeenAt={detail?.firstSeenAt ?? null}
            lastSeenAt={selection.lastSeenAt ?? detail?.lastSeenAt ?? null}
            mentions={selection.mentionCount ?? detail?.counts.mentions ?? null}
            onClose={onClose}
            touch={touch}
          />
        ) : (
          <EdgeHeader edge={selection} onClose={onClose} touch={touch} />
        )}
        {node && (
          <NodeActions
            node={node}
            windowClass={windowClass}
            touch={touch}
            atCap={atCap}
            expanding={expandingId === node.id}
            expandModel={expandModel}
            askAvailable={AskPanel !== undefined && isEntity === true}
            extraActions={extraActions}
            onExpand={onExpand}
            onHide={props.onHide}
            onMakeSeed={props.onMakeSeed}
            onPin={props.onPin}
            onAsk={() => onTabChange('ask')}
          />
        )}
        {selection.kind === 'edge' && props.edgeExtraActions && (
          <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>{props.edgeExtraActions}</Box>
        )}
        {evidenceCount !== null && (
          // Not a button on purpose: at the sheet's peek a tap on it falls through and lifts the sheet to half.
          <Chip
            size="small"
            variant="outlined"
            sx={{ alignSelf: 'flex-start' }}
            label={evidenceCount === 1 ? '1 evidence' : `${evidenceCount} evidence`}
          />
        )}
      </Box>
      {!peek && (
        <>
          <Box sx={{ position: 'sticky', top: 0, zIndex: 1, bgcolor: 'background.paper', borderBottom: 1, borderColor: 'divider' }}>
            <Tabs
              value={active}
              onChange={(_event, next: InspectorTab) => onTabChange(next)}
              variant="scrollable"
              scrollButtons="auto"
              allowScrollButtonsMobile
              aria-label={`Details of ${title}`}
              sx={{ minHeight: touch ? 48 : 40 }}
            >
              {tabs.map((id) => (
                <Tab
                  key={id}
                  value={id}
                  label={INSPECTOR_TAB_LABELS[id]}
                  id={`${baseId}-tab-${id}`}
                  aria-controls={`${baseId}-panel-${id}`}
                  sx={{ minHeight: touch ? 48 : 40, textTransform: 'none' }}
                />
              ))}
            </Tabs>
          </Box>
          <Box
            role="tabpanel"
            id={`${baseId}-panel-${active}`}
            aria-labelledby={`${baseId}-tab-${active}`}
            tabIndex={0}
            sx={{ p: 2, minWidth: 0 }}
          >
            {active === 'overview' &&
              (selection.kind === 'edge' ? (
                <EdgeOverview edge={selection} onSelectNode={onSelectNode} touch={touch} />
              ) : isEntity ? (
                <EntityOverview entityId={selection.id} ontology={ontology} />
              ) : (
                <ItemOverview node={selection} />
              ))}
            {active === 'evidence' && (
              <EvidenceTab
                subject={selection.kind === 'edge' ? selection.evidenceSubject : evidenceSubjectForNode(selection)}
                clampQuote={windowClass === 'expanded'}
                touch={touch}
              />
            )}
            {active === 'connections' && node && (
              <ConnectionsTab
                graph={graph}
                version={version}
                nodeId={node.id}
                ontology={ontology}
                typeLabel={typeLabel}
                totals={detail?.counts.relationsByType}
                canExpand={isEntity === true && !atCap}
                onSelectNode={onSelectNode}
                onShowOnCanvas={onShowOnCanvas}
                onExpand={onExpand}
                touch={touch}
              />
            )}
            {active === 'timeline' && node && isEntity && (
              <TimelineTab entityId={node.id} ontology={ontology} touch={touch} onShowInTimeBar={onShowInTimeBar} />
            )}
            {active === 'ask' && node && isEntity && AskPanel && (
              <AskTab
                AskPanel={AskPanel}
                entityId={node.id}
                entityLabel={node.label}
                entityType={node.entityType}
                touch={touch}
              />
            )}
          </Box>
        </>
      )}
    </Box>
  );
}

// -----------------------------------------------------------------------------
// Headers
// -----------------------------------------------------------------------------

function CloseButton({ onClose, touch }: { onClose: () => void; touch: boolean }) {
  return (
    <IconButton
      size="small"
      aria-label="Close"
      onClick={onClose}
      edge="end"
      sx={touch ? { minWidth: 44, minHeight: 44 } : undefined}
    >
      <CloseIcon fontSize="small" />
    </IconButton>
  );
}

function NodeHeader(props: {
  node: NodeSelection;
  title: string;
  aliases: string[];
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  mentions: number | null;
  onClose: () => void;
  touch: boolean;
}) {
  const { node, title, aliases, firstSeenAt, lastSeenAt, mentions, onClose, touch } = props;
  const mode = useTheme().palette.mode;
  const shownAliases = aliases.slice(0, 3);
  const facts: string[] = [];
  if (firstSeenAt) facts.push(`First seen ${formatPrecisionDate(firstSeenAt, 'day')}`);
  if (lastSeenAt) facts.push(`Last seen ${formatPrecisionDate(lastSeenAt, 'day')}`);
  if (mentions !== null) facts.push(mentions === 1 ? '1 mention' : `${mentions} mentions`);
  if (facts.length === 0 && node.nodeKind === 'item' && node.occurredAt) {
    facts.push(formatPrecisionDate(node.occurredAt, 'day'));
  }
  return (
    <>
      <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1.25 }}>
        <TypeGlyph type={node.entityType} mode={mode} />
        <Typography variant="h6" component="h2" sx={{ flex: 1, minWidth: 0, wordBreak: 'break-word' }}>
          {title}
        </Typography>
        <CloseButton onClose={onClose} touch={touch} />
      </Box>
      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
        <Chip size="small" label={node.typeLabel} />
        {node.isSeed && <Chip size="small" variant="outlined" label="Starting point" />}
        {node.status && <Chip size="small" variant="outlined" label={node.status} />}
      </Box>
      {shownAliases.length > 0 && (
        <Typography variant="body2" color="text.secondary">
          Also known as {shownAliases.join(', ')}
          {aliases.length > shownAliases.length ? ` +${aliases.length - shownAliases.length}` : ''}
        </Typography>
      )}
      {facts.length > 0 && (
        <Typography variant="body2" color="text.secondary">
          {facts.join(' · ')}
        </Typography>
      )}
      {facts.length === 0 && (
        <Typography variant="body2" color="text.secondary">
          {node.degree === 1 ? '1 connection' : `${node.degree} connections`}
        </Typography>
      )}
    </>
  );
}

function EdgeHeader({ edge, onClose, touch }: { edge: EdgeSelection; onClose: () => void; touch: boolean }) {
  const validity = formatValidity(edge.valid);
  return (
    <>
      <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1 }}>
        <Typography variant="h6" component="h2" sx={{ flex: 1, minWidth: 0, wordBreak: 'break-word' }}>
          {edge.relationLabel}
        </Typography>
        <CloseButton onClose={onClose} touch={touch} />
      </Box>
      <Typography variant="body2" sx={{ wordBreak: 'break-word' }}>
        {edge.fromLabel} → {edge.toLabel}
      </Typography>
      <EdgeChips chips={edge.chips} />
      <Box sx={{ display: 'flex', flexWrap: 'wrap', columnGap: 1.5, rowGap: 0.25 }}>
        <Typography variant="body2" color="text.secondary" component="span">
          {validity ?? 'No dates recorded'}
        </Typography>
        {edge.confidence !== null && (
          <Typography variant="body2" color="text.secondary" component="span">
            Confidence {Math.round(edge.confidence * 100)}%
          </Typography>
        )}
      </Box>
    </>
  );
}

// -----------------------------------------------------------------------------
// Actions
// -----------------------------------------------------------------------------

function NodeActions(props: {
  node: NodeSelection;
  windowClass: WindowClass;
  touch: boolean;
  atCap: boolean;
  expanding: boolean;
  expandModel: ReturnType<typeof expandMenuModel>;
  askAvailable: boolean;
  extraActions?: ReactNode;
  onExpand: (id: string, only?: ExpandOnly) => void;
  onHide: (id: string) => void;
  onMakeSeed: (id: string) => void;
  onPin: (id: string) => void;
  onAsk: () => void;
}) {
  const { node, windowClass, touch, atCap, expanding, expandModel, askAvailable, extraActions } = props;
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const height = touch ? 44 : undefined;
  const entity = node.nodeKind === 'entity';
  const compact = windowClass === 'compact';
  const expanded = windowClass === 'expanded';
  const canHide = !node.isSeed;

  const focus = node.isSeed ? null : (
    <Button key="focus" size="small" variant="outlined" onClick={() => props.onMakeSeed(node.id)} sx={{ minHeight: height }}>
      Focus
    </Button>
  );
  const expand = (
    <ExpandControl
      key="expand"
      nodeId={node.id}
      label={node.label}
      model={entity ? expandModel : { byRelation: [], byType: [] }}
      atCap={atCap}
      expanding={expanding}
      expanded={node.expanded}
      onExpand={props.onExpand}
      touch={touch}
    />
  );
  const openPage = entity ? (
    <Button
      key="open"
      size="small"
      variant="outlined"
      component={RouterLink}
      to={entityPath(node.id)}
      sx={{ minHeight: height }}
    >
      Open page
    </Button>
  ) : null;
  const pin = (
    <Button key="pin" size="small" onClick={() => props.onPin(node.id)} sx={{ minHeight: height }}>
      {node.pinned ? 'Unpin' : 'Pin'}
    </Button>
  );
  const hide = canHide ? (
    <Button key="hide" size="small" onClick={() => props.onHide(node.id)} sx={{ minHeight: height }}>
      Hide
    </Button>
  ) : null;
  const ask = askAvailable ? (
    <Button key="ask" size="small" onClick={props.onAsk} sx={{ minHeight: height }}>
      Ask
    </Button>
  ) : null;

  const extra = extraActions ? <Fragment key="extra">{extraActions}</Fragment> : null;
  let inline: ReactNode[];
  let overflow: Array<{ key: string; label: string; run: () => void }> = [];
  if (compact) {
    // Peek: Focus, Expand and a third (Path to…, GIC-13, else Open page); the rest behind ⋯.
    inline = [focus, expand, extra ?? openPage];
    overflow = [
      ...(extra && entity ? [{ key: 'open', label: 'Open page', run: () => undefined }] : []),
      { key: 'pin', label: node.pinned ? 'Unpin' : 'Pin', run: () => props.onPin(node.id) },
      ...(canHide ? [{ key: 'hide', label: 'Hide', run: () => props.onHide(node.id) }] : []),
      ...(askAvailable ? [{ key: 'ask', label: 'Ask', run: props.onAsk }] : []),
    ];
  } else if (expanded) {
    inline = [focus, expand, openPage, pin, hide, ask, extra];
  } else {
    inline = [focus, expand, openPage, pin, hide, extra];
    overflow = askAvailable ? [{ key: 'ask', label: 'Ask', run: props.onAsk }] : [];
  }

  return (
    <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 1 }}>
      {inline}
      {overflow.length > 0 && (
        <>
          <IconButton
            size="small"
            aria-label="Node actions"
            aria-haspopup="menu"
            aria-expanded={menuAnchor !== null}
            onClick={(event) => setMenuAnchor(event.currentTarget)}
            sx={touch ? { minWidth: 44, minHeight: 44 } : undefined}
          >
            <MoreHorizIcon fontSize="small" />
          </IconButton>
          <Menu anchorEl={menuAnchor} open={menuAnchor !== null} onClose={() => setMenuAnchor(null)}>
            {overflow.map((item) =>
              item.key === 'open' ? (
                <MenuItem key={item.key} component={RouterLink} to={entityPath(node.id)} onClick={() => setMenuAnchor(null)}>
                  {item.label}
                </MenuItem>
              ) : (
                <MenuItem
                  key={item.key}
                  onClick={() => {
                    setMenuAnchor(null);
                    item.run();
                  }}
                >
                  {item.label}
                </MenuItem>
              ),
            )}
          </Menu>
        </>
      )}
    </Box>
  );
}
