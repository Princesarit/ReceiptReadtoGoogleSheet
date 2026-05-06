import assert from "node:assert/strict";
import { parseOcrExpense } from "../src/server.js";

function makeEntries(rows) {
  const entries = [];
  const leftX = 40;
  const midX = 80;
  const rightX = 720;
  const rowHeight = 18;

  rows.forEach((row, index) => {
    const y = index * 28;
    const parts = Array.isArray(row) ? row : [row];

    parts.forEach((part, partIndex) => {
      const text = typeof part === "string" ? part : part.text;
      const x = part.x ?? (partIndex === parts.length - 1 && /^\$?\d/.test(text) ? rightX : partIndex ? midX : leftX);
      entries.push({
        text,
        box: [x, y, x + Math.max(40, text.length * 10), y + rowHeight],
      });
    });
  });

  return entries;
}

function productRows(expense) {
  return expense.products.map((product) => [
    product.name,
    product.qty,
    product.total,
  ]);
}

const asianRows = [
  [{ text: "GCB FROZEN CHA-OM LEAF 150G", x: 40 }, { text: "$3.70", x: 560 }],
  [{ text: "P**N GILLED BANANA W/ COCONUT SCE", x: 40 }, { text: "$15.00", x: 560 }],
  "LV YINSI RICE VERMICELLI 300G S",
  [{ text: "3 @ $2.10", x: 40 }, { text: "$6.30", x: 560 }],
  [{ text: "OCHA DRIED RED COTTON FLOWER80G", x: 40 }, { text: "$3.99", x: 560 }],
  [{ text: "SCALE SHRIMP PASTE 95G", x: 40 }, { text: "$1.99", x: 560 }],
  [{ text: "THAI BOY COOKING TAMARIND 375G", x: 40 }, { text: "$3.50", x: 560 }],
  [{ text: "TONG DRIED BUTTERFLY PEA 80G", x: 40 }, { text: "$7.20", x: 560 }],
  [{ text: "TOUR NOAW", x: 40 }, { text: "$4.99", x: 560 }],
  [{ text: "Subtotal", x: 40 }, { text: "$46.67", x: 560 }],
  [{ text: "Rounding", x: 40 }, { text: "$-0.02", x: 560 }],
  [{ text: "Total (10 items)", x: 40 }, { text: "$46.65", x: 560 }],
];

const woolworthsRows = [
  "Farmers Own 3L Full Cream",
  [{ text: "Qty 2 @ $5.85 each", x: 40 }, { text: "11.70", x: 720 }],
  "Just Caught Crumbed Squid Rings 800g",
  [{ text: "Qty 3 @ $12.40 each", x: 40 }, { text: "37.20", x: 720 }],
  "Schweppes Lemonade 375ml",
  [{ text: "1 30Pk", x: 40 }, { text: "26.00", x: 720 }],
  "^#Coca Cola Classic",
  [{ text: "c 24x375ml", x: 40 }, { text: "25.00", x: 720 }],
  "^#Coca Cola Zero Sugar",
  [{ text: "r 24x375ml", x: 40 }, { text: "25.00", x: 720 }],
  [{ text: "WW Corn Kernels 1kg", x: 40 }, { text: "5.00", x: 720 }],
  [{ text: "^ Ingham's Chicken Breast Nuggets Orig 1kg", x: 40 }, { text: "11.00", x: 720 }],
  "Essentials Butter Unsalted 500g",
  [{ text: "Qty 4 @ $7.00 each", x: 40 }, { text: "28.00", x: 720 }],
  [{ text: "^HM&Ms Minis Tube 35g", x: 40 }, { text: "5.00", x: 720 }],
  [{ text: "^#Pocky Biscuit Stick Cookies & Cream 40g", x: 40 }, { text: "1.70", x: 720 }],
  [{ text: "^#Pocky Biscuit Chocolate 47g", x: 40 }, { text: "3.40", x: 720 }],
  [{ text: "Qty 2 @ $1.70 each", x: 40 }],
  [{ text: "^#Pocky Biscuit Strawb 45g", x: 40 }, { text: "3.40", x: 720 }],
  [{ text: "Qty 2 @ $1.70 each", x: 40 }],
  [{ text: "#Haribo Goldbears 400G", x: 40 }, { text: "5.00", x: 720 }],
  [{ text: "Golden Circle Swt Pineapple Juice 1L", x: 40 }, { text: "3.60", x: 720 }],
  [{ text: "#Golden Circle Fruit Drink Orange Brst 1L", x: 40 }, { text: "2.00", x: 720 }],
  "#Golden Circle Fruit Drink Apple 1L",
  [{ text: "Qty 2 @ $2.00 each", x: 40 }, { text: "4.00", x: 720 }],
  [{ text: "26 SUBTOTAL", x: 40 }, { text: "$197.00", x: 720 }],
  [{ text: "TOTAL", x: 40 }, { text: "$197.00", x: 720 }],
];

const asian = parseOcrExpense(
  asianRows.map((row) => (Array.isArray(row) ? row.map((part) => part.text).join(" ") : row)).join("\n"),
  makeEntries(asianRows)
);

assert.deepEqual(productRows(asian), [
  ["GCB FROZEN CHA-OM LEAF 150G", "1", 3.7],
  ["PN GILLED BANANA W/ COCONUT SCE", "1", 15],
  ["LV YINSI RICE VERMICELLI 300G S", "3", 6.3],
  ["OCHA DRIED RED COTTON FLOWER80G", "1", 3.99],
  ["SCALE SHRIMP PASTE 95G", "1", 1.99],
  ["THAI BOY COOKING TAMARIND 375G", "1", 3.5],
  ["TONG DRIED BUTTERFLY PEA 80G", "1", 7.2],
  ["TOUR NOAW", "1", 4.99],
]);

const woolworths = parseOcrExpense(
  woolworthsRows.map((row) => (Array.isArray(row) ? row.map((part) => part.text).join(" ") : row)).join("\n"),
  makeEntries(woolworthsRows)
);

assert.deepEqual(productRows(woolworths), [
  ["Farmers Own 3L Full Cream", "2", 11.7],
  ["Just Caught Crumbed Squid Rings 800g", "3", 37.2],
  ["Schweppes Lemonade 375ml 30Pk", "1", 26],
  ["Coca Cola Classic 24x375ml", "1", 25],
  ["Coca Cola Zero Sugar 24x375ml", "1", 25],
  ["WW Corn Kernels 1kg", "1", 5],
  ["Ingham's Chicken Breast Nuggets Orig 1kg", "1", 11],
  ["Essentials Butter Unsalted 500g", "4", 28],
  ["M&Ms Minis Tube 35g", "1", 5],
  ["Pocky Biscuit Stick Cookies & Cream 40g", "1", 1.7],
  ["Pocky Biscuit Chocolate 47g", "2", 3.4],
  ["Pocky Biscuit Strawb 45g", "2", 3.4],
  ["Haribo Goldbears 400G", "1", 5],
  ["Golden Circle Swt Pineapple Juice 1L", "1", 3.6],
  ["Golden Circle Fruit Drink Orange Brst 1L", "1", 2],
  ["Golden Circle Fruit Drink Apple 1L", "2", 4],
]);

const woolworthsSameLineTotalRows = [
  [{ text: "Farmers Own 3L Full Cream", x: 40 }, { text: "11.70", x: 720 }],
  [{ text: "Qty 2 @ $5.85 each", x: 40 }],
  [{ text: "Just Caught Crumbed Squid Rings 800g", x: 40 }, { text: "37.20", x: 720 }],
  [{ text: "Qty 3 @ $12.40 each", x: 40 }],
  [{ text: "^#Coca Cola Classic", x: 40 }],
  [{ text: "c 24x375ml", x: 40 }, { text: "25.00", x: 720 }],
  [{ text: "TOTAL", x: 40 }, { text: "$73.90", x: 720 }],
];

const woolworthsSameLineTotal = parseOcrExpense(
  woolworthsSameLineTotalRows
    .map((row) => (Array.isArray(row) ? row.map((part) => part.text).join(" ") : row))
    .join("\n"),
  makeEntries(woolworthsSameLineTotalRows)
);

assert.deepEqual(productRows(woolworthsSameLineTotal), [
  ["Farmers Own 3L Full Cream", "2", 11.7],
  ["Just Caught Crumbed Squid Rings 800g", "3", 37.2],
  ["Coca Cola Classic 24x375ml", "1", 25],
]);

const fragmentedWoolworthsRaw = `Woolworths
The fresh food people
1364 Beecroft PH: 02 9450 6727
Cnr Hannah St and Beecroft Rd
TAX INVOICE - ABN 88 000 014 675
POS 003 TRANS 6634 18:00 24/04/2026
4
Farmers Own 3L Ful1 Cream
11.70
Qty2@
each
$5.85
Just Caught Crumbed Squid Rings 800g
37.20
Qty
30
$12.40
each
#Schweppes
s Lemonade
e 375ml
1 30Pk
26.00
^HCoca
Cola
Classic
c 24x375ml
25.00
AHCoca Cola
a Zero
0 Sugar
r 24x375m1
25.00
WW Corn Kernels 1kg
5.00
^ Ingham's Chicken Breast Nuggets Orig 1kg
11.00
Essentials Butter Unsalted 500g
Qty 4 $7.00
each
28.00
^HM&Ms Hinis Tube 35g
Qty.
20
$2.50
each
5.00
^HPocky Biscuit Stick Cookies & Cream 40g
1.70
^HPocky Biscuit Chocolate 47g
Qty
20
$1.70
each
3.40
^HPocky Biscuit Strawb 45g
Qty
2 @
$1.70
each
3.40
#Haribo Goldbears 400G
Golden Circle Swt Pineapple Juice 1L
5.00
#Golden Circle Fruit Drink Orange Brst 1L
3.60
#Golden Circle Fruit Drink Apple 1l.
2.00
Qty 20
$2.00
each
4.00
26 SUBTOTAL
$197.00
TOTAL
$197.0`;

const fragmentedWoolworths = parseOcrExpense(fragmentedWoolworthsRaw, []);
const fragmentedRows = productRows(fragmentedWoolworths);

assert.ok(
  fragmentedRows.some(([name, qty, price]) => name === "Coca Cola Classic 24x375ml" && qty === "1" && price === 25)
);
assert.ok(
  fragmentedRows.some(([name, qty, price]) => name === "Coca Cola Zero Sugar 24x375m1" && qty === "1" && price === 25)
);
assert.ok(
  fragmentedRows.some(([name, qty, price]) => name === "Schweppes Lemonade 375ml 30Pk" && qty === "1" && price === 26)
);
assert.equal(fragmentedRows.some(([name]) => name === "24x375ml" || name === "24x375m1"), false);

console.log("parser fixtures passed");
