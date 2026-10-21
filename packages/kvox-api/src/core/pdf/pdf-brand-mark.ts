// =============================================================================
// The brand mark, drawn as vectors into a pdfkit document
// =============================================================================
//
// Vectors, not an embedded bitmap: the logo stays sharp at any zoom and costs a few
// hundred bytes. The geometry is the contract's (`@marinoscar/kvox-contract/brand`),
// scaled from its 32 canvas to `size` points, painted in `BrandMark.tsx`'s order.
//
// pdfkit is an optional peer loaded lazily by the exporters, so this file only
// narrows `KvoxPdfDocument` (an opaque `object`) to the drawing methods it uses.
// =============================================================================

import type PDFDocumentType from 'pdfkit';

import {
  KVOX_IDENTITY,
  MARK_ACCENT,
  MARK_ARMS,
  MARK_BARS,
  MARK_CANVAS,
  MARK_INK,
  MARK_PLATE_RADIUS,
  MARK_STEM,
  MARK_STROKE,
} from '@marinoscar/kvox-contract/brand';

import type { KvoxPdfDocument } from './pdf-fonts.js';

/**
 * Draws the brand mark with its top-left corner at (`x`, `y`), `size` points square.
 *
 * The graphics state is saved and restored, and the text cursor (`x`, `y` of the
 * document) is put back, so a caller can draw the mark in the middle of flowing text.
 *
 * @param target - a pdfkit document.
 * @param x - left edge, in points.
 * @param y - top edge, in points.
 * @param size - side of the mark, in points.
 * @stability experimental
 */
export function drawBrandMark(target: KvoxPdfDocument, x: number, y: number, size: number): void {
  const pdf = target as InstanceType<typeof PDFDocumentType>;
  const k = size / MARK_CANVAS;
  const cursorX = pdf.x;
  const cursorY = pdf.y;

  pdf.save();
  pdf.roundedRect(x, y, size, size, MARK_PLATE_RADIUS * k).fill(KVOX_IDENTITY.themeColor);
  pdf.roundedRect(
    x + MARK_STEM.x * k,
    y + MARK_STEM.y * k,
    MARK_STEM.width * k,
    MARK_STEM.height * k,
    MARK_STEM.rx * k,
  ).fill(MARK_INK);
  pdf.lineCap('round').lineWidth(MARK_STROKE * k).strokeColor(MARK_INK);
  for (const a of MARK_ARMS) {
    pdf.moveTo(x + a.x1 * k, y + a.y1 * k).lineTo(x + a.x2 * k, y + a.y2 * k).stroke();
  }
  for (const bar of MARK_BARS) {
    pdf.roundedRect(x + bar.x * k, y + bar.y * k, bar.width * k, bar.height * k, bar.rx * k).fill(MARK_ACCENT);
  }
  pdf.restore();

  pdf.x = cursorX;
  pdf.y = cursorY;
}
