/**
 * How far the files of an import batch have travelled (issue #720): Uploaded →
 * Parsed → Extracting → Extracted → In graph. Each step counts the files that have
 * REACHED it, so the row reads as a funnel; the server's `stageCounts` say where
 * each file is now, and the sums are taken here.
 */

import Box from '@mui/material/Box';
import LinearProgress from '@mui/material/LinearProgress';
import Typography from '@mui/material/Typography';

import type { NoteImportBatch } from '../../headless/index.js';

/**
 * Props of {@link ImportStageFunnel}.
 *
 * @stability experimental
 */
export interface ImportStageFunnelProps {
  /** The batch's per-stage counts. */
  stageCounts: NoteImportBatch['stageCounts'];
}

/**
 * One step of the funnel.
 *
 * @stability experimental
 */
export interface ImportFunnelStep {
  /** The step's label. */
  label: string;
  /** Files that reached it. */
  count: number;
}

/**
 * The funnel's steps from a batch's stage counts.
 *
 * @param stageCounts - Where each file is now.
 * @returns The five steps with the files that reached each.
 *
 * @stability experimental
 */
export function importFunnelSteps(stageCounts: NoteImportBatch['stageCounts']): ImportFunnelStep[] {
  const c = (key: keyof NoteImportBatch['stageCounts']) => stageCounts?.[key] ?? 0;
  const inGraph = c('in_graph');
  const extracted = c('extracted') + inGraph;
  const extracting = c('extracting') + extracted;
  // A note being formatted (#730) has been parsed: it counts here, not as a step of its own.
  const parsed = c('parsed') + c('formatting') + c('indexed') + extracting;
  const uploaded = c('uploaded') + parsed;
  return [
    { label: 'Uploaded', count: uploaded },
    { label: 'Parsed', count: parsed },
    { label: 'Extracting', count: extracting },
    { label: 'Extracted', count: extracted },
    { label: 'In graph', count: inGraph },
  ];
}

/**
 * The pipeline funnel of an import batch.
 *
 * @param props - See {@link ImportStageFunnelProps}.
 * @returns The funnel.
 *
 * @stability experimental
 */
export function ImportStageFunnel({ stageCounts }: ImportStageFunnelProps) {
  const steps = importFunnelSteps(stageCounts);
  const top = Math.max(1, steps[0]!.count);
  return (
    <Box
      component="ol"
      aria-label="Import pipeline"
      sx={{
        listStyle: 'none',
        m: 0,
        p: 0,
        display: 'grid',
        gap: 1,
        gridTemplateColumns: { xs: 'repeat(2, minmax(0, 1fr))', sm: 'repeat(5, minmax(0, 1fr))' },
      }}
    >
      {steps.map((step, index) => (
        <Box
          component="li"
          key={step.label}
          sx={{
            border: 1,
            borderColor: 'divider',
            borderRadius: 1,
            p: 1.25,
            // The fifth step spans the row on a phone so the grid has no hole.
            gridColumn: { xs: index === steps.length - 1 ? '1 / -1' : 'auto', sm: 'auto' },
          }}
        >
          <Typography variant="caption" color="text.secondary" component="p">
            {index > 0 ? '→ ' : ''}
            {step.label}
          </Typography>
          <Typography variant="h6" component="p" aria-label={`${step.label}: ${step.count}`}>
            {step.count.toLocaleString()}
          </Typography>
          <LinearProgress
            variant="determinate"
            value={Math.round((step.count / top) * 100)}
            aria-hidden
            sx={{ height: 4, borderRadius: 2, mt: 0.5 }}
          />
        </Box>
      ))}
    </Box>
  );
}
