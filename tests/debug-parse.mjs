// Quick debug: run parseOcrExpense on the OCR text + entries from a result file.
process.env.NODE_ENV = 'test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseOcrExpense } from '../src/server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const file = process.argv[2] ?? 'MATCHA';
const resultPath = path.join(__dirname, 'results', `${file}.json`);

const result = JSON.parse(await fs.readFile(resultPath, 'utf8'));
const rawText = result.results.ocr.body.rawText;
const entries = result.results.ocr.body._debugEntries ?? result.results.ocr.body.entries ?? [];

console.log('=== entries count:', entries.length);

// Manually replicate getOcrRows to see row text
function estimateDocumentTilt(positioned) {
  const slopes = [];
  const limit = Math.min(positioned.length, 80);
  for (let i = 0; i < limit; i++) {
    for (let j = i + 1; j < limit; j++) {
      const a = positioned[i], b = positioned[j];
      const dx = b.x1 - a.x1;
      const dy = b.centerY - a.centerY;
      const avgHeight = (a.height + b.height) / 2;
      if (Math.abs(dx) > avgHeight * 3 && Math.abs(dy) < avgHeight * 1.5) {
        slopes.push(dy / dx);
      }
    }
  }
  if (slopes.length < 5) return 0;
  slopes.sort((a, b) => a - b);
  return slopes[Math.floor(slopes.length / 2)];
}

const positioned = entries
  .filter(e => e?.text && Array.isArray(e.box) && e.box.length === 4)
  .map(e => {
    const [x1, y1, x2, y2] = e.box.map(Number);
    return { text: e.text.trim(), x1, x2, y1, y2, centerY: (y1 + y2) / 2, height: Math.max(1, y2 - y1) };
  });
const tilt = estimateDocumentTilt(positioned);
console.log('tilt:', tilt);
const sorted = positioned
  .map(e => ({ ...e, correctedY: e.centerY - tilt * (e.x1 + e.x2) / 2 }))
  .sort((a, b) => a.correctedY - b.correctedY || a.x1 - b.x1);
const rows = [];
for (const entry of sorted) {
  const lastRow = rows[rows.length - 1];
  const tolerance = Math.max(3, entry.height * 0.6);
  if (!lastRow || Math.abs(lastRow.correctedY - entry.correctedY) > tolerance) {
    rows.push({ correctedY: entry.correctedY, items: [entry] });
    continue;
  }
  lastRow.items.push(entry);
  lastRow.correctedY = lastRow.items.reduce((s, i) => s + i.correctedY, 0) / lastRow.items.length;
}
console.log('\n=== ROWS (after Y grouping) ===');
rows.forEach((row, i) => {
  const items = row.items.sort((a, b) => a.x1 - b.x1);
  const text = items.map(i => i.text).join(' ').replace(/\s{2,}/g, ' ').trim();
  console.log(`${String(i).padStart(3)}: cY=${Math.round(row.correctedY)}  "${text}"`);
});

console.log('\n=== FINAL PRODUCTS (from server) ===');
console.log(JSON.stringify(result.results.ocr.body.receipt.products, null, 2));

console.log('\n=== Re-parse with parseOcrExpense ===');
const reparsed = parseOcrExpense(rawText, entries);
console.log(JSON.stringify(reparsed.products, null, 2));
console.log('total:', reparsed.total);
