import "dotenv/config";
import express from "express";
import multer from "multer";
import { GoogleGenAI, Type } from "@google/genai";
import { google } from "googleapis";
import { z } from "zod";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { renderAccessPage } from "./views/accessPage.js";
import { renderReceiptPage } from "./views/receiptPage.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const execFileAsync = promisify(execFile);

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

const PORT = process.env.PORT || 3000;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const GEMINI_MAX_RETRIES = Number(process.env.GEMINI_MAX_RETRIES || 2);
const PADDLE_OCR_PYTHON = process.env.PADDLE_OCR_PYTHON || "python";
const PADDLE_OCR_CACHE_DIR = path.resolve(
  projectRoot,
  process.env.PADDLE_OCR_CACHE_DIR || ".paddle-cache"
);
const PADDLE_OCR_SCRIPT = path.join(projectRoot, "scripts", "paddle_ocr.py");
const PADDLE_OCR_TIMEOUT_MS = Number(process.env.PADDLE_OCR_TIMEOUT_MS || 120000);
const ID_SHEET_NAME = process.env.GOOGLE_SHEETS_ID_WORKSHEET_NAME || "ID";
const EXPENSE_SHEET_NAME = process.env.GOOGLE_SHEETS_WORKSHEET_NAME || "EXPENSES";
const APP_TIME_ZONE = process.env.APP_TIME_ZONE || "Asia/Bangkok";
const AUTH_COOKIE_NAME = "receipt_auth";
const AUTH_SECRET =
  process.env.AUTH_SECRET || process.env.GEMINI_API_KEY || "receipt-dev-secret";
const AUTH_MAX_AGE_SECONDS = 60 * 60 * 12;

const productSchema = z.object({
  name: z.string(),
  total: z.number().nullable(),
  status: z.enum(["Paid", "Unpaid"]).nullable().optional(),
  dueDate: z.string().nullable().optional(),
  paymentType: z.enum(["Cash", "Credit Card", "Online Banking"]).nullable().optional(),
});

const expenseSchema = z.object({
  products: z.array(productSchema),
  total: z.number().nullable(),
  status: z.enum(["Paid", "Unpaid"]).nullable(),
  dueDate: z.string().nullable(),
  paymentType: z.enum(["Cash", "Credit Card", "Online Banking"]).nullable(),
});

const nullableStringSchema = { type: Type.STRING, nullable: true };
const nullableNumberSchema = { type: Type.NUMBER, nullable: true };
const expenseSheetHeaders = [
  "Date",
  "Product",
  "Price",
  "Status",
  "Due Date",
  "Payment_Type",
];

const expenseResponseSchema = {
  type: Type.OBJECT,
  properties: {
    products: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          name: { type: Type.STRING },
          total: nullableNumberSchema,
        },
        required: ["name", "total"],
        propertyOrdering: ["name", "total"],
      },
    },
    total: nullableNumberSchema,
    status: {
      type: Type.STRING,
      enum: ["Paid", "Unpaid"],
      nullable: true,
    },
    dueDate: nullableStringSchema,
    paymentType: {
      type: Type.STRING,
      enum: ["Cash", "Credit Card", "Online Banking"],
      nullable: true,
    },
  },
  required: ["products", "total", "status", "dueDate", "paymentType"],
  propertyOrdering: ["products", "total", "status", "dueDate", "paymentType"],
};

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing environment variable: ${name}`);
  }
  return value;
}

function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function parseJsonMessage(message) {
  try {
    return JSON.parse(message);
  } catch {
    return null;
  }
}

function getGeminiErrorDetails(error) {
  const rawMessage =
    error instanceof Error ? error.message : "Unknown server error.";
  const parsed = parseJsonMessage(rawMessage);
  const apiError = parsed?.error || parsed;

  return {
    code: apiError?.code || error?.status || error?.code,
    status: apiError?.status || error?.status,
    message: apiError?.message || rawMessage,
  };
}

function isRetryableGeminiError(error) {
  const { code, status } = getGeminiErrorDetails(error);
  return code === 429 || code === 500 || code === 503 || status === "UNAVAILABLE";
}

function getClientError(error) {
  const details = getGeminiErrorDetails(error);

  if (details.code === 503 || details.status === "UNAVAILABLE") {
    return {
      httpStatus: 503,
      message:
        "Gemini model is temporarily busy. Please wait a moment and try again.",
    };
  }

  if (details.code === 429 || details.status === "RESOURCE_EXHAUSTED") {
    return {
      httpStatus: 429,
      message:
        "Gemini quota or rate limit was reached. Please wait and try again, or check your AI Studio quota.",
    };
  }

  return {
    httpStatus: 500,
    message: details.message,
  };
}

function getHealthStatus() {
  return {
    ok: true,
    geminiConfigured: Boolean(process.env.GEMINI_API_KEY),
    paddleOcrEnabled: true,
    googleSheetsConfigured: Boolean(
      process.env.GOOGLE_SHEETS_SPREADSHEET_ID &&
        process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL &&
        process.env.GOOGLE_PRIVATE_KEY
    ),
  };
}

function getGoogleAuth() {
  const clientEmail = requiredEnv("GOOGLE_SERVICE_ACCOUNT_EMAIL");
  const privateKey = requiredEnv("GOOGLE_PRIVATE_KEY").replace(/\\n/g, "\n");

  return new google.auth.GoogleAuth({
    credentials: {
      client_email: clientEmail,
      private_key: privateKey,
    },
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
}

function getSheetsClient() {
  const auth = getGoogleAuth();
  return google.sheets({ version: "v4", auth });
}

function parseCookies(cookieHeader = "") {
  return Object.fromEntries(
    cookieHeader
      .split(";")
      .map((cookie) => cookie.trim())
      .filter(Boolean)
      .map((cookie) => {
        const index = cookie.indexOf("=");
        return [
          decodeURIComponent(cookie.slice(0, index)),
          decodeURIComponent(cookie.slice(index + 1)),
        ];
      })
  );
}

function signPayload(payload) {
  return crypto
    .createHmac("sha256", AUTH_SECRET)
    .update(payload)
    .digest("base64url");
}

function createAuthToken(user) {
  const payload = Buffer.from(
    JSON.stringify({
      id: user.id,
      name: user.name,
      issuedAt: Date.now(),
    })
  ).toString("base64url");

  return `${payload}.${signPayload(payload)}`;
}

function verifyAuthToken(token) {
  const [payload, signature] = String(token || "").split(".");

  if (!payload || !signature || signPayload(payload) !== signature) {
    return null;
  }

  try {
    const user = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    const ageMs = Date.now() - Number(user.issuedAt || 0);

    if (ageMs > AUTH_MAX_AGE_SECONDS * 1000) {
      return null;
    }

    return user;
  } catch {
    return null;
  }
}

function getAuthUser(req) {
  const cookies = parseCookies(req.headers.cookie);
  return verifyAuthToken(cookies[AUTH_COOKIE_NAME]);
}

function requireAuth(req, res, next) {
  const user = getAuthUser(req);

  if (user) {
    req.user = user;
    return next();
  }

  return res.redirect("/");
}

function setAuthCookie(res, user) {
  const token = createAuthToken(user);
  res.cookie(AUTH_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    maxAge: AUTH_MAX_AGE_SECONDS * 1000,
  });
}

async function findUserByPass(pass) {
  const spreadsheetId = requiredEnv("GOOGLE_SHEETS_SPREADSHEET_ID");
  const sheets = getSheetsClient();
  const result = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${ID_SHEET_NAME}!A:C`,
  });
  const rows = result.data.values || [];

  for (const row of rows) {
    const [id, name, storedPass] = row;

    if (String(storedPass || "").trim() === String(pass || "").trim()) {
      return {
        id: String(id || "").trim(),
        name: String(name || "").trim(),
      };
    }
  }

  return null;
}

async function ensureSheetHeader(sheets, spreadsheetId, sheetName) {
  const headerRange = `${sheetName}!A1:H1`;
  const existing = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: headerRange,
  });
  const existingHeader = existing.data.values?.[0] || [];
  const headerMatches =
    existingHeader.length === expenseSheetHeaders.length &&
    expenseSheetHeaders.every((header, index) => existingHeader[index] === header);

  if (headerMatches) {
    return;
  }

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: headerRange,
    valueInputOption: "RAW",
    requestBody: {
      values: [expenseSheetHeaders],
    },
  });
}

async function getSheetId(sheets, spreadsheetId, sheetName) {
  const spreadsheet = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: "sheets.properties(sheetId,title)",
  });
  const sheet = spreadsheet.data.sheets?.find(
    (item) => item.properties?.title === sheetName
  );

  if (!sheet?.properties?.sheetId && sheet?.properties?.sheetId !== 0) {
    throw new Error(`Sheet "${sheetName}" was not found.`);
  }

  return sheet.properties.sheetId;
}

function parseUpdatedRowRange(updatedRange) {
  const match = String(updatedRange || "").match(/![A-Z]+(\d+):[A-Z]+(\d+)$/);

  if (!match) {
    return null;
  }

  return {
    startRow: Number(match[1]),
    endRow: Number(match[2]),
  };
}

async function formatSubmittedRows(sheets, spreadsheetId, sheetName, rows, updatedRange) {
  const rowRange = parseUpdatedRowRange(updatedRange);

  if (!rowRange) {
    return;
  }

  const sheetId = await getSheetId(sheets, spreadsheetId, sheetName);
  const requests = [
    {
      repeatCell: {
        range: {
          sheetId,
          startRowIndex: rowRange.startRow - 1,
          endRowIndex: rowRange.endRow,
          startColumnIndex: 6,
          endColumnIndex: 7,
        },
        cell: {
          userEnteredFormat: {
            backgroundColor: { red: 1, green: 1, blue: 1 },
            textFormat: { bold: false },
          },
        },
        fields: "userEnteredFormat.backgroundColor,userEnteredFormat.textFormat.bold",
      },
    },
  ];
  const totalRowOffset = rows.findIndex((row) => row[6] === "Total");

  if (totalRowOffset >= 0) {
    const totalRowIndex = rowRange.startRow - 1 + totalRowOffset;
    requests.push({
      repeatCell: {
        range: {
          sheetId,
          startRowIndex: totalRowIndex,
          endRowIndex: totalRowIndex + 1,
          startColumnIndex: 6,
          endColumnIndex: 7,
        },
        cell: {
          userEnteredFormat: {
            backgroundColor: { red: 1, green: 1, blue: 0 },
            textFormat: { bold: true },
          },
        },
        fields: "userEnteredFormat.backgroundColor,userEnteredFormat.textFormat",
      },
    });
  }

  rows.forEach((row, index) => {
    if (String(row[3] || "").toLowerCase() !== "unpaid") {
      return;
    }

    const rowIndex = rowRange.startRow - 1 + index;
    requests.push({
      repeatCell: {
        range: {
          sheetId,
          startRowIndex: rowIndex,
          endRowIndex: rowIndex + 1,
          startColumnIndex: 3,
          endColumnIndex: 4,
        },
        cell: {
          userEnteredFormat: {
            backgroundColor: { red: 0.86, green: 0.2, blue: 0.25 },
            textFormat: { foregroundColor: { red: 1, green: 1, blue: 1 }, bold: true },
          },
        },
        fields: "userEnteredFormat.backgroundColor,userEnteredFormat.textFormat",
      },
    });
  });

  if (!requests.length) {
    return;
  }

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests },
  });
}

function formatSheetDate(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: APP_TIME_ZONE,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type)?.value || "";

  return `${get("day")}/${get("month")}/${get("year")} ${get("hour")}:${get("minute")}`;
}

function getExpenseProducts(expense) {
  if (expense.products.length) {
    return expense.products;
  }

  return [{ name: "", total: expense.total }];
}

function getExpenseTotal(expense) {
  if (expense.total !== null && expense.total !== undefined) {
    return expense.total;
  }

  const productTotal = getExpenseProducts(expense).reduce((sum, product) => {
    const price = Number(product.total);
    return Number.isFinite(price) ? sum + price : sum;
  }, 0);

  return productTotal ? Number(productTotal.toFixed(2)) : null;
}

function buildSheetRows(expense, submittedAt = formatSheetDate()) {
  const rows = getExpenseProducts(expense).map((product) => [
    submittedAt,
    product.name,
    product.total ?? expense.total ?? "",
    product.status ?? expense.status ?? "",
    (product.status ?? expense.status) === "Unpaid"
      ? product.dueDate ?? expense.dueDate ?? ""
      : "",
    product.paymentType ?? expense.paymentType ?? "",
    "",
    "",
  ]);
  const total = getExpenseTotal(expense);

  if (total !== null) {
    if (!rows.length) {
      rows.push(["", "", "", "", "", "", "", ""]);
    }

    rows[rows.length - 1][6] = "Total";
    rows[rows.length - 1][7] = total;
  }

  return rows;
}

function buildSheetPreview(expense) {
  return {
    headers: expenseSheetHeaders,
    rows: getExpenseProducts(expense).map((product) => [
      "Created when submitted",
      product.name,
      product.total ?? expense.total ?? "",
      product.status ?? expense.status ?? "",
      (product.status ?? expense.status) === "Unpaid"
        ? product.dueDate ?? expense.dueDate ?? ""
        : "",
      product.paymentType ?? expense.paymentType ?? "",
    ]),
    total: getExpenseTotal(expense),
  };
}

function parseMoney(value) {
  const matches = String(value || "").match(/-?\d[\d,]*(?:[.,]\d{1,2})?/g);

  if (!matches?.length) {
    return null;
  }

  const normalized = matches[matches.length - 1]
    .replace(/,/g, ".")
    .replace(/\.(?=.*\.)/g, "");
  const amount = Number(normalized);
  return Number.isFinite(amount) ? amount : null;
}

function normalizeOcrText(text) {
  return String(text || "")
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function findTotal(lines) {
  const totalWords = /^(grand\s*)?total\b|^total\s*to\s*pay\b|^amount\s*due\b|^balance\b|^net\s*amount\b/i;
  const ignoredWords = /subtotal|sub\s*total|tax|vat|change|cash|payment\s*per\s*guest/i;

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];

    if (totalWords.test(line) && !ignoredWords.test(line)) {
      const amount = parseMoney(line);

      if (amount !== null) {
        return amount;
      }

      const nextAmount = parseMoney(lines[index + 1]);

      if (nextAmount !== null) {
        return nextAmount;
      }
    }
  }

  return null;
}

function isAmountOnly(line) {
  return /^[^\d-]*-?\d[\d,.]*[.,]\d{2}$/.test(String(line || "").trim());
}

function cleanProductName(line) {
  return String(line || "")
    .replace(/[$€£฿]\s*$/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function extractProducts(lines, skipWords) {
  const products = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const sameLineMatch = line.match(/^(.+?)\s+([$€£฿]?\s*\d[\d,.]*[.,]\d{2})$/);

    if (sameLineMatch && !skipWords.test(line)) {
      const name = cleanProductName(sameLineMatch[1]);
      const amount = parseMoney(sameLineMatch[2]);

      if (name.length >= 2 && amount !== null) {
        products.push({ name, total: amount });
      }

      continue;
    }

    const nextLine = lines[index + 1];

    if (
      nextLine &&
      isAmountOnly(nextLine) &&
      !isAmountOnly(line) &&
      !skipWords.test(line)
    ) {
      const name = cleanProductName(line);
      const amount = parseMoney(nextLine);

      if (name.length >= 2 && amount !== null) {
        products.push({ name, total: amount });
      }

      index += 1;
    }
  }

  return products.slice(0, 30);
}

function getLineItemCandidates(lines) {
  const totalIndex = lines.findIndex((line) =>
    /^total\b|^total\s*to\s*pay\b/i.test(line)
  );
  const dateIndex = lines.findIndex((line) =>
    /\bdate\b|\d{1,2}[-/]\d{1,2}[-/]\d{2,4}/i.test(line)
  );
  const tableIndex = lines.findIndex((line) => /\btable\b|\bcovers?\b/i.test(line));
  const startIndex = tableIndex >= 0 ? tableIndex + 1 : dateIndex >= 0 ? dateIndex + 1 : 0;
  const endIndex = totalIndex >= 0 ? totalIndex : lines.length;

  return lines.slice(startIndex, endIndex);
}

function parseOcrExpense(rawText) {
  const text = normalizeOcrText(rawText);
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const skipWords = /address|tel|date|receipt|table|covers?|server|total|subtotal|sub\s*total|tax|vat|change|cash|payment|paid|balance|thank|service|phone|email|reg|master/i;
  const total = findTotal(lines);
  let products = extractProducts(getLineItemCandidates(lines), skipWords);

  if (!products.length) {
    products = extractProducts(lines, skipWords);
  }

  return expenseSchema.parse({
    products,
    total,
    status: "Paid",
    dueDate: null,
    paymentType: null,
  });
}

async function extractPaddleOcrText(file) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "receipt-ocr-"));
  const extension = path.extname(file.originalname || "") || ".jpg";
  const imagePath = path.join(tempDir, `receipt${extension}`);

  try {
    await fs.writeFile(imagePath, file.buffer);

    const { stdout } = await execFileAsync(PADDLE_OCR_PYTHON, [
      PADDLE_OCR_SCRIPT,
      imagePath,
    ], {
      env: {
        ...process.env,
        FLAGS_enable_pir_api: process.env.FLAGS_enable_pir_api || "0",
        HOME: PADDLE_OCR_CACHE_DIR,
        PADDLE_HOME: PADDLE_OCR_CACHE_DIR,
        PADDLEOCR_HOME: PADDLE_OCR_CACHE_DIR,
        USERPROFILE: PADDLE_OCR_CACHE_DIR,
        XDG_CACHE_HOME: PADDLE_OCR_CACHE_DIR,
      },
      timeout: PADDLE_OCR_TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true,
    });
    const parsed = JSON.parse(stdout);

    if (!parsed.ok) {
      throw new Error(parsed.error || "PaddleOCR failed.");
    }

    return normalizeOcrText(parsed.text);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(
        `Python command "${PADDLE_OCR_PYTHON}" was not found. Set PADDLE_OCR_PYTHON in .env.`
      );
    }

    if (error?.stdout) {
      const parsed = parseJsonMessage(error.stdout);
      throw new Error(parsed?.error || error.message);
    }

    throw error;
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function appendToSheet(expense) {
  if (!process.env.GOOGLE_SHEETS_SPREADSHEET_ID) {
    return { skipped: true, reason: "Google Sheets is not configured." };
  }

  const spreadsheetId = requiredEnv("GOOGLE_SHEETS_SPREADSHEET_ID");
  const sheetName = EXPENSE_SHEET_NAME;
  const sheets = getSheetsClient();

  await ensureSheetHeader(sheets, spreadsheetId, sheetName);
  const rows = buildSheetRows(expense);

  const appendResult = await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${sheetName}!A:H`,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: {
      values: rows,
    },
  });

  await formatSubmittedRows(
    sheets,
    spreadsheetId,
    sheetName,
    rows,
    appendResult.data.updates?.updatedRange
  );

  return { skipped: false, rowsAdded: rows.length };
}

async function extractExpenseData(file) {
  const ai = new GoogleGenAI({ apiKey: requiredEnv("GEMINI_API_KEY") });
  const imageBase64 = file.buffer.toString("base64");

  for (let attempt = 1; attempt <= GEMINI_MAX_RETRIES; attempt += 1) {
    try {
      const response = await ai.models.generateContent({
        model: GEMINI_MODEL,
        systemInstruction:
          "Extract expense data into JSON for a Google Sheet. Use null when a field is not visible. Only use allowed enum values exactly.",
        contents: [
          {
            role: "user",
            parts: [
              {
                text:
                  "Read this receipt or invoice image and extract only these fields: products as separate line items with name and line total, overall total, payment status as Paid or Unpaid, due date only when status is Unpaid in DD/MM/YYYY format, and payment type as Cash, Credit Card, or Online Banking. If status or payment type is not visible, return null. If products repeat, keep each occurrence as a separate product row.",
              },
              {
                inlineData: {
                  mimeType: file.mimetype,
                  data: imageBase64,
                },
              },
            ],
          },
        ],
        config: {
          responseMimeType: "application/json",
          responseSchema: expenseResponseSchema,
        },
      });

      const parsed = JSON.parse(response.text);
      return expenseSchema.parse(parsed);
    } catch (error) {
      const shouldRetry =
        attempt < GEMINI_MAX_RETRIES && isRetryableGeminiError(error);

      if (!shouldRetry) {
        throw error;
      }

      await wait(1000 * attempt);
    }
  }
}

app.use("/assets", express.static(path.join(projectRoot, "public")));
app.use(
  "/vendor/tesseract",
  express.static(path.join(projectRoot, "node_modules", "tesseract.js", "dist"))
);
app.use(
  "/vendor/tesseract-core",
  express.static(path.join(projectRoot, "node_modules", "tesseract.js-core"))
);
app.use(express.json());

app.get("/", (_req, res) => {
  res.type("html").send(renderAccessPage());
});

app.post("/api/login", async (req, res) => {
  try {
    const user = await findUserByPass(req.body?.pass);

    if (!user) {
      return res.status(401).json({ error: "Invalid access code." });
    }

    setAuthCookie(res, user);
    return res.json({ success: true, user });
  } catch (error) {
    const { httpStatus, message } = getClientError(error);
    return res.status(httpStatus).json({ error: message });
  }
});

app.post("/api/logout", (_req, res) => {
  res.clearCookie(AUTH_COOKIE_NAME);
  return res.json({ success: true });
});

app.get("/upload", requireAuth, (req, res) => {
  res.type("html").send(renderReceiptPage(req.user));
});

app.get("/api/health", (_req, res) => {
  res.json(getHealthStatus());
});

app.post("/api/receipts/analyze", requireAuth, upload.single("receipt"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No receipt image uploaded." });
    }

    if (!process.env.GEMINI_API_KEY) {
      return res.status(400).json({
        error:
          "GEMINI_API_KEY is missing. Create a .env file in the project root and add your secret key.",
      });
    }

    const parsedExpense = await extractExpenseData(req.file);

    return res.json({
      success: true,
      message: "Receipt analyzed. Review the preview before submitting.",
      receipt: parsedExpense,
      sheetPreview: buildSheetPreview(parsedExpense),
    });
  } catch (error) {
    const { httpStatus, message } = getClientError(error);
    return res.status(httpStatus).json({ error: message });
  }
});

app.post("/api/receipts/ocr", requireAuth, upload.single("receipt"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No receipt image uploaded." });
    }

    const rawText = await extractPaddleOcrText(req.file);
    const parsedExpense = parseOcrExpense(rawText);

    return res.json({
      success: true,
      engine: "paddleocr",
      message: "Receipt read with PaddleOCR. Review the preview before submitting.",
      receipt: parsedExpense,
      sheetPreview: buildSheetPreview(parsedExpense),
      rawText,
    });
  } catch (error) {
    return res.status(503).json({
      error: error instanceof Error ? error.message : "PaddleOCR failed.",
    });
  }
});

app.post("/api/receipts/submit", requireAuth, async (req, res) => {
  try {
    const parsedExpense = expenseSchema.parse(req.body?.receipt);
    const sheetResult = await appendToSheet(parsedExpense);

    return res.json({
      success: true,
      message: sheetResult.skipped
        ? "Google Sheets was skipped because it is not configured yet."
        : "Receipt saved to Google Sheets.",
      sheet: sheetResult,
    });
  } catch (error) {
    const { httpStatus, message } = getClientError(error);
    return res.status(httpStatus).json({ error: message });
  }
});

app.listen(PORT, () => {
  console.log(`Receipt app listening on http://localhost:${PORT}`);
});
