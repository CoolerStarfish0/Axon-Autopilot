const taskInput = document.getElementById("task");
const submitButton = document.getElementById("submit");
const statusText = document.getElementById("status");

const speedSlider = document.getElementById("speedSlider");
const speedValue = document.getElementById("speedValue");
const speedFill = document.getElementById("speedFill");

const complexitySlider = document.getElementById("complexitySlider");
const complexityValue = document.getElementById("complexityValue");
const complexityFill = document.getElementById("complexityFill");

const humaniseCheckbox = document.getElementById("humanise");

let complexityDragging = false;

function updateFill(slider, fill) {
  const min = Number(slider.min);
  const max = Number(slider.max);
  const value = Number(slider.value);
  const percentage = ((value - min) / (max - min)) * 100;

  fill.style.width = `${percentage}%`;
}

function getComplexityName(value) {
  if (value < 25) return "Low";
  if (value < 75) return "Medium";
  return "High";
}

function sendSettings() {
  const speed = Number(speedSlider.value);

  // 1 = slowest, 100 = fastest.
  const typingDelayMs = Math.round((100 - speed) * 1.2);

  window.autopilot.updateSettings({
    typingDelayMs,
    complexity: getComplexityName(Number(complexitySlider.value)),
    humanisePersonal: humaniseCheckbox.checked
  });
}

speedSlider.addEventListener("input", () => {
  updateFill(speedSlider, speedFill);
  speedValue.textContent = `${speedSlider.value}%`;
  sendSettings();
});

complexitySlider.addEventListener("input", () => {
  updateFill(complexitySlider, complexityFill);
  complexityValue.textContent =
    getComplexityName(Number(complexitySlider.value));
  sendSettings();
});

function snapComplexity() {
  const value = Number(complexitySlider.value);
  const snapPoints = [0, 50, 100];

  const nearest = snapPoints.reduce((best, point) =>
    Math.abs(point - value) < Math.abs(best - value) ? point : best
  );

  complexitySlider.value = nearest;
  updateFill(complexitySlider, complexityFill);
  complexityValue.textContent = getComplexityName(nearest);
  sendSettings();
}

complexitySlider.addEventListener("pointerdown", () => {
  complexityDragging = true;
});

complexitySlider.addEventListener("pointerup", () => {
  complexityDragging = false;
  snapComplexity();
});

complexitySlider.addEventListener("pointercancel", () => {
  complexityDragging = false;
  snapComplexity();
});

complexitySlider.addEventListener("change", () => {
  if (!complexityDragging) snapComplexity();
});

humaniseCheckbox.addEventListener("change", sendSettings);

window.autopilot.onStatus((message) => {
  statusText.textContent = message;
});

async function submitTask() {
  const task = taskInput.value.trim();

  if (!task) {
    statusText.textContent = "Enter a task first.";
    taskInput.focus();
    return;
  }

  sendSettings();

  submitButton.disabled = true;
  statusText.textContent = "Sending task to Qwen3...";

  try {
    const result = await window.autopilot.submitTask(task);
    statusText.textContent = result.message;

    if (result.ok) taskInput.value = "";
  } catch (error) {
    statusText.textContent = "Could not submit task: " + error.message;
    console.error(error);
  } finally {
    submitButton.disabled = false;
    taskInput.focus();
  }
}

submitButton.addEventListener("click", submitTask);

taskInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    submitTask();
  }
});

function createBubbleLayer(fill) {
  const layer = document.createElement("div");
  layer.className = "bubble-layer";
  fill.appendChild(layer);

  for (let i = 0; i < 14; i++) {
    const bubble = document.createElement("span");
    bubble.className = "bubble";

    const size = 3 + Math.random() * 6;
    const drift = () => `${Math.round((Math.random() - 0.5) * 25)}px`;

    bubble.style.setProperty("--size", `${size}px`);
    bubble.style.setProperty("--left", `${Math.random() * 100}%`);
    bubble.style.setProperty("--duration", `${1.4 + Math.random() * 2.2}s`);
    bubble.style.setProperty("--delay", `${-Math.random() * 3.5}s`);
    bubble.style.setProperty("--drift1", drift());
    bubble.style.setProperty("--drift2", drift());
    bubble.style.setProperty("--drift3", drift());

    layer.appendChild(bubble);
  }
}

createBubbleLayer(speedFill);
createBubbleLayer(complexityFill);
// Initialise the UI and send its default settings to the main process.
updateFill(speedSlider, speedFill);
updateFill(complexitySlider, complexityFill);
sendSettings();

