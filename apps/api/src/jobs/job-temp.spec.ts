// =============================================================================
// Unit tests for the job temp-file naming (issue #263, epic #254)
// =============================================================================
//
// Two properties, and both of them are safety properties for the janitor
// rather than cosmetics: the prefix is DERIVED from the rebrandable app name
// (so two applications built from this template on one host cannot sweep each
// other's in-flight files), and it is never empty (so `startsWith` cannot
// match every file in `/tmp`).
// =============================================================================

import { APP_NAME } from '@app/shared';

import { JOB_TEMP_PREFIX, jobTempDir, jobTempPath } from './job-temp';

describe('JOB_TEMP_PREFIX', () => {
  it('is derived from the rebrandable app name, not written out', () => {
    const expected = `${APP_NAME.toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')}-job-`;

    expect(JOB_TEMP_PREFIX).toBe(expected);
  });

  it('is never empty, so the janitor can never match every file in the temp dir', () => {
    expect(JOB_TEMP_PREFIX.length).toBeGreaterThan(0);
  });

  it('is filesystem-safe: lowercase letters, digits and dashes only', () => {
    expect(JOB_TEMP_PREFIX).toMatch(/^[a-z0-9-]+-$/);
  });
});

describe('jobTempPath', () => {
  it('puts a prefixed, unique name inside the temp directory', () => {
    const first = jobTempPath();
    const second = jobTempPath();

    expect(first.startsWith(`${jobTempDir()}/${JOB_TEMP_PREFIX}`)).toBe(true);
    expect(first).not.toBe(second);
  });

  it('appends a suffix for tools that insist on a real extension', () => {
    expect(jobTempPath('.pdf').endsWith('.pdf')).toBe(true);
  });

  it('creates nothing — it only returns a path', async () => {
    const { promises: fs } = await import('node:fs');

    await expect(fs.access(jobTempPath())).rejects.toThrow();
  });
});
