const uploadModeButton = document.getElementById("uploadModeButton");
const cameraModeButton = document.getElementById("cameraModeButton");
const filePickerPanel = document.getElementById("filePickerPanel");
const cameraPanel = document.getElementById("cameraPanel");
const receiptFile = document.getElementById("receiptFile");
const previewPanel = document.getElementById("previewPanel");
const imagePreview = document.getElementById("imagePreview");
const previewName = document.getElementById("previewName");
const analyzeButton = document.getElementById("analyzeButton");
const confirmEditButton = document.getElementById("confirmEditButton");
const submitButton = document.getElementById("submitButton");
const statusText = document.getElementById("statusText");
const resultOutput = document.getElementById("resultOutput");
const startCameraButton = document.getElementById("startCameraButton");
const captureButton = document.getElementById("captureButton");
const cameraPreview = document.getElementById("cameraPreview");
const captureCanvas = document.getElementById("captureCanvas");

let currentFile = null;
let cameraStream = null;
let analyzedReceipt = null;
let draftReceipt = null;
let isEditingReceipt = false;
let ocrWorker = null;
let healthState = {
  googleSheetsConfigured: false,
  loaded: false,
};

function refreshReadyState() {
  if (!healthState.loaded) {
    analyzeButton.disabled = true;
    statusText.textContent = "Checking configuration";
    return;
  }

  analyzeButton.disabled = !currentFile;

  if (!currentFile) {
    statusText.textContent = healthState.googleSheetsConfigured
      ? "Ready"
      : "Ready to analyze. Google Sheets is not configured.";
    return;
  }

  statusText.textContent = healthState.googleSheetsConfigured
    ? "Ready to analyze"
    : "Ready to analyze. Results will not be saved to Google Sheets.";
}

async function loadHealthStatus() {
  try {
    const response = await fetch("/api/health");
    const data = await response.json();

    healthState = {
      googleSheetsConfigured: Boolean(data.googleSheetsConfigured),
      loaded: true,
    };

    if (!healthState.googleSheetsConfigured) {
      resultOutput.textContent =
        "OCR is ready. Google Sheets settings are missing in .env, so results will stay on this page.";
    } else {
      resultOutput.textContent = "No receipt has been analyzed yet.";
    }

    refreshReadyState();
  } catch (error) {
    healthState.loaded = true;
    analyzeButton.disabled = true;
    statusText.textContent = "Unable to check system status";
    resultOutput.textContent =
      error instanceof Error ? error.message : "Unknown error";
  }
}

function setMode(mode) {
  const isUpload = mode === "upload";
  uploadModeButton.classList.toggle("active", isUpload);
  cameraModeButton.classList.toggle("active", !isUpload);
  filePickerPanel.classList.toggle("hidden", !isUpload);
  cameraPanel.classList.toggle("hidden", isUpload);
}

function renderPreview(file) {
  currentFile = file;
  analyzedReceipt = null;
  draftReceipt = null;
  previewName.textContent = file.name;
  imagePreview.src = URL.createObjectURL(file);
  previewPanel.classList.remove("hidden");
  confirmEditButton.classList.add("hidden");
  submitButton.classList.add("hidden");
  refreshReadyState();
}

function setBusyState(isBusy) {
  analyzeButton.disabled = isBusy || !currentFile;
  analyzeButton.textContent = isBusy
    ? "Reading receipt..."
    : "Analyze receipt";
}

function setSubmitBusyState(isBusy) {
  submitButton.disabled = isBusy || !analyzedReceipt;
  submitButton.textContent = isBusy
    ? "Submitting..."
    : "Submit to Google Sheets";
}

function setConfirmVisible(isVisible) {
  confirmEditButton.classList.toggle("hidden", !isVisible);
  confirmEditButton.disabled = !isVisible;
}

function setEditButtonMode(mode) {
  isEditingReceipt = mode === "confirm";
  confirmEditButton.textContent = isEditingReceipt ? "Confirm edits" : "Edit";
  setConfirmVisible(Boolean(analyzedReceipt || draftReceipt));
}

function formatPreviewValue(value) {
  if (value === null || value === undefined || value === "") {
    return "-";
  }

  return String(value);
}

function escapeHtml(value) {
  return formatPreviewValue(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderSheetPreview(sheetPreview) {
  const headers = sheetPreview.headers || [];
  const rows = sheetPreview.rows || [];
  const total =
    sheetPreview.total !== null && sheetPreview.total !== undefined
      ? `<div class="preview-total"><span>Total</span><strong>${escapeHtml(
          sheetPreview.total
        )}</strong></div>`
      : "";
  const headerCells = headers
    .map((header) => `<th>${escapeHtml(header)}</th>`)
    .join("");
  const bodyRows = rows
    .map(
      (row) => `
        <tr>
          ${row.map((value) => `<td>${escapeHtml(value)}</td>`).join("")}
        </tr>
      `
    )
    .join("");

  resultOutput.innerHTML = `
    <div class="preview-scroll">
      <table class="preview-table">
        <thead><tr>${headerCells}</tr></thead>
        <tbody>${bodyRows}</tbody>
      </table>
    </div>
    ${total}
  `;
}

function getReceiptTotal(receipt) {
  if (receipt.total !== null && receipt.total !== undefined) {
    return receipt.total;
  }

  const total = (receipt.products || []).reduce((sum, product) => {
    const price = Number(product.total);
    return Number.isFinite(price) ? sum + price : sum;
  }, 0);

  return Number(total.toFixed(2));
}

function renderEditableReceipt(receipt) {
  draftReceipt = {
    products: (receipt.products || []).map((product) => ({
      ...product,
      status: product.status ?? receipt.status ?? "Paid",
      dueDate: product.dueDate ?? receipt.dueDate ?? null,
      paymentType: product.paymentType ?? receipt.paymentType ?? null,
    })),
    total: receipt.total,
    status: receipt.status || "Paid",
    dueDate: receipt.dueDate || null,
    paymentType: receipt.paymentType || null,
  };
  analyzedReceipt = null;
  setEditButtonMode("confirm");
  submitButton.classList.add("hidden");
  statusText.textContent = "Edit and confirm before submitting";

  const rows = draftReceipt.products.length
    ? draftReceipt.products
    : [{ name: "", total: draftReceipt.total }];
  const bodyRows = rows
    .map(
      (product, index) => `
        <tr data-row-index="${index}">
          <td>
            <input class="table-input product-input" data-field="name" value="${escapeHtml(
              product.name
            )}" />
          </td>
          <td>
            <input class="table-input price-input" data-field="total" inputmode="decimal" value="${escapeHtml(
              product.total ?? ""
            )}" />
          </td>
          <td>
            <select class="table-input status-input" data-field="status">
              <option value="Paid" ${product.status === "Paid" ? "selected" : ""}>Paid</option>
              <option value="Unpaid" ${product.status === "Unpaid" ? "selected" : ""}>Unpaid</option>
            </select>
          </td>
          <td>
            <input class="table-input due-date-input" data-field="dueDate" placeholder="DD/MM/YYYY" value="${escapeHtml(
              product.dueDate || ""
            )}" />
          </td>
          <td>
            <select class="table-input payment-input" data-field="paymentType">
              <option value="" ${!product.paymentType ? "selected" : ""}>-</option>
              <option value="Cash" ${product.paymentType === "Cash" ? "selected" : ""}>Cash</option>
              <option value="Credit Card" ${product.paymentType === "Credit Card" ? "selected" : ""}>Credit Card</option>
              <option value="Online Banking" ${product.paymentType === "Online Banking" ? "selected" : ""}>Online Banking</option>
            </select>
          </td>
        </tr>
      `
    )
    .join("");

  resultOutput.innerHTML = `
    <div class="preview-scroll">
      <table class="preview-table editable-table">
        <thead>
          <tr>
            <th>Product</th>
            <th>Price</th>
            <th>Status</th>
            <th>Due Date</th>
            <th>Payment_Type</th>
          </tr>
        </thead>
        <tbody>${bodyRows}</tbody>
      </table>
    </div>
    <div class="preview-total"><span>Total</span><strong id="editableTotal">${escapeHtml(
      getReceiptTotal(draftReceipt)
    )}</strong></div>
  `;

  resultOutput
    .querySelectorAll(".table-input")
    .forEach((input) => input.addEventListener("input", handleDraftInput));
  resultOutput
    .querySelectorAll("select.table-input")
    .forEach((input) => input.addEventListener("change", handleDraftInput));
}

function handleDraftInput(event) {
  if (!draftReceipt) {
    return;
  }

  const row = event.target.closest("tr");
  const index = Number(row?.dataset.rowIndex);
  const field = event.target.dataset.field;

  if (Number.isInteger(index) && draftReceipt.products[index]) {
    draftReceipt.products[index][field] =
      field === "total" ? parseMoney(event.target.value) : event.target.value;
  }

  draftReceipt.total = getReceiptTotal({
    ...draftReceipt,
    total: null,
  });
  const totalElement = document.getElementById("editableTotal");

  if (totalElement) {
    totalElement.textContent = formatPreviewValue(draftReceipt.total);
  }

  analyzedReceipt = null;
  submitButton.classList.add("hidden");
  setEditButtonMode("confirm");
  statusText.textContent = "Confirm edits before submitting";
}

function enterEditMode() {
  if (isEditingReceipt) {
    confirmEdits();
    return;
  }

  if (!analyzedReceipt) {
    statusText.textContent = "Analyze a receipt first";
    return;
  }

  renderEditableReceipt(analyzedReceipt);
}

function confirmEdits() {
  if (!draftReceipt) {
    statusText.textContent = "Analyze a receipt first";
    return;
  }

  analyzedReceipt = {
    products: draftReceipt.products
      .map((product) => ({
        name: String(product.name || "").trim(),
        total: product.total ?? null,
        status: product.status || "Paid",
        dueDate: product.status === "Unpaid" ? product.dueDate || null : null,
        paymentType: product.paymentType || null,
      }))
      .filter((product) => product.name || product.total !== null),
    total: draftReceipt.total,
    status: null,
    dueDate: null,
    paymentType: null,
  };
  draftReceipt = null;
  setEditButtonMode("edit");
  statusText.textContent = "Edits confirmed";
  renderSheetPreview(buildLocalSheetPreview(analyzedReceipt));
  submitButton.classList.toggle("hidden", !healthState.googleSheetsConfigured);
}

function normalizeOcrText(text) {
  return String(text || "")
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function parseMoney(value) {
  const matches = String(value || "").match(/-?\d[\d,]*(?:\.\d{1,2})?/g);

  if (!matches?.length) {
    return null;
  }

  const amount = Number(matches[matches.length - 1].replace(/,/g, ""));
  return Number.isFinite(amount) ? amount : null;
}

function findTotal(lines) {
  const totalWords = /^(grand\s*)?total\b|^amount\s*due\b|^balance\b|^net\s*amount\b/i;
  const ignoredWords = /subtotal|sub\s*total|tax|vat|change|cash/i;

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

  const amounts = lines
    .map(parseMoney)
    .filter((amount) => amount !== null && amount > 0);

  return amounts.length ? Math.max(...amounts) : null;
}

function isAmountOnly(line) {
  return /^[^\d-]*-?\d[\d,]*(?:\.\d{2})$/.test(String(line || "").trim());
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
    const sameLineMatch = line.match(/^(.+?)\s+([$€£฿]?\s*\d[\d,]*\.\d{2})$/);

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
  const totalIndex = lines.findIndex((line) => /^total\b/i.test(line));
  const dateIndex = lines.findIndex((line) =>
    /\bdate\b|\d{1,2}[-/]\d{1,2}[-/]\d{2,4}/i.test(line)
  );
  const tableIndex = lines.findIndex((line) => /\btable\b|\bcovers?\b/i.test(line));
  const startIndex = tableIndex >= 0 ? tableIndex + 1 : dateIndex >= 0 ? dateIndex + 1 : 0;
  const endIndex = totalIndex >= 0 ? totalIndex : lines.length;

  return lines.slice(startIndex, endIndex);
}

function parseReceiptText(rawText) {
  const text = normalizeOcrText(rawText);
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const skipWords = /address|tel|date|receipt|table|covers?|total|subtotal|sub\s*total|tax|vat|change|cash|payment|paid|balance|thank|phone|email|reg|master/i;
  const total = findTotal(lines);
  let products = extractProducts(getLineItemCandidates(lines), skipWords);

  if (!products.length) {
    products = extractProducts(lines, skipWords);
  }

  return {
    products,
    total,
    status: "Paid",
    dueDate: null,
    paymentType: null,
    rawText: text,
  };
}

function buildLocalSheetPreview(receipt) {
  const products = receipt.products.length
    ? receipt.products
    : [{ name: "", total: receipt.total }];
  const total =
    receipt.total ??
    Number(products.reduce((sum, product) => {
      const price = Number(product.total);
      return Number.isFinite(price) ? sum + price : sum;
    }, 0).toFixed(2));
  const rows = products.map((product) => [
    "Created when submitted",
    product.name,
    product.total ?? receipt.total ?? "",
    product.status ?? receipt.status ?? "",
    (product.status ?? receipt.status) === "Unpaid"
      ? product.dueDate ?? receipt.dueDate ?? ""
      : "",
    product.paymentType ?? receipt.paymentType ?? "",
  ]);

  return {
    headers: ["Date", "Product", "Price", "Status", "Due Date", "Payment_Type"],
    rows,
    total,
  };
}

function renderOcrResult(receipt, sheetPreview) {
  renderSheetPreview(sheetPreview);
  resultOutput.insertAdjacentHTML(
    "beforeend",
    `
      <details class="ocr-raw">
        <summary>Raw OCR text</summary>
        <pre>${escapeHtml(receipt.rawText || "")}</pre>
      </details>
    `
  );
}

async function getOcrWorker() {
  if (ocrWorker) {
    return ocrWorker;
  }

  if (!window.Tesseract?.createWorker) {
    throw new Error("Tesseract.js is not loaded.");
  }

  ocrWorker = await window.Tesseract.createWorker("eng", 1, {
    workerPath: "/vendor/tesseract/worker.min.js",
    corePath: "/vendor/tesseract-core",
    langPath: "https://tessdata.projectnaptha.com/4.0.0",
    logger: (message) => {
      if (message.status === "recognizing text") {
        statusText.textContent = `Reading receipt ${Math.round(
          (message.progress || 0) * 100
        )}%`;
      } else if (message.status) {
        statusText.textContent = message.status;
      }
    },
  });

  await ocrWorker.setParameters({
    preserve_interword_spaces: "1",
    user_defined_dpi: "300",
  });

  return ocrWorker;
}

async function startCamera() {
  if (cameraStream) {
    return;
  }

  cameraStream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: "environment" },
    audio: false,
  });

  cameraPreview.srcObject = cameraStream;
}

function stopCamera() {
  if (!cameraStream) {
    return;
  }

  for (const track of cameraStream.getTracks()) {
    track.stop();
  }

  cameraPreview.srcObject = null;
  cameraStream = null;
}

function captureImage() {
  if (!cameraPreview.videoWidth || !cameraPreview.videoHeight) {
    statusText.textContent = "Camera is not ready yet";
    return;
  }

  captureCanvas.width = cameraPreview.videoWidth;
  captureCanvas.height = cameraPreview.videoHeight;
  const ctx = captureCanvas.getContext("2d");

  if (!ctx) {
    statusText.textContent = "Unable to prepare the camera image";
    return;
  }

  ctx.drawImage(cameraPreview, 0, 0);

  captureCanvas.toBlob((blob) => {
    if (!blob) {
      statusText.textContent = "Unable to create the image file";
      return;
    }

    const file = new File([blob], `receipt-${Date.now()}.jpg`, {
      type: "image/jpeg",
    });

    renderPreview(file);
    stopCamera();
  }, "image/jpeg", 0.92);
}

async function analyzeReceipt() {
  if (!currentFile) {
    statusText.textContent = "Choose an image first";
    return;
  }

  setBusyState(true);
  statusText.textContent = "Preparing OCR";
  resultOutput.textContent = "Reading text from the image...";
  submitButton.classList.add("hidden");
  setConfirmVisible(false);
  analyzedReceipt = null;
  draftReceipt = null;
  isEditingReceipt = false;

  try {
    const formData = new FormData();
    formData.append("receipt", currentFile);
    statusText.textContent = "Reading with PaddleOCR";

    const response = await fetch("/api/receipts/ocr", {
      method: "POST",
      body: formData,
    });
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "PaddleOCR is not available.");
    }

    analyzedReceipt = data.receipt;
    statusText.textContent = "Review or edit before submitting";
    renderOcrResult(
      { ...data.receipt, rawText: data.rawText || "" },
      data.sheetPreview || buildLocalSheetPreview(data.receipt)
    );
    setEditButtonMode("edit");
    submitButton.classList.toggle("hidden", !healthState.googleSheetsConfigured);
  } catch (error) {
    await analyzeReceiptWithTesseract(error);
  } finally {
    setBusyState(false);
    refreshReadyState();
  }
}

async function analyzeReceiptWithTesseract(paddleError) {
  const worker = await getOcrWorker();
  const { data } = await worker.recognize(currentFile);
  const receipt = parseReceiptText(data.text);
  const { rawText, ...receiptForSubmit } = receipt;
  const sheetPreview = buildLocalSheetPreview(receiptForSubmit);

  analyzedReceipt = receiptForSubmit;
  statusText.textContent = "Review or edit before submitting";
  renderOcrResult(receipt, sheetPreview);
  setEditButtonMode("edit");
  submitButton.classList.toggle("hidden", !healthState.googleSheetsConfigured);
  resultOutput.insertAdjacentHTML(
    "afterbegin",
    `<div class="preview-error">PaddleOCR unavailable, so this result used browser OCR. ${
      paddleError instanceof Error ? escapeHtml(paddleError.message) : ""
    }</div>`
  );
}

async function submitReceipt() {
  if (!analyzedReceipt) {
    statusText.textContent = "Analyze a receipt first";
    return;
  }

  setSubmitBusyState(true);
  statusText.textContent = "Submitting to Google Sheets";

  try {
    const response = await fetch("/api/receipts/submit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ receipt: analyzedReceipt }),
    });
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Unable to submit the receipt.");
    }

    statusText.textContent = data.sheet?.skipped
      ? "Sheet save was skipped."
      : "Saved to Google Sheets.";
    submitButton.classList.add("hidden");
  } catch (error) {
    statusText.textContent = "Submit failed";
    resultOutput.insertAdjacentHTML(
      "afterbegin",
      `<div class="preview-error">${
        error instanceof Error ? escapeHtml(error.message) : "Unknown error"
      }</div>`
    );
  } finally {
    setSubmitBusyState(false);
  }
}

uploadModeButton.addEventListener("click", () => setMode("upload"));
cameraModeButton.addEventListener("click", () => setMode("camera"));

receiptFile.addEventListener("change", (event) => {
  const [file] = event.target.files;
  if (file) {
    renderPreview(file);
  }
});

startCameraButton.addEventListener("click", async () => {
  try {
    await startCamera();
    statusText.textContent = "Camera is ready";
  } catch (error) {
    statusText.textContent = "Unable to open the camera";
    resultOutput.textContent =
      error instanceof Error ? error.message : "Unknown error";
  }
});

captureButton.addEventListener("click", captureImage);
analyzeButton.addEventListener("click", analyzeReceipt);
confirmEditButton.addEventListener("click", enterEditMode);
submitButton.addEventListener("click", submitReceipt);

window.addEventListener("beforeunload", stopCamera);
loadHealthStatus();
