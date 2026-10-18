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
 *
 * MANUAL RELATION EDITS (#586). With `canEdit` on a Person, the section offers
 * "Set manager", "Set employer" and "Add role" (`EntityRelationDialog`), and
 * each outgoing stored `REPORTS_TO` / `WORKS_FOR` / `HAS_ROLE` row a "Remove"
 * button named "Remove <group> <label>" (e.g. "Remove Reports to Mark Chen")
 * that asks first, then retracts the relation as wrong. Either reloads the
 * list and calls `onChanged`.
 */

import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogTitle from '@mui/material/DialogTitle';
import IconButton from '@mui/material/IconButton';
import Link from '@mui/material/Link';
import Stack from '@mui/material/Stack';
import CloseIcon from '@mui/icons-material/Close';
import Skeleton from '@mui/material/Skeleton';
import Typography from '@mui/material/Typography';
import { visuallyHidden } from '../visuallyHidden.js';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';

import { graphErrorMessage, isAbortError } from '../../headless/hooks/graphHookUtils.js';
import { MANUAL_RELATION_TYPES, getEntityNeighborhood } from '../../headless/clients/graph.js';
import type { GraphNode, GraphOntology, GraphSlice, ManualRelationType, SetEntityRelationResult } from '../../headless/clients/graph.js';
import { useEntityRelationEdits } from '../../headless/hooks/useEntityRelationEdits.js';
import { ENTITY_RELATION_EDITS, EntityRelationDialog } from './EntityRelationDialog.js';
import { relationPropsDisplay, relationTypeLabel } from '../../headless/utils/graphDisplay.js';
import type { RelationPropDisplay } from '../../headless/utils/graphDisplay.js';
import { entityPath } from './EntityListRow.js';

import { useKvoxHost } from '../../../core/headless/index.js';
export const CONNECTIONS_LIMIT = 100;

/**
 * The props of {@link EntityConnectionsList}.
 *
 * @stability experimental
 */
export interface EntityConnectionsListProps {
  /** The entity whose 1-hop connections to list. */
  entityId: string;
  /** Its label (the title of an incoming group: "Reports to Joe Rivera"). */
  entityLabel: string;
  /** The effective ontology, for relation labels; `null` while it loads. */
  ontology: GraphOntology | null;
  /** The entity's type key; the manual relation edits are offered on a `Person` only. */
  entityType?: string;
  /** The caller holds `graph:write`: offer the manual relation edits (#586). */
  canEdit?: boolean;
  /** Called after a manual relation edit saved (the page refreshes what else shows it). */
  onChanged?: () => void;
}

const MANUAL_TYPES: ReadonlySet<string> = new Set(MANUAL_RELATION_TYPES);

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
  /** A stored outgoing manager/employer/role relation a manual edit may remove; otherwise `null`. */
  relationId: string | null;
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
      const removable = outgoing && !edge.virtual && MANUAL_TYPES.has(edge.type);
      group.entries.push({ key: entryKey, node: other, props, relationId: removable ? edge.id : null });
    }
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => a.title.localeCompare(b.title));
}

/**
 * The entity page's text list of connections, with the manual relation edits on a Person (#586).
 *
 * @param props - See {@link EntityConnectionsListProps}.
 * @returns The section.
 *
 * @stability experimental
 */
export function EntityConnectionsList({
  entityId,
  entityLabel,
  ontology,
  entityType,
  canEdit = false,
  onChanged,
}: EntityConnectionsListProps) {
  const host = useKvoxHost();
  const editable = canEdit && entityType === 'Person';
  const [editing, setEditing] = useState<ManualRelationType | null>(null);
  const [removing, setRemoving] = useState<{ relationId: string; name: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const edits = useEntityRelationEdits(entityId);
  const [slice, setSlice] = useState<GraphSlice | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    getEntityNeighborhood(host, entityId, { hops: 1, limit: CONNECTIONS_LIMIT }, controller.signal)
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

  const saved = useCallback(
    (result: SetEntityRelationResult) => {
      setEditing(null);
      setNotice(
        result.flags.includes('unordered')
          ? 'Saved. An undated connection of the same kind is still listed; remove it if it is wrong.'
          : 'Saved.',
      );
      setAttempt((n) => n + 1);
      onChanged?.();
    },
    [onChanged],
  );

  const confirmRemove = useCallback(async () => {
    if (!removing) return;
    const result = await edits.removeRelation(removing.relationId);
    if (!result) return;
    setRemoving(null);
    setNotice('Removed.');
    setAttempt((n) => n + 1);
    onChanged?.();
  }, [edits, onChanged, removing]);

  const groups = useMemo(
    () => (slice ? groupConnections(slice, entityId, entityLabel, ontology) : []),
    [entityId, entityLabel, ontology, slice],
  );

  return (
    <Box component="section" aria-labelledby="entity-connections-title" sx={{ mb: 3 }}>
      <Typography id="entity-connections-title" variant="h6" component="h2" sx={{ fontWeight: 600, mb: 1 }}>
        Connections
      </Typography>
      {editable && (
        <Stack direction="row" spacing={1} useFlexGap sx={{ mb: 1.5, flexWrap: 'wrap' }}>
          {MANUAL_RELATION_TYPES.map((type) => (
            <Button key={type} size="small" variant="outlined" onClick={() => setEditing(type)}>
              {ENTITY_RELATION_EDITS[type].action}
            </Button>
          ))}
        </Stack>
      )}
      {notice && (
        <Alert severity="success" role="status" onClose={() => setNotice(null)} sx={{ mb: 1.5 }}>
          {notice}
        </Alert>
      )}
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
                {group.entries.map(({ key, node, props, relationId }) => (
                  <Typography component="li" variant="body2" key={key}>
                    {node.nodeKind === 'entity' ? (
                      <Link component={RouterLink} to={entityPath(node.id)}>
                        {node.label}
                      </Link>
                    ) : (
                      node.label
                    )}
                    <ConnectionProps props={props} />
                    {editable && relationId && (
                      <IconButton
                        size="small"
                        aria-label={`Remove ${group.title} ${node.label}`}
                        onClick={() => {
                          edits.clearError();
                          setRemoving({ relationId, name: `${group.title} ${node.label}` });
                        }}
                        sx={{ ml: 0.5 }}
                      >
                        <CloseIcon fontSize="inherit" />
                      </IconButton>
                    )}
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
      {editable && editing && (
        <EntityRelationDialog
          open
          entityId={entityId}
          type={editing}
          onClose={() => setEditing(null)}
          onSaved={saved}
        />
      )}
      {editable && (
        <Dialog open={removing !== null} onClose={edits.isSaving ? undefined : () => setRemoving(null)} aria-labelledby="entity-relation-remove-title">
          <DialogTitle id="entity-relation-remove-title">Remove this connection?</DialogTitle>
          <DialogContent>
            {edits.error && (
              <Alert severity="error" sx={{ mb: 1 }}>
                {edits.error}
              </Alert>
            )}
            <DialogContentText>
              {removing?.name}: remove it as wrong. It stops showing here and in answers. To record that it ended, set the next one instead.
            </DialogContentText>
          </DialogContent>
          <DialogActions>
            <Button onClick={() => setRemoving(null)} disabled={edits.isSaving}>
              Cancel
            </Button>
            <Button color="error" variant="contained" onClick={() => void confirmRemove()} disabled={edits.isSaving}>
              Remove
            </Button>
          </DialogActions>
        </Dialog>
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

