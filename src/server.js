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
const RECEIPT_UPLOAD_MAX_MB = Number(process.env.RECEIPT_UPLOAD_MAX_MB || 25);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: RECEIPT_UPLOAD_MAX_MB * 1024 * 1024 },
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
  qty: z.string().nullable().optional(),
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
  "Qty",
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
          qty: nullableStringSchema,
          total: nullableNumberSchema,
        },
        required: ["name", "total"],
        propertyOrdering: ["name", "qty", "total"],
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
    receiptUploadMaxMb: RECEIPT_UPLOAD_MAX_MB,
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

  if (req.path.startsWith("/api/")) {
    return res.status(401).json({ error: "Your sign-in expired. Please sign in again." });
  }

  return res.redirect("/");
}

function uploadReceipt(req, res, next) {
  upload.single("receipt")(req, res, (error) => {
    if (!error) {
      return next();
    }

    if (error instanceof multer.MulterError) {
      const message =
        error.code === "LIMIT_FILE_SIZE"
          ? `Receipt image is too large. Upload an image under ${RECEIPT_UPLOAD_MAX_MB} MB.`
          : error.message;

      return res.status(400).json({ error: message });
    }

    return res.status(400).json({
      error: error instanceof Error ? error.message : "Unable to read the uploaded file.",
    });
  });
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
  const headerRange = `${sheetName}!A1:G1`;
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
          startColumnIndex: 7,
          endColumnIndex: 8,
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
  const totalRowOffset = rows.findIndex((row) => row[7] === "Total");

  if (totalRowOffset >= 0) {
    const totalRowIndex = rowRange.startRow - 1 + totalRowOffset;
    requests.push({
      repeatCell: {
        range: {
          sheetId,
          startRowIndex: totalRowIndex,
          endRowIndex: totalRowIndex + 1,
          startColumnIndex: 7,
          endColumnIndex: 8,
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
    if (String(row[4] || "").toLowerCase() !== "unpaid") {
      return;
    }

    const rowIndex = rowRange.startRow - 1 + index;
    requests.push({
      repeatCell: {
        range: {
          sheetId,
          startRowIndex: rowIndex,
          endRowIndex: rowIndex + 1,
          startColumnIndex: 4,
          endColumnIndex: 5,
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
    return expense.products.map((product) => ({
      ...product,
      qty: product.qty || "1",
    }));
  }

  return [{ name: "", qty: "1", total: expense.total }];
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
    product.qty ?? "",
    product.total ?? expense.total ?? "",
    product.status ?? expense.status ?? "",
    (product.status ?? expense.status) === "Unpaid"
      ? product.dueDate ?? expense.dueDate ?? ""
      : "",
    product.paymentType ?? expense.paymentType ?? "Cash",
    "",
    "",
  ]);
  const total = getExpenseTotal(expense);

  if (total !== null) {
    if (!rows.length) {
      rows.push(["", "", "", "", "", "", "", "", ""]);
    }

    rows[rows.length - 1][7] = "Total";
    rows[rows.length - 1][8] = total;
  }

  return rows;
}

function buildSheetPreview(expense) {
  return {
    headers: expenseSheetHeaders,
    rows: getExpenseProducts(expense).map((product) => [
      "Created when submitted",
      product.name,
      product.qty ?? "",
      product.total ?? expense.total ?? "",
      product.status ?? expense.status ?? "",
      (product.status ?? expense.status) === "Unpaid"
        ? product.dueDate ?? expense.dueDate ?? ""
        : "",
      product.paymentType ?? expense.paymentType ?? "Cash",
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

function getMoneyMatches(value) {
  return Array.from(
    String(value || "").matchAll(/[$€£฿]\s*-?\d[\d,]*(?:[.,]\d{1,2})?|-?\d[\d,]*[.,]\d{2}/g)
  );
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
    .replace(/^[#^*\s]+/g, "")
    .replace(/^[AH]{1,2}(?=Coca\b|Pocky\b|M&Ms\b)/i, "")
    .replace(/[#^*]+/g, "")
    .replace(/[$€£฿]\s*$/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function cleanLineItemName(line) {
  return cleanProductName(line)
    .replace(/\b\d+\s*@\s*[$€£฿]?\s*\d[\d,.]*/gi, "")
    .replace(/\b[a-z]\s+(?=\d+\s*x)/gi, "")
    .replace(/^\d+\s+(?=\d+\s*(?:pk|x))/i, "")
    .replace(/\s+[({[]?P[)}\]]?\s*$/i, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function shouldJoinPendingName(pendingName, name) {
  if (!pendingName || !name) {
    return false;
  }

  return (
    /^[a-z]?\s*\d+\s*x/i.test(name) ||
    /^\d+\s*(?:pk|x|ml|g|kg|l)\b/i.test(name) ||
    /^\d+\s+\w+/i.test(name) ||
    name.length < 12
  );
}

function isPackageFragment(name) {
  return /^[a-z]?\s*\d+\s*x/i.test(name) || /^\d+\s*(?:pk|x|ml|g|kg|l)\b/i.test(name);
}

function isSummaryLine(line) {
  return /\bsubtotal\b|sub\s*total|^rounding\b|^total\b|^cash\b|^change\b|^gst\b|^tax\b|served\s+by|receipt\s+number|loyalty|member/i.test(
    String(line || "")
  );
}

function isQuantityLine(line) {
  const value = String(line || "").trim();
  return (
    /^(?:qty\s*)?\d+\s*@\b/i.test(value) ||
    /^qty\s+\d+$/i.test(value) ||
    /^\d+\s+x\b/i.test(value) ||
    /\beach\b/i.test(value) ||
    /@/.test(value) ||
    /^[\d\s@xX$€£฿.,-]+$/.test(value)
  );
}

function parseQuantity(line) {
  const value = String(line || "").trim();
  const explicitMatch = value.match(/^qty\s+(\d+)$/i);
  const explicitWithDetailMatch = value.match(/^qty\.?\s*(\d+)/i);
  const unitMatch = value.match(/^(?:qty\s*)?(\d+)\s*(?:@|x\b)/i);
  const compactUnitMatch = value.match(/^(\d)\d\s+\D?\d[\d,.]*/);
  return explicitMatch?.[1] || explicitWithDetailMatch?.[1] || unitMatch?.[1] || compactUnitMatch?.[1] || null;
}

function isMetadataLine(line, name = "") {
  const value = String(line || "").trim();
  const cleanedName = cleanLineItemName(name);

  return (
    /\beach\b/i.test(value) ||
    /@/.test(value) ||
    /^qty\b/i.test(value) ||
    cleanedName.toLowerCase() === "each" ||
    /^\d+$/.test(cleanedName)
  );
}

function hasMetadataTokens(line) {
  const value = String(line || "").trim();
  return /\beach\b/i.test(value) || /@/.test(value) || /^qty\b/i.test(value);
}

function isPriceOnlyLine(line) {
  const value = String(line || "").trim();
  return getMoneyMatches(value).length > 0 && /^[^\p{L}]*[$€£฿]?\s*-?\d[\d,.]*[^\p{L}]*$/u.test(value);
}

function getRowsLayout(rows) {
  const items = rows.flatMap((row) => row.items || []);

  if (!items.length) {
    return { hasPositions: false, rightPriceStart: 0 };
  }

  const minX = Math.min(...items.map((item) => item.x1));
  const maxX = Math.max(...items.map((item) => item.x2));
  const span = Math.max(1, maxX - minX);
  const roughPriceStart = minX + span * 0.62;
  const rightMoneyItems = items
    .filter((item) => parseMoney(item.text) !== null)
    .filter((item) => item.x1 >= roughPriceStart)
    .sort((left, right) => left.x1 - right.x1);

  if (rightMoneyItems.length) {
    const medianIndex = Math.floor(rightMoneyItems.length / 2);
    const medianPriceX = rightMoneyItems[medianIndex].x1;

    return {
      hasPositions: true,
      rightPriceStart: Math.max(roughPriceStart, medianPriceX - span * 0.12),
    };
  }

  return {
    hasPositions: true,
    rightPriceStart: minX + span * 0.72,
  };
}

function getRightAlignedMoney(row, layout) {
  const items = row.items || [];

  if (layout.hasPositions && items.length) {
    const candidates = items
      .map((item, index) => ({
        item,
        index,
        amount: parseMoney(item.text),
      }))
      .filter((candidate) => candidate.amount !== null)
      .filter((candidate) => candidate.item.x1 >= layout.rightPriceStart)
      .sort((left, right) => right.item.x1 - left.item.x1);
    const [candidate] = candidates;

    if (!candidate) {
      return null;
    }

    const nameText = items
      .slice(0, candidate.index)
      .map((item) => item.text)
      .join(" ");

    if (hasMetadataTokens(nameText)) {
      return {
        amount: candidate.amount,
        nameText,
        isMetadataPriced: true,
        isPriceOnly: false,
      };
    }

    return {
      amount: candidate.amount,
      nameText,
      isMetadataPriced: false,
      isPriceOnly: items.length === 1,
    };
  }

  const moneyMatches = getMoneyMatches(row.text);
  const amountMatch = moneyMatches[moneyMatches.length - 1];

  if (!amountMatch) {
    return null;
  }

  return {
    amount: parseMoney(amountMatch[0]),
    nameText: String(row.text || "").slice(0, amountMatch.index),
    isMetadataPriced: hasMetadataTokens(String(row.text || "").slice(0, amountMatch.index)),
    isPriceOnly: isPriceOnlyLine(row.text),
  };
}

function getRowProductText(row, priceInfo = null) {
  if (priceInfo) {
    return priceInfo.nameText || "";
  }

  return row.text || "";
}

function joinProductParts(parts) {
  return cleanLineItemName(parts.filter(Boolean).join(" "));
}

function cleanContinuationPart(line) {
  return cleanLineItemName(line)
    .replace(/^[a-z]\s+(?=[A-Z0-9])/g, "")
    .replace(/^0\s+(?=[A-Z])/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function createProduct(name, qty, total) {
  const cleanName = cleanLineItemName(name);

  if (
    cleanName.length < 2 ||
    total === null ||
    total === undefined ||
    isSummaryLine(cleanName) ||
    isQuantityLine(cleanName) ||
    isMetadataLine("", cleanName) ||
    isPackageFragment(cleanName)
  ) {
    return null;
  }

  return {
    name: cleanName,
    qty: qty || "1",
    total,
  };
}

function normalizeParsedProducts(products, receiptTotal) {
  const productCount = products.length;

  return products
    .map((product) => ({
      ...product,
      name: cleanLineItemName(product.name),
      qty: product.qty || "1",
    }))
    .filter((product) => product.name.length >= 2)
    .filter((product) => !isSummaryLine(product.name))
    .filter((product) => !isQuantityLine(product.name))
    .filter((product) => !isMetadataLine("", product.name))
    .filter((product) => {
      if (receiptTotal === null || receiptTotal === undefined) {
        return true;
      }

      const amount = Number(product.total);
      return !Number.isFinite(amount) || amount < receiptTotal || productCount === 1;
    });
}

function getOcrRows(entries) {
  const positioned = (entries || [])
    .filter((entry) => entry?.text && Array.isArray(entry.box) && entry.box.length === 4)
    .map((entry) => {
      const [x1, y1, x2, y2] = entry.box.map(Number);
      return {
        text: String(entry.text).trim(),
        x1,
        x2,
        y1,
        y2,
        centerY: (y1 + y2) / 2,
        height: Math.max(1, y2 - y1),
      };
    })
    .filter((entry) =>
      [entry.x1, entry.x2, entry.y1, entry.y2].every((value) => Number.isFinite(value))
    )
    .sort((left, right) => left.centerY - right.centerY || left.x1 - right.x1);

  if (!positioned.length) {
    return [];
  }

  const rows = [];

  for (const entry of positioned) {
    const lastRow = rows[rows.length - 1];
    const tolerance = Math.max(3, entry.height * 0.35);

    if (!lastRow || Math.abs(lastRow.centerY - entry.centerY) > tolerance) {
      rows.push({
        centerY: entry.centerY,
        items: [entry],
      });
      continue;
    }

    lastRow.items.push(entry);
    lastRow.centerY =
      lastRow.items.reduce((sum, item) => sum + item.centerY, 0) / lastRow.items.length;
  }

  return rows.map((row) => {
    const items = row.items.sort((left, right) => left.x1 - right.x1);
    return {
      text: items.map((item) => item.text).join(" ").replace(/\s{2,}/g, " ").trim(),
      items,
    };
  });
}

function getCandidateRows(lines, entries) {
  const positionedRows = getOcrRows(entries);
  const rows = positionedRows.length
    ? positionedRows
    : lines.map((line) => ({ text: line, items: [] }));
  const dateIndex = rows.findIndex((row) =>
    /\d{1,2}[-/]\d{1,2}[-/]\d{2,4}|\bdate\b/i.test(row.text)
  );
  const startIndex = dateIndex >= 0 ? dateIndex + 1 : 0;
  const summaryIndex = rows.findIndex(
    (row, index) => index >= startIndex && isSummaryLine(row.text)
  );
  const endIndex = summaryIndex >= 0 ? summaryIndex : rows.length;

  return rows.slice(startIndex, endIndex);
}

function extractProductsFromRows(rows, skipWords) {
  const products = [];
  let pendingNameParts = [];
  let pendingQty = null;
  let lastProduct = null;
  const layout = getRowsLayout(rows);

  for (const row of rows) {
    const line = String(row.text || "").trim();

    if (!line || skipWords.test(line) || isSummaryLine(line)) {
      continue;
    }

    const priceInfo = getRightAlignedMoney(row, layout);
    const amount = priceInfo?.amount ?? null;
    const qty = parseQuantity(line);
    const leftText = cleanLineItemName(getRowProductText(row, priceInfo));
    const metadataLine =
      isQuantityLine(line) ||
      hasMetadataTokens(line) ||
      priceInfo?.isMetadataPriced ||
      isMetadataLine(line, leftText);

    if (amount === null && qty && metadataLine) {
      pendingQty = qty;

      if (!pendingNameParts.length && lastProduct) {
        lastProduct.qty = qty;
        pendingQty = null;
      }

      continue;
    }

    if (amount === null) {
      if (!metadataLine) {
        const name = cleanLineItemName(line);

        if (name) {
          pendingNameParts.push(name);
        }
      }

      continue;
    }

    const nameParts = [...pendingNameParts];

    if (leftText && (!metadataLine || isPackageFragment(leftText))) {
      nameParts.push(leftText);
    }

    const product = createProduct(joinProductParts(nameParts), qty || pendingQty, amount);

    if (product) {
      products.push(product);
      lastProduct = product;
      pendingNameParts = [];
      pendingQty = null;
      continue;
    }

    if (qty && lastProduct && metadataLine) {
      lastProduct.qty = qty;
    }

    if (!product && leftText && !metadataLine && !isPackageFragment(leftText)) {
      pendingNameParts = [leftText];
    } else {
      pendingNameParts = [];
    }

    pendingQty = null;
  }

  return products.slice(0, 30);
}

function getCandidateTextLines(lines) {
  const dateIndex = lines.findIndex((line) =>
    /\d{1,2}[-/]\d{1,2}[-/]\d{2,4}|\bdate\b/i.test(line)
  );
  const startIndex = dateIndex >= 0 ? dateIndex + 1 : 0;
  const summaryIndex = lines.findIndex(
    (line, index) => index >= startIndex && isSummaryLine(line)
  );
  const endIndex = summaryIndex >= 0 ? summaryIndex : lines.length;
  return lines.slice(startIndex, endIndex);
}

function updateProductQuantityFromUnitPrice(product, qtyCandidate, unitPrice) {
  if (!product || !Number.isFinite(unitPrice)) {
    return;
  }

  const total = Number(product.total);

  if (!Number.isFinite(total) || unitPrice <= 0 || total <= unitPrice) {
    return;
  }

  const inferredQty = Math.round(total / unitPrice);

  if (inferredQty >= 2 && Math.abs(inferredQty * unitPrice - total) < 0.06) {
    product.qty = String(inferredQty);
    return;
  }

  if (qtyCandidate && Number(qtyCandidate) >= 2 && Number(qtyCandidate) <= 99) {
    product.qty = String(qtyCandidate);
  }
}

function shouldIgnoreRawTextLine(line, skipWords) {
  const value = String(line || "").trim();

  return (
    !value ||
    skipWords.test(value) ||
    isSummaryLine(value) ||
    /^[$โฌยฃเธฟ]?$/.test(value)
  );
}

function extractProductsFromTextBlocks(lines, skipWords) {
  const products = [];
  let pendingNameParts = [];
  let pendingQty = null;
  let pendingUnitPrice = null;
  let expectingQty = false;
  let lastProduct = null;

  for (const line of lines) {
    const value = String(line || "").trim();

    if (shouldIgnoreRawTextLine(value, skipWords)) {
      continue;
    }

    const amountMatches = getMoneyMatches(value);
    const lastAmountMatch = amountMatches[amountMatches.length - 1];
    const amount = lastAmountMatch ? parseMoney(lastAmountMatch[0]) : null;
    const amountOnly = amount !== null && isPriceOnlyLine(value);
    const qty = parseQuantity(value);
    const hasMetadata = hasMetadataTokens(value) || /^qty\b/i.test(value);

    if (/^qty\b/i.test(value)) {
      expectingQty = true;
    }

    if (qty && hasMetadata) {
      pendingQty = qty;
    }

    if (expectingQty && /^\d{1,2}$/.test(value)) {
      pendingQty = value.length === 2 && value.endsWith("0") ? value.slice(0, 1) : value;
      expectingQty = false;
      continue;
    }

    if (amount !== null && (hasMetadata || expectingQty) && lastProduct && !pendingNameParts.length) {
      updateProductQuantityFromUnitPrice(lastProduct, pendingQty, amount);
      pendingQty = null;
      pendingUnitPrice = null;
      expectingQty = false;
      continue;
    }

    if (amount !== null && hasMetadata && pendingNameParts.length) {
      pendingUnitPrice = amount;
      expectingQty = false;
      continue;
    }

    if (amountOnly) {
      if (pendingNameParts.length && pendingQty && pendingUnitPrice === null) {
        pendingUnitPrice = amount;
        expectingQty = false;
        continue;
      }

      if (pendingNameParts.length) {
        const product = createProduct(joinProductParts(pendingNameParts), pendingQty, amount);

        if (product) {
          products.push(product);
          lastProduct = product;
        }

        pendingNameParts = [];
        pendingQty = null;
        pendingUnitPrice = null;
      } else if (lastProduct && pendingQty) {
        updateProductQuantityFromUnitPrice(lastProduct, pendingQty, amount);
        pendingQty = null;
        pendingUnitPrice = null;
      }

      expectingQty = false;
      continue;
    }

    if (amount !== null) {
      const leftText = value.slice(0, lastAmountMatch.index);

      if (!hasMetadata) {
        const product = createProduct(joinProductParts([...pendingNameParts, leftText]), pendingQty, amount);

        if (product) {
          products.push(product);
          lastProduct = product;
          pendingNameParts = [];
          pendingQty = null;
          pendingUnitPrice = null;
        }
      }

      expectingQty = false;
      continue;
    }

    if (hasMetadata || value.toLowerCase() === "each") {
      continue;
    }

    const part = cleanContinuationPart(value);

    if (part && !isQuantityLine(part) && !isMetadataLine("", part)) {
      if (
        pendingNameParts.length &&
        /^(?:Golden Circle|Coca Cola|WW |Essentials |Pocky |Haribo |Ingham's)/i.test(part)
      ) {
        pendingNameParts = [];
        pendingQty = null;
        pendingUnitPrice = null;
      }

      pendingNameParts.push(part);
    }
  }

  return products.slice(0, 30);
}

function productQualityScore(product) {
  const name = String(product?.name || "");
  let score = name.length;

  if (/\b(Coca|Cola|Schweppes|Pocky|Golden|Circle|Farmers|Squid|Chicken)\b/i.test(name)) {
    score += 20;
  }

  if (isPackageFragment(name) || /^\d/.test(name)) {
    score -= 40;
  }

  if (/\b[a-z0]\s+(?=[A-Z0-9])/i.test(name)) {
    score -= 35;
  }

  return score;
}

function noisyContinuationCount(products) {
  return products.filter((product) => /\b[a-z0]\s+(?=[A-Z0-9])/i.test(product.name)).length;
}

function chooseBestParsedProducts(rowProducts, textProducts) {
  if (!textProducts.length) {
    return rowProducts;
  }

  if (!rowProducts.length) {
    return textProducts;
  }

  const rowFragmentCount = rowProducts.filter((product) => isPackageFragment(product.name)).length;
  const textFragmentCount = textProducts.filter((product) => isPackageFragment(product.name)).length;

  if (rowFragmentCount > textFragmentCount) {
    return textProducts;
  }

  if (noisyContinuationCount(rowProducts) > noisyContinuationCount(textProducts)) {
    return textProducts;
  }

  if (textProducts.length < rowProducts.length && rowFragmentCount <= textFragmentCount) {
    return rowProducts;
  }

  const rowScore = rowProducts.reduce((sum, product) => sum + productQualityScore(product), 0);
  const textScore = textProducts.reduce((sum, product) => sum + productQualityScore(product), 0);

  if (textProducts.length >= rowProducts.length * 0.75 && textScore >= rowScore) {
    return textProducts;
  }

  return rowProducts;
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

function parseOcrExpense(rawText, entries = []) {
  const text = normalizeOcrText(rawText);
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const skipWords = /address|tel|date|receipt|table|covers?|server|total|subtotal|sub\s*total|rounding|tax|vat|gst|change|cash|payment|paid|balance|thank|service|phone|email|reg|master|member|loyalty/i;
  const total = findTotal(lines);
  const rowProducts = extractProductsFromRows(getCandidateRows(lines, entries), skipWords);
  const textProducts = extractProductsFromTextBlocks(getCandidateTextLines(lines), skipWords);
  let products = chooseBestParsedProducts(rowProducts, textProducts);

  if (!products.length) {
    products = extractProducts(getLineItemCandidates(lines), skipWords);
  }

  if (!products.length) {
    products = extractProducts(lines, skipWords);
  }
  products = normalizeParsedProducts(products, total);

  return expenseSchema.parse({
    products,
    total,
    status: "Paid",
    dueDate: null,
    paymentType: "Cash",
  });
}

async function extractPaddleOcrResult(file) {
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

    return {
      text: normalizeOcrText(parsed.text),
      entries: Array.isArray(parsed.entries) ? parsed.entries : [],
    };
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
    range: `${sheetName}!A:I`,
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

app.post("/api/receipts/analyze", requireAuth, uploadReceipt, async (req, res) => {
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

app.post("/api/receipts/ocr", requireAuth, uploadReceipt, async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No receipt image uploaded." });
    }

    const ocrResult = await extractPaddleOcrResult(req.file);
    const parsedExpense = parseOcrExpense(ocrResult.text, ocrResult.entries);

    return res.json({
      success: true,
      engine: "paddleocr",
      message: "Receipt read with PaddleOCR. Review the preview before submitting.",
      receipt: parsedExpense,
      sheetPreview: buildSheetPreview(parsedExpense),
      rawText: ocrResult.text,
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

app.use("/api", (_req, res) => {
  res.status(404).json({ error: "API endpoint was not found." });
});

app.use((error, req, res, next) => {
  if (!req.originalUrl.startsWith("/api/")) {
    return next(error);
  }

  const { httpStatus, message } = getClientError(error);
  return res.status(httpStatus).json({ error: message });
});

if (process.env.NODE_ENV !== "test") {
  app.listen(PORT, () => {
    console.log(`Receipt app listening on http://localhost:${PORT}`);
  });
}

export { parseOcrExpense, buildSheetPreview };
