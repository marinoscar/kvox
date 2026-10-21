import PDFDocument from 'pdfkit';

import { drawBrandMark } from './pdf-brand-mark.js';

describe('drawBrandMark', () => {
  it('draws vectors into a real pdfkit document and keeps the text cursor', async () => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    const done = new Promise<void>((resolve) => doc.on('end', resolve));
    doc.text('before');
    const { x, y } = doc;
    drawBrandMark(doc, 50, 100, 48);
    expect([doc.x, doc.y]).toEqual([x, y]);
    doc.end();
    await done;
    const pdf = Buffer.concat(chunks);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.length).toBeGreaterThan(500);
  });
});
