#!/usr/bin/env node
/**
 * Speaker voiceprint model CLI (issue #831)
 *
 * Installs or inspects the CAM++ model the voiceprint embedder loads. The deploy
 * pipeline (`deploy install` / `deploy update`, step `voice-model`) and the
 * doctor run it INSIDE the api container; an operator can too.
 *
 * Usage (from the image's WORKDIR, /app/apps/api):
 *   node scripts/voiceprint-model.js ensure   download if missing, verify, report
 *   node scripts/voiceprint-model.js status   report only, never downloads
 *
 * Output: exactly one JSON line on stdout.
 *   ensure: {"status":"installed"|"already-installed","model":"<id>","bytes":<n>,"dir":"<dir>"}
 *           or {"status":"error","code":"<code>","message":"<text>"} with exit code 1
 *   status: {"installed":<bool>,"model":"<id>","dir":"<dir>"}
 * Exit code 2 is a usage error. No URL (query string or not) is ever printed.
 *
 * The directory comes from the compiled `resolveVoiceprintModelDir` (the same
 * function the API's adapter uses), so both agree: it needs `dist/` (the
 * production image has it; run `npm run build` otherwise).
 */

const { statSync } = require('node:fs');
const { join } = require('node:path');

function print(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

/** Strips anything URL-shaped from a message: a host is fine, a query string is not. */
function safeMessage(message) {
  return String(message)
    .replace(/https?:\/\/[^\s"')]+/g, (url) => {
      try {
        return `https://${new URL(url).host}`;
      } catch {
        return '[url]';
      }
    })
    .slice(0, 300);
}

async function main(argv) {
  const command = argv[2];
  if (command !== 'ensure' && command !== 'status') {
    print({ status: 'error', code: 'usage', message: 'Usage: voiceprint-model.js ensure|status' });
    return 2;
  }

  let resolveVoiceprintModelDir;
  let voiceprints;
  let APP_SLUG;
  try {
    ({ resolveVoiceprintModelDir } = require('../dist/platform-kvox/voiceprints/voiceprint-model-dir'));
    voiceprints = require('@marinoscar/kvox-ai/voiceprints');
    ({ APP_SLUG } = require('@app/shared'));
  } catch (error) {
    print({ status: 'error', code: 'not_built', message: safeMessage(`The API build is incomplete: ${error.message}`) });
    return 1;
  }

  const dir = resolveVoiceprintModelDir(APP_SLUG);
  const model = voiceprints.VOICEPRINT_MANIFEST.model;

  try {
    if (command === 'status') {
      const status = await voiceprints.voiceprintModelStatus(dir);
      print({ installed: status.installed === true, model, dir });
      return 0;
    }

    const before = await voiceprints.voiceprintModelStatus(dir);
    const installed = before.installed === true && before.path ? before : await voiceprints.downloadVoiceprintModel({ directory: dir });
    const path = installed.path;
    let bytes = 0;
    for (const file of voiceprints.VOICEPRINT_MANIFEST.files) {
      bytes += statSync(join(path, file.name)).size;
    }
    print({ status: before.installed === true ? 'already-installed' : 'installed', model, bytes, dir });
    return 0;
  } catch (error) {
    const code = typeof error.code === 'string' ? error.code : 'failed';
    print({ status: 'error', code, message: safeMessage(error.message) });
    return 1;
  }
}

main(process.argv).then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    print({ status: 'error', code: 'failed', message: safeMessage(error && error.message) });
    process.exitCode = 1;
  },
);
