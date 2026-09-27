/**
 * "Import graph…" — bring an RDF file into your knowledge graph, as a
 * proposal you review first (#387, epic #349; spec §18.3).
 *
 * Opened from `/graph`'s header overflow menu, for a caller holding
 * `graph:write`. Pick a Turtle, JSON-LD or N-Quads file, press Upload: the API
 * stores it and queues `kg.import`, and the dialog hands over to the import
 * page (`/graph/imports/:proposalId`), where the file is checked against your
 * ontology and reviewed with the same sheet an extracted note uses. Nothing is
 * added to the graph from here.
 *
 * Full-screen on a phone (`down('sm')`), the pattern every graph dialog uses —
 * a page-level read, not a coupled breakpoint gate.
 */

import UploadFileOutlinedIcon from '@mui/icons-material/UploadFileOutlined';
import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import LinearProgress from '@mui/material/LinearProgress';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { useTheme } from '@mui/material/styles';
import useMediaQuery from '@mui/material/useMediaQuery';
import { useEffect, useId, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { ApiError } from '../../services/api';
import { GRAPH_IMPORT_ACCEPT, GRAPH_IMPORT_MAX_BYTES, graphConflictReason, uploadGraphImport } from '../../services/graph';

export interface ImportGraphDialogProps {
  open: boolean;
  onClose: () => void;
}

/** The sentence a refused upload shows. */
export function importErrorMessage(err: unknown): string {
  const reason = graphConflictReason(err);
  if (reason === 'extraction_running') return 'Another import of yours is still being checked. Try again once it finishes.';
  if (reason === 'graph_disabled') return 'Connected knowledge is switched off on this deployment.';
  if (err instanceof ApiError && err.status === 413) return 'That file is larger than 20 MB, the most one import can hold.';
  if (err instanceof ApiError && err.message) return err.message;
  return 'The file could not be uploaded.';
}

export function ImportGraphDialog({ open, onClose }: ImportGraphDialogProps) {
  const theme = useTheme();
  const isPhone = useMediaQuery(theme.breakpoints.down('sm'));
  const navigate = useNavigate();
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setFile(null);
      setError(null);
      setBusy(false);
    }
  }, [open]);

  const choose = (next: File | null) => {
    setError(null);
    if (next && next.size > GRAPH_IMPORT_MAX_BYTES) {
      setFile(null);
      setError('That file is larger than 20 MB, the most one import can hold.');
      return;
    }
    setFile(next);
  };

  const upload = async () => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const { proposalId } = await uploadGraphImport(file);
      onClose();
      navigate(`/graph/imports/${encodeURIComponent(proposalId)}`);
    } catch (err) {
      setError(importErrorMessage(err));
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={busy ? undefined : onClose}
      fullScreen={isPhone}
      fullWidth
      maxWidth="sm"
      aria-labelledby="import-graph-title"
    >
      <DialogTitle id="import-graph-title">Import graph</DialogTitle>
      <DialogContent>
        <Stack spacing={2}>
          <Typography variant="body2" color="text.secondary">
            Imports are checked against your ontology and become a proposal you review before anything is added.
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Turtle (.ttl), JSON-LD (.jsonld, .json) or N-Quads (.nq), up to 20 MB — for example an export from
            another deployment, or a contacts list converted to RDF.
          </Typography>
          <input
            ref={inputRef}
            id={inputId}
            type="file"
            accept={GRAPH_IMPORT_ACCEPT}
            hidden
            data-testid="import-graph-file"
            onChange={(event) => choose(event.target.files?.[0] ?? null)}
          />
          <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center', minWidth: 0 }}>
            <Button
              variant="outlined"
              startIcon={<UploadFileOutlinedIcon />}
              disabled={busy}
              onClick={() => inputRef.current?.click()}
            >
              Choose file
            </Button>
            <Typography variant="body2" noWrap sx={{ minWidth: 0 }} aria-live="polite">
              {file ? file.name : 'No file chosen'}
            </Typography>
          </Stack>
          {busy && <LinearProgress aria-label="Uploading" />}
          {error && <Alert severity="error">{error}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button variant="contained" onClick={() => void upload()} disabled={!file || busy}>
          Upload
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export default ImportGraphDialog;
