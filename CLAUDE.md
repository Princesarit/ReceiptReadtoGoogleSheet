# Bill Detection — CLAUDE.md

## Project Summary
Node.js + Express web app ที่อ่าน receipt/bill รูปภาพด้วย OCR แล้วบันทึกรายการลง Google Sheets อัตโนมัติ รองรับ 2 engine: PaddleOCR (local Python) และ Gemini AI (cloud).

## Stack
- **Backend**: Node.js ESM, Express 5, Multer
- **OCR**: PaddleOCR via Python subprocess (`scripts/paddle_ocr.py`) + Gemini AI fallback
- **AI**: `@google/genai` (Gemini 2.5 Flash)
- **Storage**: Google Sheets API v4 (googleapis)
- **Validation**: Zod
- **Frontend**: Vanilla JS (`public/upload.js`, `public/home.js`)
- **Auth**: HMAC-SHA256 signed token in httpOnly cookie (12h expiry)

## Key Files
| File | Purpose |
|------|---------|
| `src/server.js` | Main server — routes, OCR parsing logic, Sheets integration |
| `scripts/paddle_ocr.py` | Python script ที่รัน PaddleOCR แล้ว output JSON |
| `public/upload.js` | Frontend UI สำหรับอัปโหลดและแก้ไข receipt |
| `src/views/receiptPage.js` | HTML สำหรับหน้า upload |
| `src/views/accessPage.js` | HTML สำหรับหน้า login |

## Run & Dev
```bash
npm start       # production
npm run dev     # watch mode (node --watch)
```
Server: `http://localhost:3000`

## API Endpoints
| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | Login page |
| POST | `/api/login` | Auth via access code (จาก ID sheet) |
| GET | `/upload` | Receipt upload page (ต้อง auth) |
| POST | `/api/receipts/ocr` | อ่าน receipt ด้วย PaddleOCR |
| POST | `/api/receipts/analyze` | อ่าน receipt ด้วย Gemini AI |
| POST | `/api/receipts/submit` | บันทึกลง Google Sheets |
| GET | `/api/health` | ตรวจสอบ config status |

## OCR Pipeline (PaddleOCR path)
1. `extractPaddleOcrResult()` — รัน Python, ได้ `text` + `entries[]` (พร้อม bounding box)
2. `parseOcrExpense(text, entries)` — แปลง raw OCR เป็น expense object
   - `getOcrRows(entries)` — จัดกลุ่ม entries ตาม Y position เป็น rows
   - `extractProductsFromRows()` — parse สินค้า+ราคา โดยใช้ตำแหน่ง X
   - `extractProductsFromTextBlocks()` — parse จาก text ล้วน (fallback)
   - `chooseBestParsedProducts()` — เลือก result ที่ดีกว่า
   - `findTotal()` — หา total จาก keyword regex
3. Default: `status="Paid"`, `paymentType="Cash"`

## Google Sheets Schema
Sheet: `EXPENSES` — คอลัมน์ A-I
```
A: Date (DD/MM/YYYY HH:mm)  B: Product  C: Qty  D: Price
E: Status  F: Due Date  G: Payment_Type  H: "Total" label  I: Total amount
```
Sheet: `ID` — คอลัมน์ A=ID, B=Name, C=Password (access code)

## Environment Variables
```
GEMINI_API_KEY, GEMINI_MODEL, GEMINI_MAX_RETRIES
PADDLE_OCR_PYTHON, PADDLE_OCR_CACHE_DIR, PADDLE_OCR_TIMEOUT_MS
GOOGLE_SHEETS_SPREADSHEET_ID, GOOGLE_SHEETS_WORKSHEET_NAME
GOOGLE_SHEETS_ID_WORKSHEET_NAME, GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_PRIVATE_KEY
APP_TIME_ZONE (default: Asia/Bangkok)
```

## Known Parsing Limitations
- PaddleOCR ใช้ `lang="en"` — ภาษาไทยใน receipt อาจอ่านไม่ถูก
- `findTotal()` รองรับแค่ keyword ภาษาอังกฤษ (total, amount due, balance ฯลฯ)
- `skipWords` regex กว้างมาก — อาจตัดบรรทัดสินค้าที่มี keyword เช่น "cash" ออก
- Status และ paymentType ใน OCR path ใช้ default เสมอ ไม่ได้ detect จาก receipt
