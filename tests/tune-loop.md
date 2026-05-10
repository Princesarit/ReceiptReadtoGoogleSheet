# Tuning Loop Playbook

ใช้คู่กับ `run-tester.mjs` + `diff-report.mjs` + `visualize.mjs`
ทุกครั้งที่ diff-report report failure → หาแถวตรงกับ symptom ในตารางข้างล่าง → แก้ที่ฟังก์ชันที่ระบุ → รัน loop ใหม่

## วงจรการ tune (ทำต่อใบ ทีละใบ)

1. `node tests/run-tester.mjs --only=<bill>.jpg` — ยิงใบนั้นใบเดียว
2. `node tests/diff-report.mjs --only=<billStem>` — ดู diff
3. ถ้าไม่ pass → เปิด `tests/report.html` (จาก `visualize.mjs`) → ดูรูป + raw OCR + parsed เคียงข้างกัน
4. หา root cause ในตารางด้านล่าง → แก้ `src/server.js` (หรือ `scripts/paddle_ocr.py`)
5. กลับไปข้อ 1 จนกว่าจะ pass
6. **Verify**: รัน `node tests/run-tester.mjs --only=<bill>.jpg` อีกครั้งให้แน่ใจว่ายัง pass อยู่ (ไม่ flaky)
7. รัน full suite `node tests/run-tester.mjs && node tests/diff-report.mjs` เช็คว่าไม่พังใบอื่น (regression)
8. ไปใบถัดไป

## Symptom → Root Cause → Fix Location

| Symptom | Likely Cause | Fix in |
|---|---|---|
| `total: expected X, got null` และ raw text **มี** keyword "total/amount/balance" | regex ใน `findTotal()` ไม่ match รูปแบบนี้ (เช่น มี currency, colon, spacing แปลก) | `findTotal()` ใน `src/server.js` — เพิ่ม pattern |
| `total` หาย และ raw text **ไม่มี** keyword | PaddleOCR อ่านบรรทัด total ไม่ออก → ขึ้นกับ `lang="en"` หรือคุณภาพรูป | `scripts/paddle_ocr.py` — เปลี่ยน `lang` เป็น `"th"` หรือ `["en","th"]` (ถ้า PaddleOCR version รองรับ); หรือเพิ่ม preprocessing (resize/threshold) |
| สินค้าใน expected **หาย** จาก actual | (a) `skipWords` กว้างไป กิน line สินค้า  (b) `getOcrRows()` Y-tolerance ผิด ทำให้ rows merge/split  (c) ราคาอยู่ไกลจากชื่อมาก เกิน X threshold | `skipWords` regex / `getOcrRows()` / `extractProductsFromRows()` |
| สินค้า **เกิน** (header, footer, address ถูกอ่านเป็นสินค้า) | `skipWords` แคบไป — ไม่ได้ skip "subtotal", "vat", ที่อยู่ ฯลฯ | `skipWords` regex — เพิ่ม pattern |
| Qty ผิด (เช่น expected 2 ได้ 1) | parser แยก qty/price คนละ column ไม่ออก ในกรณีบรรทัดมีแค่ "ชื่อ + ราคา" (ไม่มี qty ชัด) | `extractProductsFromRows()` — logic เดา qty จาก context |
| Price ผิด (เช่น 1234.50 → 123450, หรือ 1,234 → 1) | regex จับตัวเลขไม่รับ comma / decimal point หลายแบบ; หรือเอา column ผิดเพราะ entry หลายตัว | regex parse number / column assignment |
| ทุก field ผิดเยอะมาก | `chooseBestParsedProducts()` เลือกผลลัพธ์จาก row-based vs text-block แล้วเลือกผิด | `chooseBestParsedProducts()` — ปรับ scoring |
| Default `status="Paid"`, `paymentType="Cash"` ไม่ตรงรูป | เป็น hardcoded — ไม่ได้ detect จาก receipt | Add detection ใน `parseOcrExpense()` (จับ keyword "PAID", "CASH", "VISA", "QR", ฯลฯ) |
| ภาษาไทย parse ไม่ได้เลย | PaddleOCR `lang="en"` | `scripts/paddle_ocr.py` |

## เคล็ดลับ regex ที่ใช้บ่อย

```js
// total keyword (ขยายจาก findTotal เดิม)
/^(?:grand\s*)?total(?:\s*amount)?\s*[:\-]?\s*\$?([\d,]+\.?\d{0,2})$/i
/^amount\s*due\s*[:\-]?\s*\$?([\d,]+\.?\d{0,2})$/i
/^balance(?:\s*due)?\s*[:\-]?\s*\$?([\d,]+\.?\d{0,2})$/i

// number ที่รองรับ comma + decimal
/(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)/

// skip words ที่ปลอดภัย (anchor ให้แม่น อย่ากว้างไป)
/^(?:sub\s*total|subtotal|vat|tax|service|change|cash\s*tendered|tendered|round(?:ing)?|discount)\s*[:\-]?/i
// ⚠️ อย่าใช้ /cash/i ลอย ๆ — มันจะกินสินค้าที่ชื่อมีคำว่า "Cashew" ฯลฯ
```

## เมื่อไหร่ที่ "ตรงแล้ว" (definition of done ต่อใบ)

ใบหนึ่ง pass ก็ต่อเมื่อ:
- [ ] `total` ตรง (tolerance 0.5 บาท)
- [ ] จำนวนสินค้าตรง (ไม่ขาด ไม่เกิน)
- [ ] ทุกสินค้า similarity ≥ 0.6 กับชื่อใน expected
- [ ] qty ตรงทุกตัว
- [ ] price ตรงทุกตัว (tolerance 0.5)
- [ ] รัน 2 ครั้งติด ได้ผลเหมือนกัน (ไม่ flaky)

เมื่อ pass แล้วก่อนจะข้าม **ต้องรัน full suite** อีกครั้งให้แน่ใจว่าการแก้ไม่ทำให้ใบที่เคย pass ตกลง — ถ้ามี regression ให้แก้จนทุกใบที่เคย pass กลับมา pass ก่อน
