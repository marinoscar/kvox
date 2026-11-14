# voiceprints

`@marinoscar/kvox-ai/voiceprints`: on-device speaker voiceprints, so a host can suggest who is speaking in a transcript by comparing a voice with the voices of people already named, with no key and no network after one download (issue #823).

## Purpose and scope

Status: issue #823 (calibration: issue #822).

- **Biometric data.** A voiceprint identifies a person. This package computes vectors from audio the host hands it and returns them; it NEVER transmits audio or vectors anywhere (its only network use is the model download below). What is stored, for whom, with what consent and how it is deleted is the host's decision.
- **Model.** CAM++ (3D-Speaker `iic/speech_campplus_sv_en_voxceleb_16k`, English VoxCeleb, 16 kHz), 512-wide, ONNX export by k2-fsa/sherpa-onnx. License: Apache-2.0. One file, `model.onnx` (29,596,978 bytes). The model id `campplus-en-voxceleb-16k` is permanent once vectors are stored under it: vectors of different models are not comparable, so a new model is a new id and a new manifest, never an edit. The release tag in the pinned URL is really spelled `speaker-recongition-models` upstream.
- **Download.** `downloadVoiceprintModel({ directory, signal?, onProgress?(received, total), fetch? })` installs `<directory>/<model id>/` with an `installed.json` record, with the same rules as `local-embeddings` over the shared verified downloader: https only, an EXACT host match on the first URL and on EVERY redirect hop (`VOICEPRINT_DOWNLOAD_HOSTS`: `github.com`, `release-assets.githubusercontent.com`, `objects.githubusercontent.com`), a byte cap, SHA-256 verified in a staging directory, an atomic rename. A failure or abort installs nothing; already installed returns at once. `voiceprintModelStatus(directory)` and `removeVoiceprintModel(directory)` complete it. Errors are `VoiceprintDownloadError` with a `code`.
- **Features.** `computeFbank(samples, opts?)` is a dependency-free port of the Kaldi 80-bin log-mel filterbank (povey window, preemphasis 0.97, 25/10 ms, 20 to 7600 Hz, `snip_edges=false`), matching kaldi-native-fbank to about 7e-5. CAM++ takes samples in [-1, 1] (no 32768 scaling) and `subtractGlobalMean` (global-mean CMN).
- **Embedder.** `createVoiceprintEmbedder({ modelPath, numThreads? })` returns `{ model, dimensions: 512, embed(samples), dispose() }`; `embed` takes a 16 kHz mono `Float32Array` in [-1, 1] and returns an L2-normalised `Float32Array`. Audio shorter than 0.5 s (or with a non-finite sample) throws `VoiceprintAudioError`. Calls are serialised. `onnxruntime-web` is loaded lazily and its WASM is read with `fs`, so it works inside an Electron `app.asar` and on musl Linux.
- **Policy** (pure). `selectVoiceprintWindows(segments)` drops segments under 1500 ms, trims 200 ms from each edge and takes the longest first up to 30 000 ms (`VOICEPRINT_WINDOW_DEFAULTS`). `cosineSimilarity`, `l2Normalize` and `centroid` build and compare voiceprints; `VOICEPRINT_MAX_SAMPLES_PER_PERSON` is 10. `decideVoiceSuggestion(candidates)` returns the best candidate only when its score is at least 0.52 and it leads the runner-up by at least 0.05 (`VOICEPRINT_SUGGESTION_DEFAULTS`), else `null`. The defaults were calibrated on real read speech (LibriSpeech dev and test clean, cross-session, open set): top-1 about 96 to 97 percent, at most 5 percent wrong suggestions, at most 3 percent unknown-voice false accepts. Conversational or noisy audio is not covered by that calibration.

### Run it off the event loop

`session.run` BLOCKS the thread: about 4 s of CPU per 60 s of audio. `createThreadedVoiceprintEmbedder({ modelPath, numThreads?, workerPath? })` has the same interface and runs the embedder in a `node:worker_threads` Worker (`voiceprint-worker.js`, next to the module in the compiled CommonJS `dist/`). The samples' buffer is TRANSFERRED, so the array you pass is empty afterwards (a copy is made when it is a view of a larger buffer). If the worker crashes, pending calls reject and the next call starts a new one; `dispose()` terminates it. `workerPath` is for tests or a bundler that moves the file.

### Wiring a host

```ts
import {
  centroid, cosineSimilarity, createThreadedVoiceprintEmbedder, decideVoiceSuggestion,
  downloadVoiceprintModel, selectVoiceprintWindows,
} from '@marinoscar/kvox-ai/voiceprints';

const { path } = await downloadVoiceprintModel({ directory: join(app.getPath('userData'), 'models') });
const embedder = createThreadedVoiceprintEmbedder({ modelPath: path });

const { windows } = selectVoiceprintWindows(speakerSegments);
const vectors = [];
for (const w of windows) vectors.push(await embedder.embed(pcm16kMono.slice(ms(w.startMs), ms(w.endMs))));
const voice = centroid(vectors);
const suggestion = decideVoiceSuggestion(people.map((p) => ({ entityId: p.id, score: cosineSimilarity(voice, p.voiceprint) })));
```

Decoding and resampling audio to 16 kHz mono is the host's job.

### Tests

Unit specs use a local `http` server behind an injected `fetch`, a fake session and a fake worker script. `fbank.spec.ts` pins the filterbank against `test/fixtures/voiceprint-fbank-reference.v1.json` (a synthetic sine-plus-noise signal, no speech). `voiceprint-embedder.integration.spec.ts` runs only when `KVOX_VOICEPRINT_MODEL_DIR` points at an installed model directory (and `NODE_OPTIONS=--experimental-vm-modules` under Jest).

## Entry point

`@marinoscar/kvox-ai/voiceprints`. Deliberately NOT re-exported by the package root, so a host that never imports it never loads (or needs) the optional peer.

## Peer dependencies

`onnxruntime-web` `1.30.0`, an OPTIONAL peer (`peerDependenciesMeta`) loaded lazily by `createVoiceprintEmbedder` only; the downloader, the manifest, the features and the policy run without it. It imports the `download` slice.

## Configuration

No environment variable and no settings key of its own. The host passes `directory` (an app-private models folder) to the download, status and removal functions and `modelPath` and `numThreads` (default 1) to the embedder. `manifest` and `allowedHosts` on the download are for a mirror or a test.

## Extension-point catalog

None.
