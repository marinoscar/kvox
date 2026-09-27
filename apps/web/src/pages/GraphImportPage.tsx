/**
 * `/graph/imports/:proposalId` — one RDF import, checked and reviewed (#387,
 * epic #349; spec §18.3).
 *
 * An import is an ordinary `kind: import` proposal. While `kg.import` checks
 * the file ("Checking your file…", re-read every 3 s) there is nothing to
 * review; a `failed` import says why — for `shacl_violations`, the first 200
 * problems — and imported nothing (validation is all or nothing); a `draft`
 * shows the Unknown properties panel above #367's `ProposalReviewSheet`,
 * rendered inline with `source={{ proposalId }}` — the same rows, decisions and
 * "Send to graph" an extracted note gets, and the same states afterwards.
 *
 * OWNED BY `home` through the existing `/graph` prefix (config/destinations.ts),
 * gated on `graph:write` in `App.tsx` — importing is curating the graph (§12).
 */

import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import LinearProgress from '@mui/material/LinearProgress';
import Paper from '@mui/material/Paper';
import Skeleton from '@mui/material/Skeleton';
import Snackbar from '@mui/material/Snackbar';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { useState } from 'react';
import type { ReactNode } from 'react';
import { Link as RouterLink, useParams } from 'react-router-dom';

import { UnknownPropertiesPanel } from '../components/graph/import/UnknownPropertiesPanel';
import { ValidationReportTable } from '../components/graph/import/ValidationReportTable';
import { ProposalReviewSheet } from '../components/graph/review/ProposalReviewSheet';
import { useGraphImport } from '../hooks/useGraphImport';
import { usePermissions } from '../hooks/usePermissions';
import { ApiError } from '../services/api';
import type { GraphImportFailureReason, GraphImportFormat, GraphImportOffer } from '../services/graph';

const FORMAT_LABELS: Record<GraphImportFormat, string> = { turtle: 'Turtle', jsonld: 'JSON-LD', nquads: 'N-Quads' };

/** What the page says for each way an import can fail. Nothing was imported in any of them. */
export const IMPORT_FAILURE_COPY: Record<GraphImportFailureReason, string> = {
  parse_error: 'The file could not be read as RDF. Check that it is valid Turtle, JSON-LD or N-Quads.',
  too_large: 'The file is larger than one import can hold (20 MB, 200,000 statements). Split it and import the parts.',
  ontology_version_newer:
    'The file was written by a newer version of the ontology than this deployment runs. Upgrade this deployment first.',
  migration_pending:
    'Your graph is being updated to the current ontology version. Try the import again once that finishes.',
  shacl_violations: 'The file does not match your ontology, so nothing was imported. Fix the problems below and upload it again.',
  empty: 'The file contains nothing this graph can hold — no node is typed as a person, organization, project or other type.',
};

function errorText(err: unknown, fallback: string): string {
  return err instanceof ApiError && err.message ? err.message : fallback;
}

export default function GraphImportPage() {
  const { proposalId = '' } = useParams<{ proposalId: string }>();
  const ctl = useGraphImport(proposalId);
  const { hasPermission } = usePermissions();
  const canWrite = hasPermission('graph:write');
  const [snackbar, setSnackbar] = useState<string | null>(null);

  const summary = ctl.detail?.proposal ?? null;
  const stats = ctl.stats;
  const status = summary?.status;

  const decide = (offer: GraphImportOffer, action: 'accept' | 'reject') => {
    const run = action === 'accept' ? ctl.acceptOffer(offer.offerId) : ctl.rejectOffer(offer.offerId);
    run.then(
      (result) =>
        setSnackbar(
          action === 'accept'
            ? `Added “${result.attributeDefs[0]?.label ?? offer.label ?? 'the property'}” as an attribute`
            : 'Left the property out',
        ),
      (err: unknown) => setSnackbar(errorText(err, 'That decision was not saved')),
    );
  };

  const header = (
    <Box sx={{ mb: 2, minWidth: 0 }}>
      <Typography variant="h4" component="h1" sx={{ fontWeight: 600, wordBreak: 'break-word' }}>
        {stats.filename ?? 'Import'}
      </Typography>
      <Typography variant="body2" color="text.secondary">
        {[
          stats.format ? FORMAT_LABELS[stats.format] : null,
          typeof stats.triples === 'number' && stats.triples > 0 ? `${stats.triples.toLocaleString()} statements` : null,
          stats.migratedFrom ? `migrated from ontology ${stats.migratedFrom}` : null,
        ]
          .filter(Boolean)
          .join(' · ') || 'Graph import'}
      </Typography>
    </Box>
  );

  let body: ReactNode;
  if (ctl.detail === undefined && !ctl.error) {
    body = (
      <Box role="status" aria-busy="true" aria-label="Loading the import">
        <Skeleton width="50%" />
        <Skeleton variant="rounded" height={120} sx={{ mt: 1 }} />
      </Box>
    );
  } else if (ctl.error && !summary) {
    body = (
      <Alert
        severity="error"
        action={
          <Button color="inherit" size="small" onClick={() => void ctl.refresh()}>
            Retry
          </Button>
        }
      >
        {ctl.error}
      </Alert>
    );
  } else if (status === 'extracting') {
    body = (
      <Paper variant="outlined" sx={{ p: 2 }} role="status" aria-live="polite">
        <Typography variant="body1" sx={{ mb: 1 }}>
          Checking your file…
        </Typography>
        <LinearProgress aria-label="Checking your file" />
        <Typography variant="caption" color="text.secondary" component="div" sx={{ mt: 1 }}>
          It is being validated against your ontology and matched to your graph. You can leave this page — the import
          will be waiting here.
        </Typography>
      </Paper>
    );
  } else if (status === 'failed') {
    const reason = stats.failureReason ?? null;
    body = (
      <Stack spacing={2}>
        <Alert severity="error">
          {reason ? IMPORT_FAILURE_COPY[reason] : (summary?.failure?.message ?? 'The import did not finish.')}
        </Alert>
        {reason === 'shacl_violations' && stats.validation && (
          <ValidationReportTable violations={stats.validation.violations} violationCount={stats.validation.violationCount} />
        )}
        <Box>
          <Button component={RouterLink} to="/graph" variant="outlined">
            Back to knowledge
          </Button>
        </Box>
      </Stack>
    );
  } else {
    body = (
      <>
        {status === 'draft' && (stats.unknownProperties?.length ?? 0) > 0 && (
          <UnknownPropertiesPanel
            offers={stats.unknownProperties ?? []}
            canDecide={canWrite}
            busyOfferId={ctl.busyOfferId}
            onAccept={(offer) => decide(offer, 'accept')}
            onReject={(offer) => decide(offer, 'reject')}
          />
        )}
        {status === 'draft' && (stats.counts?.skippedSensitive ?? 0) > 0 && (
          <Alert severity="info" variant="outlined" sx={{ mb: 2 }}>
            {stats.counts?.skippedSensitive} sensitive {stats.counts?.skippedSensitive === 1 ? 'fact was' : 'facts were'} left
            out — sensitive facts are never imported in bulk.
          </Alert>
        )}
        <ProposalReviewSheet open variant="inline" source={{ proposalId }} proposal={ctl} />
      </>
    );
  }

  return (
    <Box sx={{ maxWidth: 960, mx: 'auto', py: { xs: 2, sm: 3 }, minWidth: 0 }}>
      {header}
      {body}
      <Snackbar open={snackbar !== null} autoHideDuration={6000} onClose={() => setSnackbar(null)} message={snackbar ?? ''} />
    </Box>
  );
}
