/**
 * The inspector's Overview tab (GIC-11, #672).
 *
 * - An ENTITY: its brief, the same cited sections as the entity page (the
 *   stored digest, what changed, decisions, open commitments, risks and claims,
 *   people changes), read with `markViewed: false` — selecting a node on the
 *   canvas is not opening its page, so it never moves "since you last looked".
 * - An ITEM (a commitment, decision or claim): its status and date.
 * - An EDGE: its own props, validity, confidence and its two ends.
 */

import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Link from '@mui/material/Link';
import Skeleton from '@mui/material/Skeleton';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { Link as RouterLink } from 'react-router-dom';

import type { GraphOntology, GraphValidRange } from '../../../../headless/clients/graph.js';
import { useGraphBrief } from '../../../../headless/hooks/useGraphBrief.js';
import { formatPrecisionDate } from '../../../../headless/utils/graphDisplay.js';
import { EntityBriefCard } from '../../EntityBriefCard.js';
import { entityPath } from '../../EntityListRow.js';
import type { EdgeSelection, NodeSelection } from './inspectorModel.js';

/** "2019 – Mar 2026", "Since Sep 2026", "Until 2021", or null when undated. */
export function formatValidity(valid: GraphValidRange | null): string | null {
  if (!valid || (!valid.from && !valid.to)) return null;
  const from = valid.from ? formatPrecisionDate(valid.from, valid.precision) : null;
  const to = valid.to ? formatPrecisionDate(valid.to, valid.precision) : null;
  if (from && to) return `${from} – ${to}`;
  if (from) return `Since ${from}`;
  return `Until ${to}`;
}

/**
 * Props of {@link EntityOverview}.
 *
 * @stability experimental
 */
export interface EntityOverviewProps {
  /** The entity's id. */
  entityId: string;
  /** The ontology, for relation labels. */
  ontology: GraphOntology | null;
}

/**
 * The entity's brief, read without marking the entity viewed.
 *
 * @stability experimental
 */
export function EntityOverview({ entityId, ontology }: EntityOverviewProps) {
  const brief = useGraphBrief(entityId, { markViewed: false });
  if (brief.isLoading) {
    return (
      <Box aria-busy sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
        <Skeleton variant="rounded" height={64} />
        <Skeleton variant="rounded" height={64} />
      </Box>
    );
  }
  if (brief.error || !brief.data) {
    return <Alert severity="error">{brief.error ?? 'Failed to load the brief'}</Alert>;
  }
  return <EntityBriefCard brief={brief.data} ontology={ontology} onRefresh={() => void brief.refresh()} />;
}

/**
 * Props of {@link ItemOverview}.
 *
 * @stability experimental
 */
export interface ItemOverviewProps {
  /** The selected item node. */
  node: NodeSelection;
}

/**
 * What the slice knows about an item node: its type, status and date.
 *
 * @stability experimental
 */
export function ItemOverview({ node }: ItemOverviewProps) {
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
      <Typography variant="body2" sx={{ wordBreak: 'break-word' }}>
        {node.label}
      </Typography>
      {node.status && (
        <Typography variant="body2" color="text.secondary">
          Status: {node.status}
        </Typography>
      )}
      {node.occurredAt && (
        <Typography variant="body2" color="text.secondary">
          {formatPrecisionDate(node.occurredAt, 'day')}
        </Typography>
      )}
      <Typography variant="body2" color="text.secondary">
        {node.degree === 1 ? '1 connection' : `${node.degree} connections`}
      </Typography>
    </Box>
  );
}

/**
 * Props of {@link EdgeOverview}.
 *
 * @stability experimental
 */
export interface EdgeOverviewProps {
  /** The selected edge. */
  edge: EdgeSelection;
  /** Selects one end of the edge. */
  onSelectNode: (id: string) => void;
  /** A coarse pointer. */
  touch: boolean;
}

/**
 * An edge's own props and its two ends: buttons that move the inspector to either end.
 *
 * @stability experimental
 */
export function EdgeOverview({ edge, onSelectNode, touch }: EdgeOverviewProps) {
  const height = touch ? 44 : undefined;
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
      {edge.props.length > 0 && (
        <Box component="dl" sx={{ m: 0 }}>
          {edge.props.map((prop) => (
            <Box key={prop.key} sx={{ display: 'flex', gap: 1 }}>
              <Typography component="dt" variant="body2" color="text.secondary">
                {prop.label}
              </Typography>
              <Typography component="dd" variant="body2" sx={{ m: 0, wordBreak: 'break-word' }}>
                {prop.value}
              </Typography>
            </Box>
          ))}
        </Box>
      )}
      {edge.virtual && (
        <Typography variant="caption" color="text.secondary" component="p">
          Derived from the item itself.
        </Typography>
      )}
      <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', rowGap: 1 }}>
        <Button size="small" variant="outlined" onClick={() => onSelectNode(edge.fromId)} sx={{ minHeight: height }}>
          {edge.fromLabel}
        </Button>
        <Button size="small" variant="outlined" onClick={() => onSelectNode(edge.toId)} sx={{ minHeight: height }}>
          {edge.toLabel}
        </Button>
      </Stack>
      {edge.pageId && (
        <Link component={RouterLink} to={entityPath(edge.pageId)} variant="body2" sx={{ alignSelf: 'flex-start' }}>
          Open {edge.pageLabel}'s page
        </Link>
      )}
    </Box>
  );
}

/** Small chips for an edge's role, stage and stance. */
export function EdgeChips({ chips }: { chips: readonly string[] }) {
  if (chips.length === 0) return null;
  return (
    <Stack direction="row" spacing={0.75} sx={{ flexWrap: 'wrap', rowGap: 0.75 }}>
      {chips.map((chip) => (
        <Chip key={chip} size="small" variant="outlined" label={chip} />
      ))}
    </Stack>
  );
}
