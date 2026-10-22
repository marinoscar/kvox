/**
 * `InsightsPanel` — what deserves a look in the graph (GIC-16, #677; epic
 * #661): Themes, Connectors, Rising, Fading ties and Open risks, each a
 * collapsible section of tappable items.
 *
 * It lives in the explorer's facets slot, so it is the left pane on an expanded
 * window, the popover of the rail on a medium one and the drawer on a compact
 * one, with no window-class logic of its own. Every item seeds the canvas
 * (`onSelect`): a theme with its members, a connector with the groups it joins
 * (ringed), a rising entity or a risk by itself, a fading tie with both ends.
 *
 * Copy is plain language, written by the server (`reason`); no raw score is ever
 * shown. A stale or pending snapshot is said once, above the sections, with a
 * Refresh for writers; an empty section says why.
 *
 * Targets are 44px on a touch input. The window (30 days, 90 days, a year) is a
 * toggle group; collapsed sections are remembered in `localStorage` when it
 * works and in memory when it does not.
 */

import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import ButtonBase from '@mui/material/ButtonBase';
import Chip from '@mui/material/Chip';
import Collapse from '@mui/material/Collapse';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemText from '@mui/material/ListItemText';
import Skeleton from '@mui/material/Skeleton';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Typography from '@mui/material/Typography';
import { useCallback, useId, useState, type ReactNode } from 'react';

import { useHasPermission, useKvoxHost } from '../../../../../core/headless/index.js';
import { refreshGraphOverview, type GraphInsights, type GraphInsightsWindow } from '../../../../headless/clients/graph.js';
import { useGraphInsights } from '../../../../headless/hooks/useGraphInsights.js';
import { graphErrorMessage } from '../../../../headless/hooks/graphHookUtils.js';
import { EntityTypeIcon } from '../../entityTypeIcon.js';
import { useInputModality, type InputModality } from '../shell/useInputModality.js';
import {
  INSIGHT_SECTIONS,
  INSIGHT_SECTION_HINTS,
  INSIGHT_SECTION_TITLES,
  INSIGHT_WINDOWS,
  connectorSeeds,
  emptyText,
  entitySeeds,
  riskLine,
  riskSeeds,
  sectionCount,
  snapshotNotice,
  themeSeeds,
  tieSeeds,
  type InsightSectionKey,
  type InsightSeeds,
} from './insightsModel.js';

const COLLAPSED_KEY = 'kvox:graph:insights:collapsed';

function readCollapsed(): InsightSectionKey[] {
  try {
    const raw = window.localStorage.getItem(COLLAPSED_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((k): k is InsightSectionKey => INSIGHT_SECTIONS.includes(k as InsightSectionKey)) : [];
  } catch {
    return [];
  }
}

function writeCollapsed(keys: InsightSectionKey[]): void {
  try {
    window.localStorage.setItem(COLLAPSED_KEY, JSON.stringify(keys));
  } catch {
    // Storage may be blocked or full: the choice then lasts until the page closes.
  }
}

/**
 * Props of {@link InsightsPanel}.
 *
 * @stability experimental
 */
export interface InsightsPanelProps {
  /**
   * Called when an item is tapped: start the canvas from `seeds.seedIds`, select and fly to
   * `seeds.focusId` once drawn, ring `seeds.markIds`. `announce` is a short sentence for a live region.
   */
  onSelect: (seeds: InsightSeeds, announce: string) => void;
  /** Reads an entity type key as a label. Default: the key. */
  typeLabel?: (key: string) => string;
  /** Overrides the detected input modality (tests, previews). */
  inputModality?: InputModality;
  /** The window to open with. Default `30d`. */
  initialWindow?: GraphInsightsWindow;
}

/**
 * The Insights panel of the explorer's facets.
 *
 * @stability experimental
 */
export function InsightsPanel({ onSelect, typeLabel = (key) => key, inputModality, initialWindow = '30d' }: InsightsPanelProps) {
  const detected = useInputModality();
  const touch = (inputModality ?? detected) === 'touch';
  const host = useKvoxHost();
  const canWrite = useHasPermission('graph:write');
  const [lookback, setLookback] = useState<GraphInsightsWindow>(initialWindow);
  const { insights, isLoading, error, refresh } = useGraphInsights(lookback);
  const [collapsed, setCollapsed] = useState<InsightSectionKey[]>(readCollapsed);
  const [requesting, setRequesting] = useState(false);
  const [requestError, setRequestError] = useState<string | null>(null);
  const baseId = useId();

  const toggle = useCallback((key: InsightSectionKey) => {
    setCollapsed((current) => {
      const next = current.includes(key) ? current.filter((k) => k !== key) : [...current, key];
      writeCollapsed(next);
      return next;
    });
  }, []);

  const requestRefresh = useCallback(async () => {
    setRequesting(true);
    setRequestError(null);
    try {
      await refreshGraphOverview(host);
      await refresh();
    } catch (err) {
      setRequestError(graphErrorMessage(err, 'Could not refresh the overview'));
    } finally {
      setRequesting(false);
    }
  }, [host, refresh]);

  const notice = snapshotNotice(insights);
  const rowSx = { minHeight: touch ? 44 : 36, alignItems: 'flex-start', py: touch ? 0.75 : 0.25, borderRadius: 1 } as const;

  const tap = (seeds: InsightSeeds, announce: string) => () => onSelect(seeds, announce);

  const renderSection = (key: InsightSectionKey, data: GraphInsights): ReactNode => {
    switch (key) {
      case 'themes':
        return data.themes.map((theme) => (
          <ListItem key={theme.clusterId} disablePadding>
            <ListItemButton sx={rowSx} onClick={tap(themeSeeds(theme), `Showing the ${theme.label} theme`)}>
              <ListItemText
                primary={theme.label}
                secondary={`${theme.size === 1 ? '1 thing' : `${theme.size.toLocaleString('en-US')} things`}: ${
                  Object.entries(theme.typeCounts)
                    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
                    .slice(0, 3)
                    .map(([type, count]) => `${typeLabel(type)} ${count}`)
                    .join(', ')
                }`}
                slotProps={{ primary: { noWrap: true } }}
              />
            </ListItemButton>
          </ListItem>
        ));
      case 'connectors':
        return data.connectors.map((connector) => (
          <ListItem key={connector.entity.id} disablePadding>
            <ListItemButton
              sx={rowSx}
              onClick={tap(connectorSeeds(connector, data.themes), `Showing ${connector.entity.label} and the groups it connects`)}
            >
              <EntityTypeIcon type={connector.entity.type} fontSize="small" sx={{ mr: 1, mt: 0.5, color: 'text.secondary' }} aria-hidden />
              <ListItemText primary={connector.entity.label} secondary={connector.reason} slotProps={{ primary: { noWrap: true } }} />
            </ListItemButton>
          </ListItem>
        ));
      case 'rising':
        return data.rising.map((item) => (
          <ListItem key={item.entity.id} disablePadding>
            <ListItemButton sx={rowSx} onClick={tap(entitySeeds(item.entity.id), `Opening ${item.entity.label}`)}>
              <EntityTypeIcon type={item.entity.type} fontSize="small" sx={{ mr: 1, mt: 0.5, color: 'text.secondary' }} aria-hidden />
              <ListItemText primary={item.entity.label} secondary={item.reason} slotProps={{ primary: { noWrap: true } }} />
            </ListItemButton>
          </ListItem>
        ));
      case 'fadingTies':
        return data.fadingTies.map((tie) => (
          <ListItem key={`${tie.from.id}-${tie.to.id}`} disablePadding>
            <ListItemButton sx={rowSx} onClick={tap(tieSeeds(tie), `Showing ${tie.from.label} and ${tie.to.label}`)}>
              <ListItemText primary={`${tie.from.label} and ${tie.to.label}`} secondary={tie.reason} />
            </ListItemButton>
          </ListItem>
        ));
      case 'openRisks':
        return data.openRisks.map((risk) => (
          <ListItem key={risk.id} disablePadding>
            <ListItemButton sx={rowSx} onClick={tap(riskSeeds(risk), 'Opening the risk')}>
              <ListItemText
                primary={riskLine(risk)}
                secondary={risk.subject ? `On ${risk.subject.label}` : undefined}
                slotProps={{ primary: { sx: { display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' } } }}
              />
              {risk.severity && (
                <Chip
                  size="small"
                  variant="outlined"
                  color={risk.severity === 'high' ? 'error' : risk.severity === 'medium' ? 'warning' : 'default'}
                  label={risk.severity === 'high' ? 'High' : risk.severity === 'medium' ? 'Medium' : 'Low'}
                  sx={{ ml: 1, mt: 0.5, flexShrink: 0 }}
                />
              )}
            </ListItemButton>
          </ListItem>
        ));
    }
  };

  return (
    <Box component="section" aria-label="Insights" sx={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1, flexWrap: 'wrap' }}>
        <Typography variant="subtitle2" component="h2">
          Insights
        </Typography>
        <ToggleButtonGroup
          exclusive
          size="small"
          value={lookback}
          onChange={(_event, next: GraphInsightsWindow | null) => next && setLookback(next)}
          aria-label="Look back over"
        >
          {INSIGHT_WINDOWS.map((w) => (
            <ToggleButton key={w.key} value={w.key} sx={{ minHeight: touch ? 44 : 30, minWidth: touch ? 44 : undefined, textTransform: 'none', px: 1 }}>
              {w.label}
            </ToggleButton>
          ))}
        </ToggleButtonGroup>
      </Box>

      {error && !insights && <Alert severity="error">{error}</Alert>}
      {error && insights && <Alert severity="warning">{error}</Alert>}
      {requestError && <Alert severity="error">{requestError}</Alert>}
      {notice && (
        <Alert
          severity="info"
          action={
            insights?.stale && !insights.pending && canWrite ? (
              <Button color="inherit" size="small" onClick={() => void requestRefresh()} disabled={requesting} sx={{ minHeight: touch ? 44 : undefined }}>
                Refresh
              </Button>
            ) : undefined
          }
        >
          {notice}
        </Alert>
      )}

      {isLoading && !insights ? (
        <Box aria-hidden sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
          <Skeleton variant="rounded" height={44} />
          <Skeleton variant="rounded" height={44} />
          <Skeleton variant="rounded" height={44} />
        </Box>
      ) : (
        INSIGHT_SECTIONS.map((key) => {
          const open = !collapsed.includes(key);
          const count = sectionCount(key, insights);
          const panelId = `${baseId}-${key}`;
          return (
            <Box key={key} component="section" aria-labelledby={`${panelId}-h`}>
              <Typography id={`${panelId}-h`} variant="subtitle2" component="h3" sx={{ m: 0 }}>
                <ButtonBase
                  onClick={() => toggle(key)}
                  aria-expanded={open}
                  aria-controls={panelId}
                  sx={{ width: '100%', minHeight: touch ? 44 : 32, justifyContent: 'space-between', textAlign: 'left', px: 0.5, borderRadius: 1, font: 'inherit' }}
                >
                  <span>
                    {INSIGHT_SECTION_TITLES[key]}
                    {count > 0 && (
                      <Typography component="span" variant="caption" color="text.secondary" sx={{ ml: 0.75 }}>
                        {count}
                      </Typography>
                    )}
                  </span>
                  {open ? <ExpandLessIcon fontSize="small" aria-hidden /> : <ExpandMoreIcon fontSize="small" aria-hidden />}
                </ButtonBase>
              </Typography>
              <Collapse in={open} unmountOnExit>
                <Box id={panelId}>
                  {insights && count > 0 ? (
                    <List dense disablePadding aria-label={INSIGHT_SECTION_TITLES[key]}>
                      {renderSection(key, insights)}
                    </List>
                  ) : (
                    <Typography variant="body2" color="text.secondary" sx={{ px: 0.5, py: 0.5 }}>
                      {insights ? emptyText(key, insights) : INSIGHT_SECTION_HINTS[key]}
                    </Typography>
                  )}
                </Box>
              </Collapse>
            </Box>
          );
        })
      )}
    </Box>
  );
}
