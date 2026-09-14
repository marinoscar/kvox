import { describe, it, expect } from 'vitest';
import { http, HttpResponse } from 'msw';

import { server } from '../mocks/server';
import {
  createNoteExport,
  defaultNoteExportOptions,
  formatNoteExportSize,
  getNoteExport,
  getNoteExporters,
  isSettled,
  listNoteExports,
} from '../../services/noteExports';
import type { NoteExport, NoteExporter } from '../../services/noteExports';

/**
 * `services/noteExports.ts` — issue #58, epic #45.
 *
 * The assertions worth having here are the ones about the REGISTRY contract:
 * that the module reads the server's format list rather than holding one, and
 * that `reused` (not the status line, which a `{ data }` unwrapper hides) is
 * what tells a caller an export already existed.
 */

const API_BASE = 'http://localhost:3000/api';

const EXPORTER: NoteExporter = {
  format: 'markdown',
  label: 'Markdown',
  mimeType: 'text/markdown',
  extension: 'md',
  options: [
    {
      key: 'includeProvenance',
      label: 'Include the provenance header',
      description: 'Names the source, the template and the version.',
      type: 'boolean',
      default: true,
    },
    {
      key: 'includeFrontMatter',
      label: 'Include YAML front matter',
      description: 'For static site generators.',
      type: 'boolean',
      default: false,
    },
  ],
};

function exportRow(overrides: Partial<NoteExport> = {}): NoteExport {
  return {
    id: 'exp-1',
    noteId: 'n1',
    version: 2,
    format: 'markdown',
    options: {},
    status: 'ready',
    reused: false,
    mimeType: 'text/markdown',
    filename: 'Note (v2).md',
    sizeBytes: '1024',
    error: null,
    downloadUrl: 'https://storage.example/x',
    downloadExpiresAt: null,
    expiresAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('noteExports — the registry', () => {
  it('returns whatever formats the server publishes, in the server’s order', async () => {
    server.use(
      http.get(`${API_BASE}/notes/exporters`, () =>
        HttpResponse.json({
          data: { exporters: [EXPORTER, { ...EXPORTER, format: 'pdf', label: 'PDF', options: [] }] },
        }),
      ),
    );

    const exporters = await getNoteExporters();

    expect(exporters.map((exporter) => exporter.format)).toEqual(['markdown', 'pdf']);
  });

  it('seeds the form with the exporter’s OWN defaults, never a list held here', async () => {
    expect(defaultNoteExportOptions(EXPORTER)).toEqual({
      includeProvenance: true,
      includeFrontMatter: false,
    });
  });

  it('has no format names of its own', async () => {
    // A format this module has never heard of round-trips unchanged, which is
    // the executable form of "nothing in `apps/web` may branch on a format
    // string".
    server.use(
      http.get(`${API_BASE}/notes/exporters`, () =>
        HttpResponse.json({
          data: {
            exporters: [
              { format: 'epub', label: 'EPUB', mimeType: 'application/epub+zip', extension: 'epub', options: [] },
            ],
          },
        }),
      ),
    );

    const exporters = await getNoteExporters();

    expect(exporters[0].format).toBe('epub');
  });
});

describe('noteExports — requesting one', () => {
  it('reports a reused export through `reused`, not through the status line', async () => {
    // ⚠ 200 vs 202 is invisible to a client that unwraps `{ data }`, which is
    // exactly why the API publishes the field.
    server.use(
      http.post(`${API_BASE}/notes/:id/exports`, () =>
        HttpResponse.json({ data: exportRow({ reused: true }) }, { status: 200 }),
      ),
    );

    const row = await createNoteExport('n1', { format: 'markdown' });

    expect(row.reused).toBe(true);
    // A reused export is ALREADY settled, so a dialog must offer it at once
    // rather than starting a poll with nothing to wait for.
    expect(isSettled(row)).toBe(true);
  });

  it('treats a queued render as unsettled', async () => {
    server.use(
      http.post(`${API_BASE}/notes/:id/exports`, () =>
        HttpResponse.json({ data: exportRow({ status: 'pending', downloadUrl: null }) }, { status: 202 }),
      ),
    );

    expect(isSettled(await createNoteExport('n1', { format: 'markdown' }))).toBe(false);
  });
});

describe('noteExports — polling', () => {
  it('finds one export in the list the API actually publishes', async () => {
    server.use(
      http.get(`${API_BASE}/notes/:id/exports`, () =>
        HttpResponse.json({ data: { exports: [exportRow({ id: 'other' }), exportRow()] } }),
      ),
    );

    expect(await listNoteExports('n1')).toHaveLength(2);
    expect((await getNoteExport('n1', 'exp-1'))?.id).toBe('exp-1');
  });

  it('answers null — not an exception — for an export the list no longer carries', async () => {
    // An expiry mid-poll is "gone", which a dialog can explain. An exception
    // would become "the export failed", which is a different and wrong claim.
    server.use(
      http.get(`${API_BASE}/notes/:id/exports`, () =>
        HttpResponse.json({ data: { exports: [] } }),
      ),
    );

    expect(await getNoteExport('n1', 'exp-1')).toBeNull();
  });
});

describe('noteExports — the size string', () => {
  it('renders the decimal string the BigInt column crosses the wire as', () => {
    expect(formatNoteExportSize('512')).toBe('512 B');
    expect(formatNoteExportSize('2048')).toBe('2.0 KB');
    expect(formatNoteExportSize('5242880')).toBe('5.0 MB');
  });

  it('answers null rather than NaN for anything unreadable', () => {
    expect(formatNoteExportSize(null)).toBeNull();
    expect(formatNoteExportSize('not a number')).toBeNull();
    expect(formatNoteExportSize('-1')).toBeNull();
  });
});
