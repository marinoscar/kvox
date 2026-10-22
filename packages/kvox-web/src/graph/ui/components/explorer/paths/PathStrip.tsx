/**
 * `PathStrip` — the ranked paths between two things, read as a story with
 * receipts (GIC-13, #674; epic #661).
 *
 * A segmented control picks Path 1, 2 or 3 ("strong / moderate / weak
 * evidence" from the API's score). The chosen path is an ordered list:
 * node chip, edge connector, node chip, ... Each connector names the relation
 * with its role, stage and stance chips and the number of sources, and sits
 * above the top quote of that edge (one line, with its source and date as a
 * link). "N more" and the connector itself open that edge in the inspector,
 * where the Evidence tab lists every citation.
 *
 * ORIENTATION. `horizontal` (tablet, desktop) scrolls sideways with
 * scroll-snap; `vertical` (phone) stacks the hops top to bottom. The shell
 * decides which; this component draws what it is told.
 *
 * KEYBOARD AND SCREEN READER. Tab walks the connectors (and each quote's source
 * link) in order; Enter on a connector opens the edge. Each connector's name is
 * the hop as a sentence ("Joe, involved in as stakeholder, skeptical, Copilot
 * rollout"), and the list's name is the whole path.
 */

import ArrowDownwardIcon from '@mui/icons-material/ArrowDownward';
import ArrowForwardIcon from '@mui/icons-material/ArrowForward';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Link from '@mui/material/Link';
import Skeleton from '@mui/material/Skeleton';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Typography from '@mui/material/Typography';
import { Link as RouterLink } from 'react-router-dom';

import { formatPrecisionDate } from '../../../../headless/utils/graphDisplay.js';
import type { ExplorerMode } from '../explorerEncoding.js';
import { evidenceSourceTitle } from '../inspector/EvidenceCard.js';
import { TypeGlyph } from '../inspector/TypeGlyph.js';
import { describePath, hopSentence, strengthLabel, type PathHopView, type PathView } from './pathModel.js';
import type { HopQuote } from './useHopQuotes.js';

/**
 * Props of {@link PathStrip}.
 *
 * @stability experimental
 */
export interface PathStripProps {
  /** The ranked paths, best first. */
  paths: readonly PathView[];
  /** Which one is shown (an index into `paths`). */
  activeIndex: number;
  /** Called when another path is picked. */
  onActiveChange: (index: number) => void;
  /** `vertical` on a phone, `horizontal` elsewhere. */
  orientation: 'horizontal' | 'vertical';
  /** The top quote of each hop, by edge id. */
  quotes: ReadonlyMap<string, HopQuote>;
  /** Light or dark, for the node glyphs. */
  mode: ExplorerMode;
  /** A coarse pointer: controls are at least 44px tall. */
  touch: boolean;
  /** Opens an edge in the inspector, on its Evidence tab. */
  onOpenEdge: (edgeId: string) => void;
}

function QuoteLine({ hop, quote, touch, onOpenEdge }: { hop: PathHopView; quote: HopQuote | undefined; touch: boolean; onOpenEdge: (edgeId: string) => void }) {
  if (!quote || quote.status === 'loading') {
    return <Skeleton variant="text" width="90%" aria-label="Loading the quote" />;
  }
  if (quote.status === 'error') {
    return (
      <Typography variant="caption" color="text.secondary">
        The quote could not be loaded.
      </Typography>
    );
  }
  const { link } = quote;
  if (!link) {
    return (
      <Typography variant="caption" color="text.secondary">
        No quote on record for this connection.
      </Typography>
    );
  }
  const title = evidenceSourceTitle(link);
  const date = formatPrecisionDate(link.createdAt, 'day');
  const href = link.source.available ? link.source.href : null;
  const more = Math.max(hop.evidenceCount, 1) - 1;
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.25, minWidth: 0 }}>
      <Typography
        variant="body2"
        component="blockquote"
        title={link.quote}
        sx={{ m: 0, pl: 1, borderLeft: 3, borderColor: 'primary.main', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
      >
        “{link.quote}”
      </Typography>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, flexWrap: 'wrap', minWidth: 0 }}>
        {href ? (
          <Link
            component={RouterLink}
            to={href}
            variant="caption"
            underline="hover"
            aria-label={`Open at source: ${title}, ${date}`}
            sx={{ display: 'inline-flex', alignItems: 'center', minHeight: touch ? 44 : undefined, maxWidth: '100%' }}
          >
            <Box component="span" sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {title}
            </Box>
            <Box component="span" sx={{ flexShrink: 0 }}>
              &nbsp;· {date}
            </Box>
          </Link>
        ) : (
          <Typography variant="caption" color="text.secondary" noWrap>
            {title} · {date}
          </Typography>
        )}
        {more > 0 && (
          <Button
            size="small"
            onClick={() => onOpenEdge(hop.edgeId)}
            aria-label={`${more} more ${more === 1 ? 'source' : 'sources'} for this connection`}
            sx={{ minWidth: 0, minHeight: touch ? 44 : undefined, textTransform: 'none', py: 0 }}
          >
            {more} more
          </Button>
        )}
      </Box>
    </Box>
  );
}

function NodePill({ label, type, mode }: { label: string; type: string; mode: ExplorerMode }) {
  return (
    <Box
      sx={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 0.75,
        maxWidth: { xs: '100%', sm: 200 },
        px: 1,
        py: 0.5,
        border: 1,
        borderColor: 'divider',
        borderRadius: 4,
        bgcolor: 'background.paper',
      }}
    >
      <TypeGlyph type={type} mode={mode} size={22} />
      <Typography variant="body2" noWrap sx={{ fontWeight: 600 }}>
        {label}
      </Typography>
    </Box>
  );
}

/**
 * The ranked paths as a segmented control and the chosen path's chain of nodes, edges and quotes.
 *
 * @stability experimental
 */
export function PathStrip(props: PathStripProps) {
  const { paths, activeIndex, onActiveChange, orientation, quotes, mode, touch, onOpenEdge } = props;
  const path = paths[Math.min(activeIndex, paths.length - 1)];
  if (!path) return null;
  const vertical = orientation === 'vertical';
  const Arrow = vertical ? ArrowDownwardIcon : ArrowForwardIcon;

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 }}>
      <ToggleButtonGroup
        exclusive
        size="small"
        value={path.index}
        aria-label="Paths, best first"
        onChange={(_event, value: number | null) => {
          if (value !== null) onActiveChange(paths.findIndex((candidate) => candidate.index === value));
        }}
        sx={{ flexWrap: 'wrap' }}
      >
        {paths.map((candidate) => (
          <ToggleButton
            key={candidate.index}
            value={candidate.index}
            aria-label={`Path ${candidate.index + 1}, ${strengthLabel(candidate.strength)}`}
            sx={{ textTransform: 'none', px: 1.5, minHeight: touch ? 44 : undefined, flexDirection: 'column', lineHeight: 1.2 }}
          >
            <span>Path {candidate.index + 1}</span>
            <Typography variant="caption" component="span" color="text.secondary">
              {strengthLabel(candidate.strength)}
            </Typography>
          </ToggleButton>
        ))}
      </ToggleButtonGroup>

      <Box
        component="ol"
        aria-label={describePath(path)}
        data-orientation={orientation}
        sx={{
          listStyle: 'none',
          m: 0,
          p: 0,
          display: 'flex',
          flexDirection: vertical ? 'column' : 'row',
          alignItems: vertical ? 'stretch' : 'flex-start',
          gap: 1,
          minWidth: 0,
          ...(vertical
            ? {}
            : { overflowX: 'auto', scrollSnapType: 'x proximity', pb: 1 }),
        }}
      >
        {path.nodes.map((node, index) => {
          const hop = path.hops[index];
          return (
            <Box
              key={node.id}
              component="li"
              sx={{ display: 'contents' }}
            >
              <Box
                sx={{
                  flex: 'none',
                  scrollSnapAlign: 'start',
                  display: 'flex',
                  alignItems: vertical ? 'flex-start' : 'center',
                  alignSelf: vertical ? 'flex-start' : 'center',
                  minWidth: 0,
                  maxWidth: '100%',
                }}
              >
                <NodePill label={node.label} type={node.type} mode={mode} />
              </Box>
              {hop && (
                <Box
                  sx={{
                    flex: 'none',
                    scrollSnapAlign: 'start',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 0.5,
                    p: 1,
                    border: 1,
                    borderColor: 'divider',
                    borderRadius: 1.5,
                    bgcolor: 'background.default',
                    width: vertical ? 'auto' : 260,
                    minWidth: 0,
                  }}
                >
                  <Button
                    onClick={() => onOpenEdge(hop.edgeId)}
                    aria-label={`${hopSentence(path, index)}. Open this connection in the inspector.`}
                    sx={{
                      justifyContent: 'flex-start',
                      textAlign: 'left',
                      textTransform: 'none',
                      minHeight: touch ? 44 : undefined,
                      alignItems: 'flex-start',
                      gap: 0.75,
                      px: 0.5,
                      color: 'text.primary',
                    }}
                  >
                    <Arrow
                      fontSize="small"
                      aria-hidden
                      sx={{ mt: 0.25, flexShrink: 0, transform: hop.reversed && !vertical ? 'scaleX(-1)' : hop.reversed ? 'scaleY(-1)' : undefined }}
                    />
                    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5, minWidth: 0 }}>
                      <Typography variant="body2" sx={{ fontWeight: 600 }}>
                        {hop.relationLabel}
                        {hop.evidenceCount > 0 && (
                          <Typography component="span" variant="caption" color="text.secondary">
                            {' '}
                            · {hop.evidenceCount} {hop.evidenceCount === 1 ? 'source' : 'sources'}
                          </Typography>
                        )}
                      </Typography>
                      {hop.chips.length > 0 && (
                        <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap' }}>
                          {hop.chips.map((chip) => (
                            <Chip key={chip} size="small" variant="outlined" label={chip} />
                          ))}
                        </Box>
                      )}
                    </Box>
                  </Button>
                  <QuoteLine hop={hop} quote={quotes.get(hop.edgeId)} touch={touch} onOpenEdge={onOpenEdge} />
                </Box>
              )}
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}
