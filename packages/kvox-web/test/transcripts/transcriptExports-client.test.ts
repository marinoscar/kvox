/**
 * The transcript export service module (issue #28, epic #19).
 *
 * Four small things, each of which the dialog would otherwise get subtly wrong:
 *
 *   * the calls unwrap what the API actually returns — `getExporters` hands
 *     back the array, not the `{ exporters }` envelope it arrives in;
 *   * `defaultOptionsFor` produces exactly the server's defaults, which is what
 *     makes the form start where the API would and therefore reuse an existing
 *     render rather than producing a second one;
 *   * `isSettled` is the poll's own stopping condition, and it must stop for
 *     `failed` as well as for `ready`;
 *   * `formatExportSize` returns null rather than `NaN` for anything it cannot
 *     read, because `sizeBytes` crosses the wire as a decimal string.
 */

import { describe, it, expect } from 'vitest';

import { createFakeKvoxWebHost } from '../../src/core/testing/index.js';
import {
  createExport,
  defaultOptionsFor,
  formatExportSize,
  getExport,
  getExportableVersions,
  getExporters,
  isSettled,
} from '../../src/transcripts/headless/clients/transcriptExports.js';
import type { TranscriptExporter } from '../../src/transcripts/headless/clients/transcriptExports.js';

const MARKDOWN: TranscriptExporter = {
  format: 'markdown',
  label: 'Markdown',
  mimeType: 'text/markdown; charset=utf-8',
  extension: 'md',
  options: [
    {
      key: 'includeTimestamps',
      label: 'Include timestamps',
      description: 'Beside each turn.',
      type: 'boolean',
      default: true,
    },
    {
      key: 'mergeConsecutive',
      label: 'Merge consecutive turns',
      description: 'One paragraph per run.',
      type: 'boolean',
      default: false,
    },
  ],
};

describe('the export calls', () => {
  it('unwraps the exporters envelope', async () => {
    const host = createFakeKvoxWebHost({
      routes: { 'GET /transcripts/exporters': { exporters: [MARKDOWN] } },
    });

    await expect(getExporters(host)).resolves.toEqual([MARKDOWN]);
  });

  it('posts the export request to the transcript\'s own path', async () => {
    const host = createFakeKvoxWebHost({ routes: { 'POST /transcripts/tr-1/exports': { id: 'exp-1' } } });

    await createExport(host, 'tr-1', { format: 'markdown', version: 2, options: {} });

    expect(host.calls[0]?.body).toEqual({ format: 'markdown', version: 2, options: {} });
  });

  it('reads one export by both ids', async () => {
    const host = createFakeKvoxWebHost({
      routes: { 'GET /transcripts/tr-1/exports/exp-1': { id: 'exp-1' } },
    });

    await expect(getExport(host, 'tr-1', 'exp-1')).resolves.toEqual({ id: 'exp-1' });
  });

  it('asks for one page of versions and returns the items', async () => {
    const host = createFakeKvoxWebHost({
      routes: {
        'GET /transcripts/tr-1/versions': { currentVersion: 3, items: [{ version: 3 }] },
      },
    });

    await expect(getExportableVersions(host, 'tr-1')).resolves.toEqual([{ version: 3 }]);
    expect(host.calls[0]?.path).toContain('limit=50');
  });
});

describe('defaultOptionsFor', () => {
  it('is exactly the server\'s declared defaults', () => {
    expect(defaultOptionsFor(MARKDOWN)).toEqual({
      includeTimestamps: true,
      mergeConsecutive: false,
    });
  });

  it('is empty for a format with no options', () => {
    expect(defaultOptionsFor({ ...MARKDOWN, options: [] })).toEqual({});
  });
});

describe('isSettled', () => {
  it('stops the poll for BOTH terminal states', () => {
    expect(isSettled({ status: 'ready' })).toBe(true);
    expect(isSettled({ status: 'failed' })).toBe(true);
  });

  it('keeps polling while pending', () => {
    expect(isSettled({ status: 'pending' })).toBe(false);
  });
});

describe('formatExportSize', () => {
  it.each([
    ['512', '512 B'],
    ['4096', '4.0 KB'],
    ['1572864', '1.5 MB'],
  ])('renders %s bytes as %s', (bytes, expected) => {
    expect(formatExportSize(bytes)).toBe(expected);
  });

  it('is null before the render finishes', () => {
    expect(formatExportSize(null)).toBeNull();
  });

  it('is null rather than NaN for anything unreadable', () => {
    expect(formatExportSize('not a number')).toBeNull();
    expect(formatExportSize('-1')).toBeNull();
  });
});
