/**
 * "Export graph…" — take your own knowledge graph out as RDF (#386, epic #349;
 * spec §18.2).
 *
 * Opened from `/graph`'s header overflow menu. Choose a format, press Export:
 * the API queues a `kg.export` job (or hands back an identical export of an
 * unchanged graph at once), the dialog polls it every 2 s, and a Download
 * button appears when it is ready. Recent exports are listed below with their
 * expiry, each downloadable while it lasts.
 *
 * THE DOWNLOAD IS A SIGNED URL AND IT IS OPENED, NOT FETCHED — the filename is
 * signed into its `Content-Disposition`; fetching the bytes into a blob would
 * pull a possibly large file through the tab and lose that name.
 *
 * Full-screen on a phone (`down('sm')`), the pattern every graph dialog uses —
 * a page-level read, not a coupled breakpoint gate.
 */

import FileDownloadOutlinedIcon from '@mui/icons-material/FileDownloadOutlined';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import FormControl from '@mui/material/FormControl';
import FormControlLabel from '@mui/material/FormControlLabel';
import FormLabel from '@mui/material/FormLabel';
import LinearProgress from '@mui/material/LinearProgress';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemText from '@mui/material/ListItemText';
import Radio from '@mui/material/Radio';
import RadioGroup from '@mui/material/RadioGroup';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { useTheme } from '@mui/material/styles';
import useMediaQuery from '@mui/material/useMediaQuery';
import { useState } from 'react';

import { useGraphExport, type UseGraphExportOptions } from '../../hooks/useGraphExport';
import type { GraphExport, GraphExportFormat } from '../../services/graph';

export interface ExportGraphDialogProps {
  open: boolean;
  onClose: () => void;
  /** Test seam for the poll cadence. */
  pollOptions?: UseGraphExportOptions;
}

const FORMATS: ReadonlyArray<{ value: GraphExportFormat; label: string; description: string }> = [
  { value: 'jsonld', label: 'JSON-LD', description: 'For developers and linked-data tools.' },
  { value: 'turtle', label: 'Turtle', description: 'Readable RDF, for ontology and graph tools.' },
  { value: 'nquads', label: 'N-Quads', description: 'One statement per line, for bulk loading.' },
];

const FORMAT_LABEL: Record<GraphExportFormat, string> = { jsonld: 'JSON-LD', turtle: 'Turtle', nquads: 'N-Quads' };

function openDownload(url: string): void {
  window.open(url, '_blank', 'noopener,noreferrer');
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

function statusText(e: GraphExport): string {
  switch (e.status) {
    case 'ready':
      return `Ready · expires ${formatDate(e.expiresAt)}`;
    case 'failed':
      return 'Failed';
    default:
      return 'Preparing…';
  }
}

export function ExportGraphDialog({ open, onClose, pollOptions }: ExportGraphDialogProps) {
  const theme = useTheme();
  const isPhone = useMediaQuery(theme.breakpoints.down('sm'));
  const [format, setFormat] = useState<GraphExportFormat>('jsonld');
  const exporter = useGraphExport(open, pollOptions);
  const busy = exporter.phase === 'working';
  const ready = exporter.phase === 'ready' && exporter.current?.downloadUrl;
  const excluded = exporter.current?.stats.excludedSensitive ?? 0;

  return (
    <Dialog open={open} onClose={onClose} fullScreen={isPhone} fullWidth maxWidth="sm" aria-labelledby="export-graph-title">
      <DialogTitle id="export-graph-title">Export graph</DialogTitle>
      <DialogContent>
        <Stack spacing={2}>
          <Typography variant="body2" color="text.secondary">
            Download your reviewed people, organizations, projects, meetings and facts — with the citations behind
            them — in a standard RDF format.
          </Typography>

          <FormControl disabled={busy}>
            <FormLabel id="export-graph-format">Format</FormLabel>
            <RadioGroup
              aria-labelledby="export-graph-format"
              value={format}
              onChange={(event) => {
                setFormat(event.target.value as GraphExportFormat);
                exporter.reset();
              }}
            >
              {FORMATS.map((f) => (
                <FormControlLabel
                  key={f.value}
                  value={f.value}
                  control={<Radio />}
                  label={
                    <Box>
                      <Typography component="span">{f.label}</Typography>
                      <Typography component="span" variant="body2" color="text.secondary">
                        {' — '}
                        {f.description}
                      </Typography>
                    </Box>
                  }
                />
              ))}
            </RadioGroup>
          </FormControl>

          <Alert severity="info" variant="outlined">
            Sensitive personal facts are never exported.
          </Alert>

          {busy && (
            <Box role="status" aria-live="polite">
              <Typography variant="body2" sx={{ mb: 1 }}>
                Preparing your export…
              </Typography>
              <LinearProgress aria-label="Preparing your export" />
            </Box>
          )}
          {exporter.phase === 'timeout' && (
            <Alert severity="warning">
              Your export is still being prepared. Close this and export again later — the same export will be picked
              up.
            </Alert>
          )}
          {exporter.phase === 'error' && exporter.error && <Alert severity="error">{exporter.error}</Alert>}
          {ready && exporter.current && (
            <Alert
              severity="success"
              action={
                <Button
                  color="inherit"
                  size="small"
                  startIcon={<FileDownloadOutlinedIcon />}
                  onClick={() => openDownload(exporter.current!.downloadUrl!)}
                >
                  Download
                </Button>
              }
            >
              {exporter.current.filename} is ready.
              {excluded > 0 && ` ${excluded} sensitive ${excluded === 1 ? 'value was' : 'values were'} left out.`}
            </Alert>
          )}

          <Box>
            <Typography variant="subtitle2" component="h3">
              Recent exports
            </Typography>
            {exporter.listError && (
              <Typography variant="body2" color="error">
                {exporter.listError}
              </Typography>
            )}
            {!exporter.listLoading && !exporter.listError && exporter.exports.length === 0 && (
              <Typography variant="body2" color="text.secondary">
                No exports in the last 7 days.
              </Typography>
            )}
            {exporter.exports.length > 0 && (
              <List dense aria-label="Recent exports" disablePadding>
                {exporter.exports.map((e) => (
                  <ListItem
                    key={e.id}
                    disableGutters
                    secondaryAction={
                      e.status === 'ready' && e.downloadUrl ? (
                        <Button
                          size="small"
                          onClick={() => openDownload(e.downloadUrl!)}
                          aria-label={`Download ${e.filename}`}
                        >
                          Download
                        </Button>
                      ) : undefined
                    }
                  >
                    <ListItemText
                      primary={`${FORMAT_LABEL[e.format]} · ${formatDate(e.createdAt)}`}
                      secondary={statusText(e)}
                    />
                  </ListItem>
                ))}
              </List>
            )}
          </Box>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
        <Button variant="contained" onClick={() => void exporter.start(format)} disabled={busy}>
          Export
        </Button>
      </DialogActions>
    </Dialog>
  );
}
