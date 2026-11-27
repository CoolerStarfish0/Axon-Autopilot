const MODEL = "qwen3:8b";
const MAX_INPUT_LENGTH = 12000;

function collectProtectedTokens(source) {
  const patterns = [
    /https?:\/\/[^\s)\]}>,]+/gi,
    /\b10\.\d{4,9}\/[^\s]+/gi,
    /\[[0-9,;\s-]+\]/g,
    /\([A-Z][^()]{1,90},\s*(?:18|19|20)\d{2}[a-z]?\)/g,
    /["“”][^"“”\n]{2,160}["“”]/g,
    /\b\d[\d,]*(?:\.\d+)?\s?(?:%|percent|kg|g|mg|km|m|cm|mm|°C|°F|million|billion|trillion)?\b/gi,
    /\b[A-Z]{2,}(?:-[A-Z0-9]+)*\b/g
  ];
  const tokens = new Set();
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) tokens.add(match[0]);
  }
  return [...tokens];
}

function registerHumaniserIpc(ipcMain, ollamaUrl) {
  ipcMain.handle("humaniser:rewrite", async (_event, input) => {
    if (typeof input !== "string" || !input.trim()) {
      return { ok: false, message: "Paste some text first." };
    }
    const source = input.trim();
    if (source.length > MAX_INPUT_LENGTH) {
      return { ok: false, message: `Text is too long. The current limit is ${MAX_INPUT_LENGTH.toLocaleString()} characters.` };
    }

    const protectedTokens = collectProtectedTokens(source);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120000);

    try {
      const response = await fetch(`${ollamaUrl}/api/chat`, {
        method: "POST",
        signal: controller.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: MODEL,
          stream: false,
          think: false,
          messages: [
            {
              role: "system",
              content: [
                "You are Axon's Natural Writing Editor.",
                "Rewrite the user's supplied text so it reads clearly, naturally, and smoothly.",
                "Preserve the author's meaning, claims, reasoning, point of view, and level of certainty.",
                "Do not add facts, examples, arguments, sources, quotations, or citations.",
                "Do not remove qualifications, caveats, or important details.",
                "Keep every number, date, measurement, named entity, acronym, URL, quotation, and citation exactly as supplied wherever possible.",
                "Keep citation formatting and citation placement attached to the same claims.",
                "Do not fabricate or repair incomplete citations.",
                "Use natural everyday English. Avoid stiff phrasing, needless formality, filler, and repetitive sentence openings.",
                "Do not deliberately add errors, awkwardness, slang, or fake personal anecdotes.",
                "Return only the rewritten text. No preface, explanation, quotation marks around the whole answer, or markdown code fence."
              ].join("\n")
            },
            {
              role: "user",
              content: `Rewrite this in the Natural style. Preserve these protected strings exactly: ${JSON.stringify(protectedTokens)}\n\nSOURCE TEXT:\n${source}`
            }
          ],
          options: { temperature: 0.25, num_predict: 5000 }
        })
      });

      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `Ollama HTTP ${response.status}`);
      const rewritten = String(data.message?.content || "").trim();
      if (!rewritten) throw new Error("The local model returned an empty rewrite.");

      const missingProtected = protectedTokens.filter(token => !rewritten.includes(token));
      return {
        ok: true,
        text: rewritten,
        validation: missingProtected.length === 0 ? "passed" : "review",
        missingProtected,
        message: missingProtected.length
          ? "Review required: one or more protected facts or citations changed or were omitted."
          : "Rewrite complete. Protected strings were retained; still review the result before using it."
      };
    } catch (error) {
      const message = error.name === "AbortError"
        ? "The rewrite timed out. Check that Ollama is running and try again."
        : error.message;
      return { ok: false, message };
    } finally {
      clearTimeout(timeout);
    }
  });
}

module.exports = { registerHumaniserIpc };
