const accessForm = document.getElementById("accessForm");
const accessCode = document.getElementById("accessCode");
const accessButton = document.getElementById("accessButton");
const accessMessage = document.getElementById("accessMessage");

function setBusy(isBusy) {
  accessButton.disabled = isBusy;
  accessButton.textContent = isBusy ? "Checking..." : "Continue";
}

accessForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const pass = accessCode.value.trim();

  if (!pass) {
    accessMessage.textContent = "Enter your access code.";
    return;
  }

  setBusy(true);
  accessMessage.textContent = "";

  try {
    const response = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pass }),
    });
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Access code was not accepted.");
    }

    window.location.href = "/upload";
  } catch (error) {
    accessMessage.textContent =
      error instanceof Error ? error.message : "Unable to sign in.";
  } finally {
    setBusy(false);
  }
});
