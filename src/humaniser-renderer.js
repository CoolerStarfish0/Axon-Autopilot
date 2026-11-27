const source = document.getElementById("source");
const result = document.getElementById("result");
const rewriteButton = document.getElementById("rewrite");
const copyButton = document.getElementById("copy");
const clearButton = document.getElementById("clear");
const status = document.getElementById("status");
const warning = document.getElementById("warning");

rewriteButton.addEventListener("click", async () => {
  const text = source.value.trim();
  warning.textContent = "";
  if (!text) {
    status.textContent = "Paste some text first.";
    source.focus();
    return;
  }

  rewriteButton.disabled = true;
  copyButton.disabled = true;
  status.textContent = "Axon is rewriting locally with qwen3:8b...";
  result.value = "";

  try {
    const response = await window.autopilot.humaniseText(text);
    if (!response.ok) {
      status.textContent = response.message || "Could not rewrite the text.";
      return;
    }
    result.value = response.text;
    copyButton.disabled = false;
    status.textContent = response.message;
    if (response.missingProtected?.length) {
      warning.textContent = "Check these strings manually: " + response.missingProtected.join(" · ");
    }
  } catch (error) {
    status.textContent = "Humaniser error: " + error.message;
  } finally {
    rewriteButton.disabled = false;
  }
});

copyButton.addEventListener("click", async () => {
  if (!result.value) return;
  try {
    await navigator.clipboard.writeText(result.value);
    status.textContent = "Copied to clipboard.";
  } catch {
    result.focus();
    result.select();
    status.textContent = "Select the text and copy it manually.";
  }
});

clearButton.addEventListener("click", () => {
  source.value = "";
  result.value = "";
  warning.textContent = "";
  status.textContent = "Cleared.";
  copyButton.disabled = true;
  source.focus();
});
