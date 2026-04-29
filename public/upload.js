const uploadModeButton = document.getElementById("uploadModeButton");
const cameraModeButton = document.getElementById("cameraModeButton");
const filePickerPanel = document.getElementById("filePickerPanel");
const cameraPanel = document.getElementById("cameraPanel");
const receiptFile = document.getElementById("receiptFile");
const previewPanel = document.getElementById("previewPanel");
const imagePreview = document.getElementById("imagePreview");
const previewName = document.getElementById("previewName");
const analyzeButton = document.getElementById("analyzeButton");
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
let healthState = {
  geminiConfigured: false,
  googleSheetsConfigured: false,
  loaded: false,
};

function refreshReadyState() {
  if (!healthState.loaded) {
    analyzeButton.disabled = true;
    statusText.textContent = "Checking configuration";
    return;
  }

  if (!healthState.geminiConfigured) {
    analyzeButton.disabled = true;
    statusText.textContent = "Gemini API key is missing";
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
      geminiConfigured: Boolean(data.geminiConfigured),
      googleSheetsConfigured: Boolean(data.googleSheetsConfigured),
      loaded: true,
    };

    if (!healthState.geminiConfigured) {
      resultOutput.textContent =
        "Add GEMINI_API_KEY=... to the .env file, then restart the server.";
    } else if (!healthState.googleSheetsConfigured) {
      resultOutput.textContent =
        "Receipt analysis is available, but Google Sheets settings are missing in .env.";
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
  previewName.textContent = file.name;
  imagePreview.src = URL.createObjectURL(file);
  previewPanel.classList.remove("hidden");
  submitButton.classList.add("hidden");
  refreshReadyState();
}

function setBusyState(isBusy) {
  analyzeButton.disabled = isBusy || !healthState.geminiConfigured || !currentFile;
  analyzeButton.textContent = isBusy
    ? "Analyzing receipt..."
    : "Analyze receipt";
}

function setSubmitBusyState(isBusy) {
  submitButton.disabled = isBusy || !analyzedReceipt;
  submitButton.textContent = isBusy
    ? "Submitting..."
    : "Submit to Google Sheets";
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
    <div class="preview-note">Review this data before sending it to Google Sheets.</div>
    <div class="preview-scroll">
      <table class="preview-table">
        <thead><tr>${headerCells}</tr></thead>
        <tbody>${bodyRows}</tbody>
      </table>
    </div>
  `;
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
  if (!healthState.geminiConfigured) {
    statusText.textContent = "Gemini API key is missing";
    resultOutput.textContent =
      "Add GEMINI_API_KEY=... to the .env file, then restart the server.";
    return;
  }

  if (!currentFile) {
    statusText.textContent = "Choose an image first";
    return;
  }

  setBusyState(true);
  statusText.textContent = "Uploading image for analysis";
  resultOutput.textContent = "Processing...";
  submitButton.classList.add("hidden");
  analyzedReceipt = null;

  const formData = new FormData();
  formData.append("receipt", currentFile);

  try {
    const response = await fetch("/api/receipts/analyze", {
      method: "POST",
      body: formData,
    });
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Unable to analyze the receipt.");
    }

    analyzedReceipt = data.receipt;
    statusText.textContent = "Review before submitting";
    renderSheetPreview(data.sheetPreview || []);
    submitButton.classList.toggle("hidden", !healthState.googleSheetsConfigured);
  } catch (error) {
    statusText.textContent = "Something went wrong";
    resultOutput.textContent =
      error instanceof Error ? error.message : "Unknown error";
  } finally {
    setBusyState(false);
    refreshReadyState();
  }
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
submitButton.addEventListener("click", submitReceipt);

window.addEventListener("beforeunload", stopCamera);
loadHealthStatus();
