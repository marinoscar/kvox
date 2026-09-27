/**
 * The SHACL validation report of a failed import (#387; spec §18.3): the
 * first 200 violations — which node, which property, what was wrong — and the
 * true total. An import that fails validation imports nothing, so this table
 * is the whole answer to "why not?".
 *
 * On a phone the table scrolls horizontally inside its own box rather than
 * widening the page.
 */

import Box from '@mui/material/Box';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Typography from '@mui/material/Typography';

import type { GraphImportViolation } from '../../../services/graph';

export interface ValidationReportTableProps {
  violations: readonly GraphImportViolation[];
  /** The true number of violations; `violations` holds at most the first 200. */
  violationCount: number;
}

/** The last segment of an IRI (`…#WORKS_FOR` → `WORKS_FOR`), for a narrow column. */
export function shortIri(iri: string | null): string {
  if (!iri) return '—';
  const tail = iri.split(/[#/]/).filter(Boolean).pop();
  return tail ?? iri;
}

export function ValidationReportTable({ violations, violationCount }: ValidationReportTableProps) {
  const shown = violations.length;
  return (
    <Box>
      <Typography variant="subtitle2" component="h3" sx={{ mb: 1 }}>
        {violationCount === 1 ? '1 problem' : `${violationCount} problems`}
        {violationCount > shown ? ` — showing the first ${shown}` : ''}
      </Typography>
      <TableContainer sx={{ maxWidth: '100%', overflowX: 'auto', border: 1, borderColor: 'divider', borderRadius: 1 }}>
        <Table size="small" aria-label="Validation problems">
          <TableHead>
            <TableRow>
              <TableCell>Node</TableCell>
              <TableCell>Property</TableCell>
              <TableCell>Problem</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {violations.map((v, index) => (
              <TableRow key={`${v.focusNode}-${v.path ?? ''}-${index}`}>
                <TableCell sx={{ wordBreak: 'break-all', minWidth: 140 }} title={v.focusNode}>
                  {v.focusNode}
                </TableCell>
                <TableCell sx={{ whiteSpace: 'nowrap' }} title={v.path ?? undefined}>
                  {shortIri(v.path)}
                </TableCell>
                <TableCell sx={{ minWidth: 180 }}>
                  {v.message}
                  {v.severity === 'Warning' ? ' (warning)' : ''}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
    </Box>
  );
}

export default ValidationReportTable;
