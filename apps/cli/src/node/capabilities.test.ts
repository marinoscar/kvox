import { describe, expect, it } from 'vitest';

import {
  binaryCapability,
  evaluateCapabilities,
  JOB_TYPE_REQUIREMENTS,
  probeCapabilities,
  PROBED_BINARIES,
  runStartupSelfTest,
  type CapabilityProbe,
  type JobTypeRequirements,
} from './capabilities.js';

const REQUIREMENTS: Record<string, JobTypeRequirements> = {
  'video.transcode': { required: [binaryCapability('ffmpeg')], degradable: [binaryCapability('exiftool')] },
  'example.checksum': { required: [], degradable: [] },
};

function probe(capabilities: string[]): CapabilityProbe {
  return {
    platform: 'linux',
    arch: 'x64',
    nodeVersion: 'v22.0.0',
    cpus: 4,
    totalMemoryMb: 8192,
    freeMemoryMb: 4096,
    binaries: {},
    capabilities,
  };
}

describe('probeCapabilities (issue #276)', () => {
  it('never throws, even when the binary lookup explodes', () => {
    // A probe that can fail turns a diagnostic command into another thing to
    // diagnose.
    expect(() =>
      probeCapabilities({
        binaries: ['ffmpeg'],
        hasBinary: () => {
          throw new Error('exec is not available in this sandbox');
        },
      }),
    ).not.toThrow();
  });

  it('reports a found binary as a capability key', () => {
    const result = probeCapabilities({ binaries: ['ffmpeg'], hasBinary: () => true });
    expect(result.capabilities).toContain('binary:ffmpeg');
    expect(result.binaries.ffmpeg).toBe(true);
  });

  it('reports real machine facts', () => {
    const result = probeCapabilities();
    expect(result.cpus).toBeGreaterThan(0);
    expect(result.nodeVersion).toBe(process.version);
  });
});

describe('evaluateCapabilities', () => {
  it('passes when nothing is required', () => {
    expect(evaluateCapabilities(['example.checksum'], probe([]), REQUIREMENTS).ok).toBe(true);
  });

  it('fails on a missing REQUIRED capability, naming both it and the type', () => {
    const result = evaluateCapabilities(['video.transcode'], probe([]), REQUIREMENTS);
    expect(result.ok).toBe(false);
    expect(result.missingRequired).toContainEqual({ type: 'video.transcode', capability: 'binary:ffmpeg' });
  });

  it('does not fail on a missing DEGRADABLE capability', () => {
    const result = evaluateCapabilities(['video.transcode'], probe(['binary:ffmpeg']), REQUIREMENTS);
    expect(result.ok).toBe(true);
    expect(result.missingDegradable).toContainEqual({ type: 'video.transcode', capability: 'binary:exiftool' });
  });

  it('ignores a type with no declared requirements', () => {
    expect(evaluateCapabilities(['some.fork.type'], probe([]), REQUIREMENTS).ok).toBe(true);
  });
});

describe('runStartupSelfTest', () => {
  it('reports a hard failure naming the capability and the type', () => {
    const failures: string[] = [];
    const warnings: string[] = [];

    const result = runStartupSelfTest({
      types: ['video.transcode'],
      probe: probe([]),
      requirements: REQUIREMENTS,
      warn: (message) => warnings.push(message),
      fail: (message) => failures.push(message),
    });

    expect(result.ok).toBe(false);
    expect(failures.join('\n')).toContain('binary:ffmpeg');
    expect(failures.join('\n')).toContain('video.transcode');
    // And it says what to do — install it, or drop the type.
    expect(failures.join('\n')).toMatch(/--types/);
  });

  it('warns and continues for a degradable gap', () => {
    const failures: string[] = [];
    const warnings: string[] = [];

    const result = runStartupSelfTest({
      types: ['video.transcode'],
      probe: probe(['binary:ffmpeg']),
      requirements: REQUIREMENTS,
      warn: (message) => warnings.push(message),
      fail: (message) => failures.push(message),
    });

    expect(result.ok).toBe(true);
    expect(failures).toEqual([]);
    expect(warnings.join('\n')).toContain('Reduced function');
  });
});

// =============================================================================
// `db.backup.run`'s two dependencies (#352, epic #345)
// =============================================================================

describe('db.backup.run requirements', () => {
  it('REFUSES to declare the type on a machine with no `pg_dump`', () => {
    // ⚠ THE FAILURE THIS PREVENTS IS THE EXPENSIVE ONE. `db.backup.run`
    // carries `maxAttempts: 1`, so a node that claims it and fails it does not
    // get a retry — the deployment simply has no backup that night, and finds
    // out during a restore.
    const result = evaluateCapabilities(['db.backup.run'], {
      ...probeOf({ pg_dump: false, psql: false }),
    });

    expect(result.ok).toBe(false);
    expect(result.missingRequired).toEqual([
      { type: 'db.backup.run', capability: 'binary:pg_dump' },
    ]);
  });

  it('runs WITHOUT `psql`, reporting reduced function — two audit fields, not a backup', () => {
    // The template's worked example of the degradable tier: the executor uses
    // `psql` only to read the server version and the newest migration, and a
    // node that refused to back the database up because it could not report a
    // version string would be trading the backup for a label.
    const result = evaluateCapabilities(['db.backup.run'], probeOf({ pg_dump: true, psql: false }));

    expect(result.ok).toBe(true);
    expect(result.missingDegradable).toEqual([
      { type: 'db.backup.run', capability: 'binary:psql' },
    ]);
  });

  it('is satisfied when both are present', () => {
    const result = evaluateCapabilities(['db.backup.run'], probeOf({ pg_dump: true, psql: true }));

    expect(result.ok).toBe(true);
    expect(result.missingDegradable).toEqual([]);
  });

  it('probes every binary any requirement names — the two lists move together', () => {
    // A capability that is never PROBED is a capability that is never
    // satisfied, so a requirement naming a binary missing from
    // `PROBED_BINARIES` would fail the self-test on every machine, however
    // complete the install.
    const required = Object.values(JOB_TYPE_REQUIREMENTS)
      .flatMap((entry) => [...entry.required, ...entry.degradable])
      .filter((capability) => capability.startsWith('binary:'))
      .map((capability) => capability.slice('binary:'.length));

    for (const binary of required) {
      expect(PROBED_BINARIES).toContain(binary);
    }
  });
});

/** A probe whose binaries are exactly these, with capabilities to match. */
function probeOf(binaries: Record<string, boolean>): CapabilityProbe {
  return probeCapabilities({
    binaries: Object.keys(binaries),
    hasBinary: (name) => binaries[name] === true,
  });
}
