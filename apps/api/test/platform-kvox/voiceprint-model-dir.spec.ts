// =============================================================================
// The voiceprint model directory (#831): the fixed volume directory when it exists
// and is writable, else the temp-directory fallback the adapter always used. The
// production image's `scripts/voiceprint-model.js` requires the compiled module, so
// this is also the contract between the script and the adapter.
// =============================================================================

import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  VOICEPRINT_MODEL_VOLUME_DIR,
  resolveVoiceprintModelDir,
} from '../../src/platform-kvox/voiceprints/voiceprint-model-dir';

describe('resolveVoiceprintModelDir', () => {
  it('is a fixed directory with no product name in it', () => {
    expect(VOICEPRINT_MODEL_VOLUME_DIR).toBe('/var/lib/voiceprint-models');
  });

  it('uses the volume directory when it is a writable directory', () => {
    const asked: string[] = [];
    const dir = resolveVoiceprintModelDir('app-x', {
      isWritableDirectory: (path) => {
        asked.push(path);
        return true;
      },
    });

    expect(dir).toBe(VOICEPRINT_MODEL_VOLUME_DIR);
    expect(asked).toEqual([VOICEPRINT_MODEL_VOLUME_DIR]);
  });

  it('falls back to <tmp>/<slug>-models when the volume directory is absent or read-only', () => {
    expect(resolveVoiceprintModelDir('app-x', { isWritableDirectory: () => false })).toBe(join(tmpdir(), 'app-x-models'));
  });

  it('falls back on a host without the volume directory (the real probe)', () => {
    // Test hosts do not have /var/lib/voiceprint-models.
    expect(resolveVoiceprintModelDir('app-x')).toBe(join(tmpdir(), 'app-x-models'));
  });
});
