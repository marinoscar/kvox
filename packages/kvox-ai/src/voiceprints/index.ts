/**
 * `@marinoscar/kvox-ai/voiceprints`: on-device speaker voiceprints (CAM++, 512-wide)
 * for suggesting who is speaking in a transcript (#823).
 *
 * @remarks
 * Not re-exported by the package root. The embedder lazily loads the optional
 * peer `onnxruntime-web`. It BLOCKS the event loop: use
 * `createThreadedVoiceprintEmbedder`. A voiceprint is biometric data; this entry
 * never transmits audio or vectors.
 *
 * @packageDocumentation
 */
export * from './fbank.js';
export * from './voiceprint-embedder.js';
export * from './voiceprint-files.js';
export * from './voiceprint-model.js';
export * from './voiceprint-policy.js';
export * from './voiceprint-thread.js';
