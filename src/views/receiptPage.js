function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function renderReceiptPage(user = {}) {
  const displayName = escapeHtml(user.name || user.id || "User");

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Upload Receipt</title>
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link
      href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap"
      rel="stylesheet"
    />
    <link rel="stylesheet" href="/assets/styles.css?v=block-parser-2" />
  </head>
  <body class="app-body">
    <main class="app-shell">
      <section class="app-header">
        <div>
          <p class="eyebrow">Receipt AI</p>
          <h1>Capture or upload a receipt</h1>
        </div>
        <div class="header-actions">
          <span class="user-badge">Signed in as <strong>${displayName}</strong></span>
          <a class="back-link" href="/">Home</a>
        </div>
      </section>

      <section class="workspace">
        <article class="upload-card">
          <div class="actions-row">
            <button class="toggle-button active" id="uploadModeButton" type="button">
              Upload
            </button>
            <button class="toggle-button" id="cameraModeButton" type="button">
              Camera
            </button>
          </div>

          <div class="picker-area" id="filePickerPanel">
            <label class="picker-box" for="receiptFile">
              <input
                id="receiptFile"
                name="receipt"
                type="file"
                accept="image/*"
                hidden
              />
              <span>Choose a receipt image</span>
              <small>Use a phone photo, screenshot, or scanned receipt file.</small>
            </label>
          </div>

          <div class="camera-area hidden" id="cameraPanel">
            <video id="cameraPreview" playsinline autoplay muted></video>
            <canvas id="captureCanvas" hidden></canvas>
            <div class="camera-actions">
              <button class="secondary-button" id="startCameraButton" type="button">
                Start camera
              </button>
              <button class="secondary-button" id="captureButton" type="button">
                Capture photo
              </button>
            </div>
          </div>

          <div class="preview-card hidden" id="previewPanel">
            <img id="imagePreview" alt="Receipt preview" />
            <div class="preview-meta">
              <strong id="previewName">No image selected</strong>
              <button class="primary-button" id="analyzeButton" type="button">
                Analyze receipt
              </button>
            </div>
          </div>
        </article>

        <article class="result-card">
          <div class="result-head">
            <h2>Result</h2>
            <span id="statusText">Checking configuration</span>
          </div>
          <div class="sheet-preview" id="resultOutput">Loading...</div>
          <div class="result-actions">
            <button class="confirm-button hidden" id="confirmEditButton" type="button">
              Edit
            </button>
            <button class="submit-button hidden" id="submitButton" type="button">
              Submit to Google Sheets
            </button>
          </div>
        </article>
      </section>
    </main>
    <script type="module" src="/assets/upload.js?v=block-parser-2"></script>
  </body>
</html>`;
}
