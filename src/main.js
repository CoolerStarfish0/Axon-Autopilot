const { app, BrowserWindow, ipcMain, shell, screen: electronScreen } = require("electron");
const path = require("path");
const { uIOhook, UiohookKey } = require("uiohook-napi");
const { mouse, keyboard, screen, Point, Key } = require("@nut-tree-fork/nut-js");
const sharp = require("sharp");

let promptWindow = null;
let indicatorWindow = null;
let indicatorHideTimer = null;
let indicatorReady = false;
let indicatorState = "loading";
let lastRightShiftTap = 0;
let rightShiftPressed = false;
let backquotePressed = false;
let activeTaskController = null;
let typingDelayMs = 20;
let complexityLevel = "Medium";
let humanisePersonal = false;

const OLLAMA = "http://127.0.0.1:11434";
const VISION_MODEL = "qwen3-vl:8b";
const MAX_ACTIONS = 30;

function sendStatus(message) {
  if (promptWindow && !promptWindow.isDestroyed()) {
    promptWindow.webContents.send("autopilot:status", message);
  }
  console.log("[AUTOPILOT]", message);
}

function showPrompt() {
  if (!promptWindow || promptWindow.isDestroyed()) createPrompt();
  promptWindow.show();
  promptWindow.focus();
}

function hidePrompt() {
  if (promptWindow && !promptWindow.isDestroyed()) promptWindow.hide();
}

function showTaskIndicator() {
  if (indicatorHideTimer) {
    clearTimeout(indicatorHideTimer);
    indicatorHideTimer = null;
  }

  indicatorState = "loading";

  if (!indicatorWindow || indicatorWindow.isDestroyed()) {
    const area = electronScreen.getPrimaryDisplay().workArea;
    const width = 120;
    const height = 54;

    indicatorReady = false;

    indicatorWindow = new BrowserWindow({
      width,
      height,
      x: area.x + area.width - width - 22,
      y: area.y + area.height - height - 22,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: "#00000000",
      resizable: false,
      movable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      focusable: true,
      hasShadow: false,
      webPreferences: {
        preload: path.join(__dirname, "preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    });

    indicatorWindow.setIgnoreMouseEvents(false);
    indicatorWindow.setAlwaysOnTop(true, "screen-saver");

    indicatorWindow.webContents.on("did-finish-load", () => {
      if (!indicatorWindow || indicatorWindow.isDestroyed()) return;

      indicatorReady = true;
      indicatorWindow.webContents.send(
        indicatorState === "complete"
          ? "indicator:complete"
          : "indicator:loading"
      );

      indicatorWindow.showInactive();
    });

    indicatorWindow.loadFile(path.join(__dirname, "indicator.html"))
      .catch(error => {
        console.error("[AUTOPILOT] Indicator failed to load:", error);
      });

    indicatorWindow.on("closed", () => {
      indicatorWindow = null;
      indicatorReady = false;
    });

    return;
  }

  if (indicatorReady) {
    indicatorWindow.webContents.send("indicator:loading");
  }

  indicatorWindow.showInactive();
}

function completeTaskIndicator() {
  if (!indicatorWindow || indicatorWindow.isDestroyed()) return;

  indicatorState = "complete";

  if (indicatorReady) {
    indicatorWindow.webContents.send("indicator:complete");
  }

  if (indicatorHideTimer) clearTimeout(indicatorHideTimer);

  indicatorHideTimer = setTimeout(() => {
    if (indicatorWindow && !indicatorWindow.isDestroyed()) {
      indicatorWindow.hide();
    }
    indicatorHideTimer = null;
  }, 1200);
}

function hideTaskIndicator() {
  if (indicatorHideTimer) {
    clearTimeout(indicatorHideTimer);
    indicatorHideTimer = null;
  }

  if (indicatorWindow && !indicatorWindow.isDestroyed()) {
    indicatorWindow.hide();
  }
}
function createPrompt() {
  promptWindow = new BrowserWindow({
    width: 620,
    height: 430,
    show: false,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    backgroundColor: "#10141c",
    title: "Autopilot",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  promptWindow.loadFile(path.join(__dirname, "index.html"));
  promptWindow.on("closed", () => { promptWindow = null; });
}

function emergencyStop() {
  const controller = activeTaskController;
  if (!controller || controller.signal.aborted) return;
  controller.abort();
  sendStatus("EMERGENCY STOP: Task cancelled.");
}
function startKeyboardHook() {
  uIOhook.on("keydown", (event) => {
    if (event.keycode === UiohookKey.Escape) {
      hidePrompt();
      return;
    }

    if (
      event.keycode === UiohookKey.Backquote &&
      event.ctrlKey &&
      !backquotePressed
    ) {
      backquotePressed = true;
      emergencyStop();
      return;
    }

    if (event.keycode === UiohookKey.ShiftRight && !rightShiftPressed) {
      rightShiftPressed = true;
      const now = Date.now();

      if (lastRightShiftTap && now - lastRightShiftTap <= 400) {
        lastRightShiftTap = 0;
        showPrompt();
      } else {
        lastRightShiftTap = now;
      }
    }
  });

  uIOhook.on("keyup", (event) => {
    if (event.keycode === UiohookKey.ShiftRight) rightShiftPressed = false;
    if (event.keycode === UiohookKey.Backquote) backquotePressed = false;
  });

  uIOhook.start();

  console.log("Autopilot keyboard hook active.");
  console.log("Double Right Shift = show | ESC = hide | Ctrl + ` = emergency stop");
}

async function captureScreen() {
  const shot = await screen.grab();

  const raw = Buffer.from(shot.data);
  const png = await sharp(raw, {
    raw: {
      width: shot.width,
      height: shot.height,
      channels: shot.channels
    }
  })
    .resize({ width: 1280, withoutEnlargement: true })
    .png()
    .toBuffer();

  const metadata = await sharp(png).metadata();

  return {
    image: png.toString("base64"),
    originalWidth: shot.width,
    originalHeight: shot.height,
    previewWidth: metadata.width,
    previewHeight: metadata.height
  };
}

async function askVisionModel(task, screenshot, history, signal) {
  const models = ["qwen3-vl:8b", "qwen2.5vl:7b"];
  let lastError = null;

  for (const model of models) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      checkNotCancelled(signal);

      try {
        sendStatus(`Axon is analysing the screen with ${model} (attempt ${attempt})...`);

        const response = await fetch(`${OLLAMA}/api/chat`, {
          method: "POST",
          signal,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model,
            stream: false,
            format: "json",
            messages: [
              {
                role: "system",
                content: `
You are Axon, a Windows desktop computer-use agent.
You must choose exactly ONE next action based on the screenshot.

Allowed actions:
{"action":"click","x":100,"y":200}
{"action":"move","x":100,"y":200}
{"action":"type","text":"text"}
{"action":"press","keys":["LeftControl","A"]}
{"action":"scroll","direction":"down","amount":3}
{"action":"wait","seconds":2}
{"action":"done","message":"Completed"}
{"action":"ask_user","message":"Need approval"}
{"action":"unsupported","reason":"Reason"}

Screenshot dimensions: ${screenshot.previewWidth}x${screenshot.previewHeight}.
Coordinates must refer to this screenshot.

COORDINATE RULES (MANDATORY):
- For click and move, ALWAYS include both x and y.
- x and y MUST be JSON numbers, never strings, null, or omitted.
- x must be between 0 and ${screenshot.previewWidth - 1}.
- y must be between 0 and ${screenshot.previewHeight - 1}.
- Use the exact screenshot dimensions above.
- Never output percentages, normalized coordinates, or coordinates from memory.
- If you cannot identify a reliable target, return ask_user instead of guessing.

Rules:
- Inspect the screenshot before acting.
- Never invent screen elements or coordinates.
- Make one action at a time.
- CRITICAL TASK-INSTRUCTION VS DOCUMENT-CONTENT RULES:
  - The TASK is an instruction for you. It is NEVER text to type into an application.
  - NEVER type, copy, paste, or reproduce the user's task instruction itself.
  - For a writing task, first understand what content the user wants.
  - If the user has not supplied the actual document text, COMPOSE the requested content yourself.
  - The type action must contain ONLY the finished document content, never the instruction or a description of the task.
  - Example: TASK "Write a short paragraph about pollution in India during Diwali in the open Google Doc." means compose the paragraph about that topic. Do NOT type that sentence.
  - If the editor is already focused and ready, type the composed content.
  - If the editor is visible but not focused, click the main writing area ONCE, then type the composed content.
  - Never repeatedly click the same document or writing area.
  - After typing, inspect the screenshot to verify the content.
  - If the content is already present, do NOT type it again. Return done.
  - Never repeat a successful type action.
- For writing tasks, add relevant, accurate information.
- For documentaries, reports and articles, write substantial, well-organized content with a title, introduction, descriptive section headings, multiple informative paragraphs and a conclusion.
- For a documentary about a country, cover its geography, history, culture, wildlife, important places and other relevant topics.
- Do not finish a substantial writing task with just one short paragraph.
- NEVER insert a page break. Do not use Ctrl+Enter, Ctrl+Shift+Enter or any page-break command.
- Use ordinary Enter for paragraph breaks. Keep consecutive paragraphs together on the same page when space allows.
- Do not invent facts or citations.
- Never handle passwords.
- Ask before consequential submissions, deletion, sharing or publishing.
- Return ONLY one valid JSON object. Do not return Markdown.
                `
              },
              {
                role: "user",
                content: `TASK: ${task}\nPrevious actions: ${JSON.stringify(history)}\nChoose the next action from the screenshot.`,
                images: [screenshot.image]
              }
            ],
            options: {
              temperature: 0.1,
              num_predict: 2200
            }
          })
        });

        const data = await response.json();

        if (!response.ok) {
          throw new Error(data.error || `Ollama HTTP ${response.status}`);
        }

        const content = data.message?.content?.trim();

        if (!content) {
          throw new Error(
            `Empty content from ${model}. Thinking length: ${data.message?.thinking?.length || 0}`
          );
        }

        let parsed;

        try {
          parsed = JSON.parse(content);
        } catch {
          const cleaned = content
            .replace(/^```(?:json)?\s*/i, "")
            .replace(/\s*```$/, "")
            .trim();

          const start = cleaned.indexOf("{");
          const end = cleaned.lastIndexOf("}");

          if (start < 0 || end <= start) {
            throw new Error("Model response did not contain a JSON object.");
          }

          parsed = JSON.parse(cleaned.slice(start, end + 1));
        }

        const allowed = [
          "click", "move", "type", "press", "scroll",
          "wait", "done", "ask_user", "unsupported"
        ];

        if (!parsed || !allowed.includes(parsed.action)) {
          throw new Error("Model returned an unknown action.");
        }

        console.log(`[AXON] Valid action received from ${model}: ${parsed.action}`);
        return parsed;

      } catch (error) {
        if (error.name === "AbortError" || signal.aborted) throw error;

        lastError = error;
        console.error(`[AXON] ${model}, attempt ${attempt}:`, error.message);
      }
    }
  }

  throw new Error(
    "Both vision models failed. Last error: " +
    (lastError?.message || "Unknown error")
  );
}
function resolveKey(name) {
  const aliases = {
    CTRL: "LeftControl",
    CONTROL: "LeftControl",
    ALT: "LeftAlt",
    SHIFT: "LeftShift",
    ENTER: "Return",
    ESC: "Escape",
    BACKTICK: "Grave"
  };

  const keyName = aliases[String(name).toUpperCase()] || name;
  const value = Key[keyName];

  if (typeof value !== "number") {
    throw new Error(`Unsupported keyboard key: ${name}`);
  }

  return value;
}

function checkNotCancelled(signal) {
  if (signal.aborted) {
    const error = new Error("Task cancelled.");
    error.name = "AbortError";
    throw error;
  }
}

async function executeAction(action, screenshot, signal) {
  checkNotCancelled(signal);

  if (action.action === "click" || action.action === "move") {
    console.log("[AXON DEBUG] Raw coordinate action:", JSON.stringify(action));
    console.log("[AXON DEBUG] Screenshot dimensions:", {
      originalWidth: screenshot.originalWidth,
      originalHeight: screenshot.originalHeight,
      previewWidth: screenshot.previewWidth,
      previewHeight: screenshot.previewHeight
    });

    const x = Number(action.x);
    const y = Number(action.y);

    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      console.error("[AXON DEBUG] Invalid coordinate values:", {
        x: action.x,
        y: action.y,
        action
      });
      throw new Error("The model supplied invalid screen coordinates.");
    }

    const actualX = Math.round(
      x * screenshot.originalWidth / screenshot.previewWidth
    );
    const actualY = Math.round(
      y * screenshot.originalHeight / screenshot.previewHeight
    );

    const safeX = Math.max(0, Math.min(screenshot.originalWidth - 1, actualX));
    const safeY = Math.max(0, Math.min(screenshot.originalHeight - 1, actualY));

    await mouse.setPosition(new Point(safeX, safeY));

    if (action.action === "click") {
      checkNotCancelled(signal);
      await mouse.leftClick();
    }

    return `${action.action} at ${safeX}, ${safeY}`;
  }

  if (action.action === "type") {
    const value = String(action.text || "").slice(0, 7000);
    if (!value) throw new Error("The model supplied no text to type.");

    for (const character of value) {
      checkNotCancelled(signal);
      await keyboard.type(character);
      checkNotCancelled(signal);

      if (typingDelayMs > 0) {
        await new Promise(resolve =>
          setTimeout(resolve, typingDelayMs)
        );
      }
    }

    checkNotCancelled(signal);
    return "Typed text";
  }

  if (action.action === "press") {
    const names = Array.isArray(action.keys) ? action.keys : [action.key];
    if (!names.length || names.length > 3) {
      throw new Error("Invalid key combination.");
    }

    const keys = names.map(resolveKey);

    checkNotCancelled(signal);
    await keyboard.pressKey(...keys);

    try {
      checkNotCancelled(signal);
    } finally {
      await keyboard.releaseKey(...keys);
    }

    return `Pressed ${names.join(" + ")}`;
  }

  if (action.action === "scroll") {
    const amount = Math.max(1, Math.min(5, Number(action.amount) || 1));
    checkNotCancelled(signal);

    if (action.direction === "up") await mouse.scrollUp(amount);
    else if (action.direction === "down") await mouse.scrollDown(amount);
    else throw new Error("Invalid scroll direction.");

    return `Scrolled ${action.direction}`;
  }

  if (action.action === "wait") {
    const seconds = Math.max(0.5, Math.min(5, Number(action.seconds) || 1));
    await new Promise(resolve => setTimeout(resolve, seconds * 1000));
    checkNotCancelled(signal);
    return `Waited ${seconds} seconds`;
  }

  throw new Error(`Unknown action: ${action.action}`);
}

async function runAgent(task, signal) {
  const history = [];
  const typedTexts = new Set();
  const clickedPositions = [];
  const originalInstruction = task
    .split("\n\nAUTOPILOT STYLE SETTINGS:")[0]
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");

  const isWritingTask =
    /\b(write|draft|compose|document|essay|report|article|documentary)\b/i
      .test(originalInstruction);

  for (let step = 1; step <= MAX_ACTIONS; step++) {
    checkNotCancelled(signal);

    sendStatus(`Observing your screen... (step ${step})`);
    const screenshot = await captureScreen();

    checkNotCancelled(signal);

    sendStatus("Qwen3-VL is deciding the next action...");
    const action = await askVisionModel(task, screenshot, history, signal);

    checkNotCancelled(signal);

    if (action.action === "done") {
      const message = action.message || "Task completed.";
      sendStatus(message);
      return { ok: true, message };
    }

    if (action.action === "ask_user") {
      const message = action.message || "Autopilot needs your approval.";
      sendStatus(message);
      return { ok: false, message };
    }

    if (action.action === "unsupported") {
      const message = action.reason || "This action is not supported.";
      sendStatus(message);
      return { ok: false, message };
    }

    if (action.action === "type") {
      const proposedText = String(action.text || "").trim();
      const normalizedText = proposedText.toLowerCase().replace(/\s+/g, " ");

      // Never allow the original instruction to be typed into an application.
      if (
        normalizedText === originalInstruction ||
        (originalInstruction.length >= 20 &&
          normalizedText.includes(originalInstruction))
      ) {
        sendStatus("Blocked: Axon tried to type your instruction instead of the requested content.");
        return {
          ok: false,
          message: "Blocked an attempt to type your task instruction. No text was entered by this action."
        };
      }

      // Never type identical content twice in the same task.
      if (typedTexts.has(normalizedText)) {
        sendStatus("Duplicate text blocked. Stopping to prevent repeated writing.");
        return {
          ok: true,
          message: "The text was already entered once. Stopped to prevent duplicate writing."
        };
      }
    }

    if (action.action === "click") {
      const clickX = Number(action.x);
      const clickY = Number(action.y);

      const repeatedClickCount = clickedPositions.filter(point =>
        Math.hypot(point.x - clickX, point.y - clickY) <= 3
      ).length;

      const repeatedClick = repeatedClickCount >= 2;

      if (repeatedClick) {
        sendStatus("Repeated click blocked. Stopping to prevent an endless clicking loop.");
        return {
          ok: false,
          message: "Axon attempted to click the same screen area again. Task stopped safely."
        };
      }
    }


    sendStatus(`Executing: ${action.action}`);
    const result = await executeAction(action, screenshot, signal);

    if (action.action === "click") {
      clickedPositions.push({
        x: Number(action.x),
        y: Number(action.y)
      });

      console.log(`[AXON] Recorded click at ${action.x}, ${action.y}`);
    }

    if (action.action === "type") {
      typedTexts.add(
        String(action.text || "").trim().toLowerCase().replace(/\s+/g, " ")
      );
    }

    history.push({
      action: action.action,
      x: action.x,
      y: action.y,
      text: action.text,
      result
    });

    if (history.length > 12) history.shift();

    checkNotCancelled(signal);

    // Writing tasks must never return to the vision loop after typing.
    if (isWritingTask && action.action === "type") {
      const message = "Document text entered in one operation. Stopped further actions to prevent unwanted navigation or duplicate writing.";
      sendStatus(message);
      return { ok: true, message };
    }
  }

  const message = "Stopped after 30 actions to prevent an uncontrolled loop.";
  sendStatus(message);
  return { ok: false, message };
}

ipcMain.on("autopilot:settings", (_event, settings) => {
  if (!settings || typeof settings !== "object") return;

  const delay = Number(settings.typingDelayMs);
  if (Number.isFinite(delay)) {
    typingDelayMs = Math.max(0, Math.min(120, Math.round(delay)));
  }

  if (["Low", "Medium", "High"].includes(settings.complexity)) {
    complexityLevel = settings.complexity;
  }

  humanisePersonal = settings.humanisePersonal === true;
});

function buildStyledTask(task) {
  const instructions = [
    `English complexity: ${complexityLevel}.`,
    complexityLevel === "Low"
      ? "Use simple vocabulary and short, clear sentences."
      : complexityLevel === "High"
        ? "Use more advanced vocabulary and varied sentence structures where appropriate."
        : "Use clear, natural everyday English.",
    humanisePersonal
      ? "For explicitly personal, non-school writing tasks only, use a natural conversational tone. Do not apply this instruction to schoolwork or academic assignments."
      : ""
  ].filter(Boolean).join(" ");

  return `${task}\n\nAUTOPILOT STYLE SETTINGS:\n${instructions}`;
}
ipcMain.handle("autopilot:submit", async (_event, task) => {
  if (typeof task !== "string" || !task.trim()) {
    return { ok: false, message: "Enter a task first." };
  }

  if (activeTaskController) {
    return { ok: false, message: "A task is already running." };
  }

  const controller = new AbortController();
  activeTaskController = controller;

  try {
    showTaskIndicator();

    // Hide Autopilot so it cannot see or type into its own prompt.
    hidePrompt();

    // Allow Windows to restore focus to the application behind Autopilot.
    await new Promise(resolve => setTimeout(resolve, 350));

    const result = await runAgent(
      buildStyledTask(task.trim().slice(0, 4000)),
      controller.signal
    );

    if (result.ok) {
      completeTaskIndicator();
    } else {
      hideTaskIndicator();
    }

    return result;
  } catch (error) {
    hideTaskIndicator();
    if (error.name === "AbortError" || controller.signal.aborted) {
      sendStatus("Emergency stop: Task cancelled.");
      return { ok: false, message: "Task cancelled." };
    }

    console.error(error);
    const message = "Agent error: " + error.message;
    sendStatus(message);
    return { ok: false, message };
  } finally {
    if (activeTaskController === controller) {
      activeTaskController = null;
    }
  }
});

ipcMain.on("autopilot:hide", hidePrompt);
ipcMain.on("autopilot:stop", emergencyStop);

app.whenReady().then(() => {
  createPrompt();
  startKeyboardHook();
});

app.on("before-quit", () => {
  if (activeTaskController) activeTaskController.abort();
  try { uIOhook.stop(); } catch {}
});




















