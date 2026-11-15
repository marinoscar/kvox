import { accessSync, constants, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// =============================================================================
// Where the speaker voiceprint model lives on disk  (issue #831)
// =============================================================================
//
// ONE source of truth for the adapter (`PlatformKvoxVoiceprintsAdapter`) and the
// image's model script (`scripts/voiceprint-model.js`, which requires the compiled
// copy of this file), so a model the deploy step installed is the one the embedder
// finds.
//
// PRODUCTION: `/var/lib/voiceprint-models`, a fixed directory with no product name
// in it, which `infra/compose/app.prod.voiceprint-models.compose.yml` mounts as a
// named volume. It is used whenever it EXISTS AND IS WRITABLE, so a deployment
// that has the volume keeps the model across container re-creation (every
// `deploy update` rebuilds the image and re-creates the container).
//
// ANYWHERE ELSE (development containers, tests, a host run): `<tmp>/<fallback>`
// under the OS temp directory, the pre-#831 behaviour. No environment variable
// (root rule): the presence of the mount is the switch.
// =============================================================================

/** The fixed directory the production overlay mounts a named volume at. */
export const VOICEPRINT_MODEL_VOLUME_DIR = '/var/lib/voiceprint-models';

/** Probes for the fixed directory; a seam for the tests. */
export interface VoiceprintModelDirProbe {
  isWritableDirectory(path: string): boolean;
}

const fsProbe: VoiceprintModelDirProbe = {
  isWritableDirectory(path) {
    try {
      if (!statSync(path).isDirectory()) return false;
      accessSync(path, constants.W_OK);
      return true;
    } catch {
      return false;
    }
  },
};

/**
 * The directory the model is installed under (`<dir>/<model id>/model.onnx`).
 *
 * @param appSlug - the app slug, for the temp-directory fallback only.
 */
export function resolveVoiceprintModelDir(appSlug: string, probe: VoiceprintModelDirProbe = fsProbe): string {
  return probe.isWritableDirectory(VOICEPRINT_MODEL_VOLUME_DIR)
    ? VOICEPRINT_MODEL_VOLUME_DIR
    : join(tmpdir(), `${appSlug}-models`);
}
