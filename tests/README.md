# Bill OCR Tester

Test harness สำหรับ tune OCR parsing ใน `src/server.js` ของ project นี้

## ติดตั้ง

วางทั้งโฟลเดอร์ `tests/` ที่ root ของ project (ข้างๆ `src/`, `Bill/`) — ไม่ต้องลง dependency เพิ่ม ใช้ Node 18+ built-in fetch / FormData

## วิธีใช้

### 1. เปิด server

```bash
npm start
```

### 2. ตั้ง env

```bash
export ACCESS_CODE='<access code จาก ID sheet>'
# optional
export APP_URL='http://localhost:3000'
export BILL_DIR='Bill'
```

### 3. (ครั้งแรก) สร้าง ground truth

มี 3 ทาง — เลือกอันใดอันหนึ่ง:

**a. กรอกเอง** (แม่นยำสุด)
```bash
cp tests/expected/_example.json tests/expected/<billStem>.json
# แก้ products/total ตามรูปจริง
```

**b. ใช้ Gemini draft แล้วผมแก้ที่ผิด** (เร็วสุด)
```bash
node tests/bootstrap-expected.mjs
# จากนั้นเปิดแต่ละไฟล์ใน tests/expected/ แก้ field ที่ผิด
```

**c. ใช้ผล PaddleOCR ปัจจุบันเป็น baseline** (ไม่แนะนำ — ไม่มีทางเจอบั๊กที่มีอยู่)

### 4. รันทดสอบ + ดู diff

```bash
node tests/run-tester.mjs                  # ยิงทุกใบ
node tests/diff-report.mjs                 # ดู diff
node tests/visualize.mjs && open tests/report.html  # debug ด้วยตา
```

### 5. Tuning loop (ทำต่อใบ)

ทำตาม `tune-loop.md`

```bash
# ใบเดียว
node tests/run-tester.mjs --only=bill1.jpg
node tests/diff-report.mjs --only=bill1

# แก้ src/server.js ตาม root-cause hint
# แล้วรันซ้ำจน pass

# verify ไม่มี regression
node tests/run-tester.mjs && node tests/diff-report.mjs
```

## Flags

`run-tester.mjs`:
- `--only=<file>` — รันเฉพาะไฟล์เดียว
- `--engine=ocr|analyze` — เลือก engine (default ocr = PaddleOCR)
- `--both` — รันทั้ง 2 engine แล้ว save ไว้เปรียบเทียบ

`diff-report.mjs`:
- `--only=<stem>` — เฉพาะใบเดียว
- `--engine=ocr|analyze`
- `--json` — JSON output (เอาไป pipe ต่อได้)

## เคล็ด: ให้ Claude Code ทำ loop ให้

เปิด Claude Code ที่ root project แล้วบอก:

> รัน `node tests/run-tester.mjs && node tests/diff-report.mjs` —
> สำหรับทุกใบที่ FAIL ให้อ่าน `tests/results/<stem>.json` (raw OCR + parsed),
> เทียบกับ `tests/expected/<stem>.json`, อ่าน hint จาก diff-report,
> แก้ `src/server.js` ตาม `tests/tune-loop.md`,
> รันซ้ำจน pass แล้วทำใบถัดไป
> ห้ามแก้แล้วทำให้ใบที่เคย pass ตก
