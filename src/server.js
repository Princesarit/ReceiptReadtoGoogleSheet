import "dotenv/config";
import express from "express";
import multer from "multer";
import { GoogleGenAI, Type } from "@google/genai";
import { google } from "googleapis";
import { z } from "zod";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderAccessPage } from "./views/accessPage.js";
import { renderReceiptPage } from "./views/receiptPage.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

const PORT = process.env.PORT || 3000;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const GEMINI_MAX_RETRIES = Number(process.env.GEMINI_MAX_RETRIES || 2);
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
  "Total",
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
  const headerRange = `${sheetName}!A1:F1`;
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

function buildSheetRows(expense, submittedAt = formatSheetDate()) {
  return getExpenseProducts(expense).map((product) => [
    submittedAt,
    product.name,
    product.total ?? expense.total ?? "",
    expense.status || "",
    expense.status === "Unpaid" ? expense.dueDate || "" : "",
    expense.paymentType || "",
  ]);
}

function buildSheetPreview(expense) {
  return {
    headers: expenseSheetHeaders,
    rows: buildSheetRows(expense, "Created when submitted"),
  };
}

async function appendToSheet(expense) {
  if (!process.env.GOOGLE_SHEETS_SPREADSHEET_ID) {
    return { skipped: true, reason: "Google Sheets is not configured." };
  }

  const spreadsheetId = requiredEnv("GOOGLE_SHEETS_SPREADSHEET_ID");
  const sheetName = EXPENSE_SHEET_NAME;
  const sheets = getSheetsClient();

  await ensureSheetHeader(sheets, spreadsheetId, sheetName);

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${sheetName}!A:F`,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: {
      values: buildSheetRows(expense),
    },
  });

  return { skipped: false, rowsAdded: buildSheetRows(expense).length };
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
