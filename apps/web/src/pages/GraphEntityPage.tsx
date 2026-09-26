/**
 * `/graph/entities/:id` — "everything about Joe" (#373, epic #347; spec §13).
 *
 * ONE SCROLLING COLUMN (`maxWidth: 960`), sections in a fixed order:
 *
 *   1. `EntityHeader` — type, the page's <h1>, aliases, dates, counts, Edit and
 *      (Person + `graph:write`) "Forget this person…".
 *   2. `EntityBriefCard` — the stored digest + the five cited sections (#372).
 *   3. Connections — a text list today; #374 mounts its canvas above it.
 *   4. Timeline — with the opt-in sensitive-facts switch.
 *   5. Mentions.
 *
 * NOT TABS: these are one destination's sequential sections, not parallel
 * content (Settings UI Pattern rule 2's reasoning), and a scrolling page keeps
 * every one reachable on a phone.
 *
 * A 404 is its own state with no Retry and no hint of WHY — the API answers
 * "not yours" and "doesn't exist" identically (#370), and so does this page.
 */

import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Paper from '@mui/material/Paper';
import Skeleton from '@mui/material/Skeleton';
import Typography from '@mui/material/Typography';
import { useState } from 'react';
import { Link as RouterLink, useNavigate, useParams } from 'react-router-dom';

import { EntityBriefCard } from '../components/graph/EntityBriefCard';
import { EntityConnectionsList } from '../components/graph/EntityConnectionsList';
import { EntityEditDialog } from '../components/graph/EntityEditDialog';
import { EntityHeader } from '../components/graph/EntityHeader';
import { EntityMentionsList } from '../components/graph/EntityMentionsList';
import { EntityPageSkeleton } from '../components/graph/EntityPageSkeleton';
import { EntityTimeline } from '../components/graph/EntityTimeline';
import { ForgetPersonDialog } from '../components/graph/ForgetPersonDialog';
import { GRAPH_NOT_FOUND_MESSAGE } from '../hooks/graphHookUtils';
import { useGraphBrief } from '../hooks/useGraphBrief';
import { useGraphEntity } from '../hooks/useGraphEntity';
import { useGraphOntology } from '../hooks/useGraphAttributeDefs';
import { usePermissions } from '../hooks/usePermissions';
import { entityTypeLabel } from '../utils/graphDisplay';
import type { GraphIndexLocationState } from './GraphIndexPage';

export default function GraphEntityPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { hasPermission } = usePermissions();
  const canWrite = hasPermission('graph:write');

  const entity = useGraphEntity(id);
  const brief = useGraphBrief(id);
  const { ontology } = useGraphOntology();

  const [editOpen, setEditOpen] = useState(false);
  const [forgetOpen, setForgetOpen] = useState(false);

  let content;
  if (entity.isLoading) {
    content = <EntityPageSkeleton />;
  } else if (entity.notFound) {
    content = (
      <Paper variant="outlined" sx={{ p: 3, textAlign: 'center' }}>
        <Typography variant="h5" component="h1" gutterBottom>
          Not found
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          {GRAPH_NOT_FOUND_MESSAGE}.
        </Typography>
        <Button component={RouterLink} to="/graph" variant="contained">
          Back to Knowledge
        </Button>
      </Paper>
    );
  } else if (!entity.data) {
    content = (
      <>
        <Typography variant="h5" component="h1" sx={{ mb: 2 }}>
          Knowledge
        </Typography>
        <Alert
          severity="error"
          action={
            <Button color="inherit" size="small" onClick={() => void entity.refresh()}>
              Retry
            </Button>
          }
        >
          {entity.error ?? 'Failed to load this page'}
        </Alert>
      </>
    );
  } else {
    const detail = entity.data;
    content = (
      <>
        <EntityHeader
          entity={detail}
          typeLabel={entityTypeLabel(detail.type, ontology)}
          canEdit={canWrite}
          onEdit={() => setEditOpen(true)}
          onForget={() => setForgetOpen(true)}
        />

        {brief.data ? (
          <EntityBriefCard brief={brief.data} ontology={ontology} onRefresh={() => void brief.refresh()} />
        ) : brief.error ? (
          <Alert
            severity="error"
            sx={{ mb: 3 }}
            action={
              <Button color="inherit" size="small" onClick={() => void brief.refresh()}>
                Retry
              </Button>
            }
          >
            {brief.error}
          </Alert>
        ) : brief.isLoading ? (
          <Skeleton
            variant="rounded"
            height={220}
            sx={{ mb: 3 }}
            role="status"
            aria-label="Loading the brief"
          />
        ) : null}

        <EntityConnectionsList entityId={detail.id} entityLabel={detail.label} ontology={ontology} />
        <EntityTimeline entityId={detail.id} ontology={ontology} />
        <EntityMentionsList entityId={detail.id} />

        {canWrite && (
          <EntityEditDialog
            open={editOpen}
            entity={detail}
            ontology={ontology}
            onClose={() => setEditOpen(false)}
            onSaved={() => {
              setEditOpen(false);
              void entity.refresh();
              void brief.refresh();
            }}
          />
        )}
        {canWrite && detail.type === 'Person' && (
          <ForgetPersonDialog
            open={forgetOpen}
            entityId={detail.id}
            label={detail.label}
            onClose={() => setForgetOpen(false)}
            onForgotten={() => {
              setForgetOpen(false);
              const state: GraphIndexLocationState = {
                snackbar: `Forgetting ${detail.label}… this takes a few seconds`,
              };
              navigate('/graph', { state });
            }}
          />
        )}
      </>
    );
  }

  return <Box sx={{ maxWidth: 960, mx: 'auto', py: { xs: 2, sm: 3 }, minWidth: 0 }}>{content}</Box>;
}
