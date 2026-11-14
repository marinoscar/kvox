// =============================================================================
// The pinned file of the speaker-voiceprint model (issue #823)
// =============================================================================
//
// MODEL: CAM++ (3D-Speaker, `iic/speech_campplus_sv_en_voxceleb_16k`), the
// English VoxCeleb 16 kHz speaker-verification model, 512-wide embedding, as
// exported to ONNX by k2-fsa/sherpa-onnx. LICENSE: Apache-2.0. Verified against
// https://raw.githubusercontent.com/modelscope/3D-Speaker/main/LICENSE (the
// Apache License, Version 2.0); the ONNX export is published by k2-fsa/sherpa-onnx
// (Apache-2.0) as a release asset.
//
// The release tag really is spelled `speaker-recongition-models` upstream; the
// URL below is copied, not corrected.
//
// The file carries its exact size and SHA-256, so the bytes cannot change under
// a user. The model id `campplus-en-voxceleb-16k` is PERMANENT once voiceprint
// vectors are stored under it: vectors of different models are not comparable,
// so a new build or model is a NEW id with its own manifest, never an edit of
// this one.
// =============================================================================

/**
 * One file of a voiceprint model manifest.
 *
 * @stability experimental
 */
export interface VoiceprintFile {
  /** The file name inside the installed model directory (plain, no separators). */
  name: string;
  /** The https URL it is downloaded from. */
  url: string;
  /** The exact size in bytes. */
  size: number;
  /** The SHA-256, 64 lowercase hex characters. */
  sha256: string;
}

/**
 * The files and licence of one downloadable voiceprint model.
 *
 * @stability experimental
 */
export interface VoiceprintManifest {
  /** The model id; also the directory name. Permanent once vectors exist. */
  model: string;
  /** The model's licence (SPDX). */
  license: string;
  /** The files, all required. */
  files: readonly VoiceprintFile[];
}

/**
 * The manifest of the voiceprint model: about 29.6 MB in one file, Apache-2.0.
 *
 * @remarks
 * The model id is permanent once vectors are stored under it.
 *
 * @stability experimental
 */
export const VOICEPRINT_MANIFEST: VoiceprintManifest = Object.freeze({
  model: 'campplus-en-voxceleb-16k',
  license: 'Apache-2.0',
  files: Object.freeze([
    {
      name: 'model.onnx',
      url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_campplus_sv_en_voxceleb_16k.onnx',
      size: 29596978,
      sha256: '357a834f702b80161e5b981182c038e18553c1f2ca752ed6cec2052365d4129b',
    },
  ]),
});

/**
 * The only hosts the model download may contact, on the first request and on
 * every redirect hop.
 *
 * @remarks
 * `github.com` redirects release downloads to `release-assets.githubusercontent.com`
 * today (`objects.githubusercontent.com` was the earlier target). The SHA-256 in
 * the manifest is what guarantees integrity; this list only bounds where the app
 * may connect.
 *
 * @stability experimental
 */
export const VOICEPRINT_DOWNLOAD_HOSTS: readonly string[] = Object.freeze([
  'github.com',
  'release-assets.githubusercontent.com',
  'objects.githubusercontent.com',
]);

/**
 * The width of a voiceprint vector.
 *
 * @stability experimental
 */
export const VOICEPRINT_DIMENSIONS = 512;

/**
 * The sample rate the model expects, in Hz (mono).
 *
 * @stability experimental
 */
export const VOICEPRINT_SAMPLE_RATE = 16000;
