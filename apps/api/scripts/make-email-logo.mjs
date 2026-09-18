#!/usr/bin/env node
// =============================================================================
// Regenerate the logo the API embeds in outbound email
// =============================================================================
//
//     node apps/api/scripts/make-email-logo.mjs
//
// Reads the brand master `apps/web/public/icons/icon-192.png` (written by
// `apps/web/scripts/generate-icons.py`, which is itself driven by
// `packages/shared/identity.json`) and writes a half-size copy to
// `apps/api/assets/email/logo.png` — the ONE file a rebranding fork has to
// replace, and the only image this application ever puts in a message.
//
// WHY A SEPARATE, SMALLER FILE RATHER THAN READING THE 192px MASTER AT RUNTIME
// -----------------------------------------------------------------------------
// Two independent reasons:
//
//   1. **The API image does not contain `apps/web`.** `apps/api/Dockerfile`'s
//      production stage copies `dist`, `prisma`, `scripts` and `assets` — and
//      nothing from the web app. A path into `apps/web/public` resolves on a
//      developer's checkout and is absent in every deployed container, which
//      is the worst possible place for that difference to show up.
//   2. **Every byte travels with every message.** A CID attachment is not
//      fetched, it is *inside* the mail, so a 192px icon rendered at 48px
//      would inflate every outbound message for resolution no client displays.
//      96px is a 2x retina copy of the 48x48 the layout renders, and 2x is an
//      exact halving of the master — no resampling artefacts, no filter choice
//      to argue about.
//
// WHY THIS IS ZERO-DEPENDENCY NODE RATHER THAN PILLOW/sharp/ImageMagick
// -----------------------------------------------------------------------------
// The same rule `apps/web/scripts/generate-icons.py` states in its own header:
// this repository is a TEMPLATE, and a fork that rebrands it must not be made
// to install an image toolchain. That script already asks for Pillow, run by
// hand, once; this one asks for nothing at all, because `node:zlib` is all an
// 8-bit RGBA PNG needs. Output is committed and this script is the documented,
// reproducible way to reproduce it — identical inputs, byte-identical output.
//
// ⚠ THE REDUCTION IS PREMULTIPLIED, AND THAT IS NOT A DETAIL. The master's
// rounded corners are antialiased against FULLY TRANSPARENT BLACK (RGBA
// 0,0,0,0). Averaging a 2x2 block channel-by-channel would pull those zeroed
// RGB values into the partially-opaque rim and ring the mark in dark navy —
// the classic halo that most naive downscalers produce, Pillow's own
// `Image.BOX` included. Multiplying by alpha first, averaging, then dividing
// back out keeps the rim the brand colour at a lower opacity, which is what it
// actually is.
// =============================================================================

import { readFileSync, writeFileSync } from 'node:fs';
import { deflateSync, inflateSync } from 'node:zlib';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const SOURCE = resolve(repoRoot, 'apps/web/public/icons/icon-192.png');
const TARGET = resolve(repoRoot, 'apps/api/assets/email/logo.png');

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** Decode an 8-bit RGBA, non-interlaced PNG into flat RGBA bytes. */
function decode(file) {
  if (!file.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('not a PNG');

  const width = file.readUInt32BE(16);
  const height = file.readUInt32BE(20);
  const [depth, colorType, , , interlace] = [file[24], file[25], file[26], file[27], file[28]];

  // Narrow on purpose: the only input is the committed brand master, and a
  // decoder that silently mishandled a palette or interlaced PNG would produce
  // a corrupt logo rather than an error anybody could act on.
  if (depth !== 8 || colorType !== 6 || interlace !== 0) {
    throw new Error(`expected 8-bit RGBA non-interlaced PNG, got depth=${depth} colorType=${colorType} interlace=${interlace}`);
  }

  const parts = [];
  for (let offset = 8; offset < file.length; ) {
    const length = file.readUInt32BE(offset);
    const type = file.toString('ascii', offset + 4, offset + 8);
    if (type === 'IDAT') parts.push(file.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
    if (type === 'IEND') break;
  }

  const raw = inflateSync(Buffer.concat(parts));
  const stride = width * 4;
  const out = Buffer.alloc(height * stride);

  const paeth = (a, b, c) => {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };

  let cursor = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[cursor++];
    for (let x = 0; x < stride; x++) {
      const value = raw[cursor + x];
      const left = x >= 4 ? out[y * stride + x - 4] : 0;
      const up = y > 0 ? out[(y - 1) * stride + x] : 0;
      const upLeft = x >= 4 && y > 0 ? out[(y - 1) * stride + x - 4] : 0;
      let restored;
      switch (filter) {
        case 0: restored = value; break;
        case 1: restored = value + left; break;
        case 2: restored = value + up; break;
        case 3: restored = value + ((left + up) >> 1); break;
        case 4: restored = value + paeth(left, up, upLeft); break;
        default: throw new Error(`unknown scanline filter ${filter}`);
      }
      out[y * stride + x] = restored & 0xff;
    }
    cursor += stride;
  }

  return { width, height, pixels: out };
}

/** Exact 2x reduction, premultiplied. See the header note on the dark halo. */
function halve({ width, height, pixels }) {
  if (width % 2 !== 0 || height % 2 !== 0) throw new Error('source must have even dimensions');

  const w = width / 2;
  const h = height / 2;
  const out = Buffer.alloc(w * h * 4);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (const [dy, dx] of [[0, 0], [0, 1], [1, 0], [1, 1]]) {
        const i = ((y * 2 + dy) * width + (x * 2 + dx)) * 4;
        const alpha = pixels[i + 3];
        r += pixels[i] * alpha;
        g += pixels[i + 1] * alpha;
        b += pixels[i + 2] * alpha;
        a += alpha;
      }
      const o = (y * w + x) * 4;
      // Divide the premultiplied sums by the ALPHA sum, not by 4: that is what
      // un-premultiplies. A fully transparent block has no colour to recover,
      // so it stays transparent black.
      out[o] = a === 0 ? 0 : Math.round(r / a);
      out[o + 1] = a === 0 ? 0 : Math.round(g / a);
      out[o + 2] = a === 0 ? 0 : Math.round(b / a);
      out[o + 3] = Math.round(a / 4);
    }
  }

  return { width: w, height: h, pixels: out };
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crcInput = Buffer.concat([head.subarray(4), data]);
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(crcInput) >>> 0, 0);
  return Buffer.concat([head, data, tail]);
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c ^ -1;
}

/** Encode flat RGBA back to a PNG. Every scanline uses the Paeth filter. */
function encode({ width, height, pixels }) {
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));

  const paeth = (a, b, c) => {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };

  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 4;
    for (let x = 0; x < stride; x++) {
      const left = x >= 4 ? pixels[y * stride + x - 4] : 0;
      const up = y > 0 ? pixels[(y - 1) * stride + x] : 0;
      const upLeft = x >= 4 && y > 0 ? pixels[(y - 1) * stride + x - 4] : 0;
      raw[rowStart + 1 + x] = (pixels[y * stride + x] - paeth(left, up, upLeft)) & 0xff;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // colour type: RGBA
  ihdr[10] = 0;  // deflate
  ihdr[11] = 0;  // adaptive filtering
  ihdr[12] = 0;  // no interlace

  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    // Level 9 and a fixed strategy so repeated runs are byte-identical.
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const source = decode(readFileSync(SOURCE));
const reduced = halve(source);
const png = encode(reduced);

writeFileSync(TARGET, png);

console.log(
  `wrote ${TARGET} — ${reduced.width}x${reduced.height}, ${png.length} bytes ` +
    `(from ${source.width}x${source.height})`,
);
