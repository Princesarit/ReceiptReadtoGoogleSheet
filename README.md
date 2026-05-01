# Receipt Prototype

Express app for uploading or photographing receipt images, extracting receipt data with OCR, and appending the result to Google Sheets.

## Project structure

- `src/server.js` - Express server and API routes
- `src/views/accessPage.js` - access code page
- `src/views/receiptPage.js` - receipt upload page
- `public/` - frontend assets such as CSS and browser JavaScript

## Setup

1. Copy `.env.example` to `.env`
2. Fill in these values:
   - `PADDLE_OCR_PYTHON` (optional, defaults to `python`)
   - `PADDLE_OCR_CACHE_DIR` (optional, defaults to `.paddle-cache`)
   - `PADDLE_OCR_TIMEOUT_MS` (optional, defaults to `120000`)
   - `GEMINI_API_KEY` (optional legacy analyzer)
   - `GEMINI_MODEL` (optional, defaults to `gemini-2.5-flash`)
   - `GEMINI_MAX_RETRIES` (optional, defaults to `3`)
   - `GOOGLE_SHEETS_SPREADSHEET_ID`
   - `GOOGLE_SHEETS_WORKSHEET_NAME` (defaults to `EXPENSES`)
   - `GOOGLE_SHEETS_ID_WORKSHEET_NAME` (optional, defaults to `ID`)
   - `GOOGLE_SERVICE_ACCOUNT_EMAIL`
   - `GOOGLE_PRIVATE_KEY`
3. Share your Google Sheet with the service account email as an editor
4. Add an `ID` tab with `ID`, `NAME`, and `PASS` columns. The home page checks the `PASS` column before allowing access to the upload page.

## Run

```bash
npm install
npm start
```

Open `http://localhost:3000`

## PaddleOCR setup

PaddleOCR runs locally on your server, so it has no per-request API quota. The machine still pays the compute cost, and the host must allow Python dependencies and model files.

Use Python 3.9-3.12 for the safest install path. The app calls the Python command from `PADDLE_OCR_PYTHON`.

```bash
python -m pip install paddlepaddle==3.2.0 -i https://www.paddlepaddle.org.cn/packages/stable/cpu/
python -m pip install paddleocr
```

If PaddleOCR is not installed, the upload page falls back to browser OCR with Tesseract.js.

## What gets extracted

- Product names as separate rows
- Product or receipt total
- Status as `Paid` or `Unpaid`
- Due Date when the receipt is unpaid
- Payment_Type as `Cash`, `Credit Card`, or `Online Banking`

The `EXPENSES` tab uses these columns:

- `Date`
- `Product`
- `Price`
- `Status`
- `Due Date`
- `Payment_Type`

Each submitted receipt also writes a summary label `Total` in column G and the receipt total in column H on the last product row.
