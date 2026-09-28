/**
 * `EntityConnectionsList` — the entity's 1-hop connections, grouped by edge
 * type (#373). #374 mounts its canvas `NeighborhoodWidget` ABOVE this list;
 * this stays the accessible, text-first view of the same slice.
 *
 * `getEntityNeighborhood(id, { hops: 1, limit: 100 })`. Each edge touching the
 * seed is grouped by `(type, direction)`: an outgoing `REPORTS_TO` reads
 * "Reports to", an incoming one "Reports to Joe Rivera" — the stored direction
 * is never inverted (#370), so the label has to say which way it points.
 * A truncated slice links to the explorer, which pages with a hard cap.
 */

import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Link from '@mui/material/Link';
import Skeleton from '@mui/material/Skeleton';
import Typography from '@mui/material/Typography';
import visuallyHidden from '@mui/utils/visuallyHidden';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';

import { graphErrorMessage, isAbortError } from '../../hooks/graphHookUtils';
import { getEntityNeighborhood } from '../../services/graph';
import type { GraphNode, GraphOntology, GraphSlice } from '../../services/graph';
import { relationPropsDisplay, relationTypeLabel } from '../../utils/graphDisplay';
import type { RelationPropDisplay } from '../../utils/graphDisplay';
import { entityPath } from './EntityListRow';

export const CONNECTIONS_LIMIT = 100;

export interface EntityConnectionsListProps {
  entityId: string;
  entityLabel: string;
  ontology: GraphOntology | null;
}

/**
 * One row: the other end of an edge plus that edge's own props (#442), e.g.
 * EY with Role "Managing Director", Business unit "Consulting". The same node
 * appears twice in a group only when two edges to it carry different props
 * (two roles at one organization are two facts).
 */
export interface ConnectionEntry {
  key: string;
  node: GraphNode;
  props: RelationPropDisplay[];
}

export interface ConnectionGroup {
  key: string;
  title: string;
  entries: ConnectionEntry[];
}

/** Pure grouping, exported for its own test. */
export function groupConnections(
  slice: GraphSlice,
  seedId: string,
  seedLabel: string,
  ontology: GraphOntology | null,
): ConnectionGroup[] {
  const nodes = new Map(slice.nodes.map((node) => [node.id, node]));
  const groups = new Map<string, ConnectionGroup>();
  for (const edge of slice.edges) {
    const outgoing = edge.source === seedId;
    if (!outgoing && edge.target !== seedId) continue;
    const other = nodes.get(outgoing ? edge.target : edge.source);
    if (!other) continue;
    const key = `${edge.type}:${outgoing ? 'out' : 'in'}`;
    const label = relationTypeLabel(edge.type, ontology);
    const group =
      groups.get(key) ??
      { key, title: outgoing ? label : `${label} ${seedLabel}`, entries: [] };
    const props = relationPropsDisplay(edge.type, edge.props, ontology);
    const entryKey = `${other.id}|${props.map((prop) => `${prop.key}=${prop.value}`).join('|')}`;
    if (!group.entries.some((entry) => entry.key === entryKey)) {
      group.entries.push({ key: entryKey, node: other, props });
    }
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => a.title.localeCompare(b.title));
}

export function EntityConnectionsList({ entityId, entityLabel, ontology }: EntityConnectionsListProps) {
  const [slice, setSlice] = useState<GraphSlice | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    getEntityNeighborhood(entityId, { hops: 1, limit: CONNECTIONS_LIMIT }, controller.signal)
      .then((next) => {
        if (!controller.signal.aborted) setSlice(next);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted || isAbortError(err)) return;
        setError(graphErrorMessage(err, 'Failed to load connections'));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [entityId, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  const groups = useMemo(
    () => (slice ? groupConnections(slice, entityId, entityLabel, ontology) : []),
    [entityId, entityLabel, ontology, slice],
  );

  return (
    <Box component="section" aria-labelledby="entity-connections-title" sx={{ mb: 3 }}>
      <Typography id="entity-connections-title" variant="h6" component="h2" sx={{ fontWeight: 600, mb: 1 }}>
        Connections
      </Typography>
      {loading ? (
        <Box aria-busy="true" aria-label="Loading connections" role="status">
          <Skeleton width="50%" />
          <Skeleton width="70%" />
        </Box>
      ) : error ? (
        <Alert
          severity="error"
          action={
            <Button color="inherit" size="small" onClick={retry}>
              Retry
            </Button>
          }
        >
          {error}
        </Alert>
      ) : groups.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          No connections yet.
        </Typography>
      ) : (
        <>
          {groups.map((group) => (
            <Box key={group.key} sx={{ mb: 1.5 }}>
              <Typography variant="subtitle2" component="h3">
                {group.title}
              </Typography>
              <Box component="ul" sx={{ m: 0, pl: 2.5 }}>
                {group.entries.map(({ key, node, props }) => (
                  <Typography component="li" variant="body2" key={key}>
                    {node.nodeKind === 'entity' ? (
                      <Link component={RouterLink} to={entityPath(node.id)}>
                        {node.label}
                      </Link>
                    ) : (
                      node.label
                    )}
                    <ConnectionProps props={props} />
                  </Typography>
                ))}
              </Box>
            </Box>
          ))}
          {slice?.truncated && (
            <Typography variant="body2">
              Showing {CONNECTIONS_LIMIT} of many —{' '}
              <Link component={RouterLink} to={`/graph/explore?seed=${encodeURIComponent(entityId)}`}>
                open in Explorer
              </Link>
            </Typography>
          )}
        </>
      )}
    </Box>
  );
}

/**
 * The edge's props after the other entity: " — Managing Director · Consulting"
 * visibly (values only, the row stays short), and "Role: Managing Director,
 * Business unit: Consulting" for a screen reader and as the hover title, so
 * the ontology labels are never lost. Nothing when the edge has none.
 */
export function ConnectionProps({ props }: { props: RelationPropDisplay[] }) {
  if (props.length === 0) return null;
  const spoken = props.map((prop) => `${prop.label}: ${prop.value}`).join(', ');
  return (
    <Box component="span" title={spoken} data-testid="connection-props">
      <Box component="span" aria-hidden="true" sx={{ color: 'text.secondary' }}>
        {' — '}
        {props.map((prop) => prop.value).join(' · ')}
      </Box>
      <Box component="span" sx={visuallyHidden}>
        {`, ${spoken}`}
      </Box>
    </Box>
  );
}

export default EntityConnectionsList;
