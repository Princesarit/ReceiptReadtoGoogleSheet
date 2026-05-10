#!/usr/bin/env node
/**
 * Visualizer
 * ----------
 * สร้าง tests/report.html แสดง รูปบิล + raw OCR + parsed table + expected ข้างๆกัน
 * เปิดในเบราว์เซอร์เพื่อ debug ด้วยตา
 *
 * Usage: node tests/visualize.mjs
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const RESULTS_DIR = path.join(__dirname, 'results');
const EXPECTED_DIR = path.join(__dirname, 'expected');
const BILL_DIR = path.join(ROOT, process.env.BILL_DIR ?? 'Bill');
const OUT = path.join(__dirname, 'report.html');

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  }),
);
const ENGINE = args.engine ?? 'ocr';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));

async function loadJson(p) {
  try { return JSON.parse(await fs.readFile(p, 'utf8')); } catch { return null; }
}

function productTable(items, title) {
  if (!items?.length) return `<div class="empty">— ไม่มี ${esc(title)} —</div>`;
  const rows = items.map((p) => `
    <tr><td>${esc(p.product)}</td><td>${esc(p.qty ?? '')}</td><td>${esc(p.price ?? '')}</td></tr>`).join('');
  return `<table><thead><tr><th>Product</th><th>Qty</th><th>Price</th></tr></thead><tbody>${rows}</tbody></table>`;
}

async function run() {
  const resultFiles = (await fs.readdir(RESULTS_DIR).catch(() => []))
    .filter((f) => f.endsWith('.json'))
    .sort();

  const billFiles = await fs.readdir(BILL_DIR).catch(() => []);
  const billMap = Object.fromEntries(billFiles.map((f) => [path.basename(f, path.extname(f)), f]));

  const sections = [];
  for (const rf of resultFiles) {
    const stem = path.basename(rf, '.json');
    const actual = await loadJson(path.join(RESULTS_DIR, rf));
    const expected = await loadJson(path.join(EXPECTED_DIR, rf));
    const er = actual?.results?.[ENGINE]?.body ?? {};
    const parsed = er.expense ?? er.data ?? er;
    const raw = er.rawText ?? er.text ?? er.ocrText ?? '';
    const billFile = billMap[stem];
    const imgPath = billFile ? path.relative(__dirname, path.join(BILL_DIR, billFile)) : null;

    sections.push(`
    <section>
      <h2>${esc(stem)}</h2>
      <div class="grid">
        <div class="col">
          <h3>Image</h3>
          ${imgPath ? `<img src="${esc(imgPath)}" alt="${esc(stem)}">` : '<div class="empty">no image</div>'}
        </div>
        <div class="col">
          <h3>Raw OCR text</h3>
          <pre>${esc(raw || '(empty)')}</pre>
        </div>
        <div class="col">
          <h3>Parsed (actual)</h3>
          <div class="meta">total: <b>${esc(parsed.total ?? '—')}</b></div>
          ${productTable(parsed.products ?? parsed.items, 'products')}
        </div>
        <div class="col">
          <h3>Expected</h3>
          ${expected ? `<div class="meta">total: <b>${esc(expected.total ?? '—')}</b></div>${productTable(expected.products, 'products')}` : '<div class="empty">no ground truth</div>'}
        </div>
      </div>
    </section>`);
  }

  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Bill OCR Report</title>
<style>
  body { font: 14px/1.4 -apple-system, system-ui, sans-serif; margin: 0; background: #0f1115; color: #e6e6e6; }
  header { padding: 16px 24px; background: #1a1d24; border-bottom: 1px solid #2a2e38; position: sticky; top: 0; }
  section { padding: 24px; border-bottom: 1px solid #2a2e38; }
  h2 { margin: 0 0 16px; color: #ffd166; }
  h3 { margin: 0 0 8px; font-size: 13px; text-transform: uppercase; letter-spacing: .5px; color: #8aa; }
  .grid { display: grid; grid-template-columns: 1fr 1fr 1fr 1fr; gap: 16px; }
  .col { background: #161922; padding: 12px; border-radius: 8px; min-width: 0; }
  img { max-width: 100%; border-radius: 4px; }
  pre { white-space: pre-wrap; word-break: break-word; font-size: 12px; background: #0b0d12; padding: 8px; border-radius: 4px; max-height: 400px; overflow: auto; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th, td { text-align: left; padding: 4px 6px; border-bottom: 1px solid #2a2e38; }
  th { color: #8aa; font-weight: 500; }
  .meta { font-size: 12px; margin-bottom: 8px; color: #8aa; }
  .empty { color: #556; font-style: italic; padding: 8px 0; }
  @media (max-width: 1100px) { .grid { grid-template-columns: 1fr 1fr; } }
</style></head>
<body>
<header><b>Bill OCR Report</b> · engine=<code>${esc(ENGINE)}</code> · ${resultFiles.length} bill(s)</header>
${sections.join('')}
</body></html>`;

  await fs.writeFile(OUT, html);
  console.log(`✓ wrote ${path.relative(ROOT, OUT)}`);
  console.log(`  เปิดด้วย:  open ${path.relative(ROOT, OUT)}`);
}

run().catch((e) => { console.error(e); process.exit(1); });
