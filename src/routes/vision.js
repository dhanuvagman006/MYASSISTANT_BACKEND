/**
 * VISION — Group B: Camera, Photos and Documents.
 *
 *   B1 Photo questions     mode=ask + image + question
 *   B2 Document reading    mode=ask + PDF (≤ ~50 pages / 18 MB) [+ question]
 *   B3 Scan to text (OCR)  mode=ocr + image
 *   B4 Screenshot helper   mode=screenshot + image → answer + optional
 *                          {type:"calendar", title, startIso…} action the
 *                          app turns into a one-tap reminder for approval.
 *
 * One Gemini multimodal call per request — images and PDFs are both
 * native inputs, so there is no separate OCR engine, PDF parser, or
 * second model hop to slow things down or break. Follow-up questions
 * reuse the SAME uploaded file with prior Q&A as text history.
 */
const router = require("express").Router();
const multer = require("multer");

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 18 * 1024 * 1024 }, // Gemini inline limit ~20 MB
});

const OK_MIME = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
]);

const PROMPTS = {
  ask: (q) =>
    (q
      ? `Answer the user's question about the attached file: ${q}`
      : "Summarize the attached file in plain, friendly language. For documents: what it is, the key points, anything the user must act on (amounts, dates, deadlines).") +
    " Reply in the user's language if the question is not in English; otherwise match the document's language when summarizing. Be concise.",
  ocr:
    "Transcribe ALL text in this image exactly as written. Preserve the reading order and line breaks. Keep the original language and script — do NOT translate. Output ONLY the transcribed text, no commentary, no markdown fences.",
  screenshot: (q, nowIso, tz) =>
    `You are a screenshot assistant. Current date-time: ${nowIso} (UTC offset ${tz} minutes).
Look at the image and reply with STRICT JSON only (no markdown fences):
{"answer": "<1-3 helpful sentences: what this is and the useful next step${q ? `, answering: ${q}` : ""}>",
 "action": null OR {"type":"calendar","title":"<short event title>","startIso":"<ISO 8601 with offset>","endIso":"<ISO or null>","location":"<text or null>"}}
Set "action" ONLY when the image clearly shows an event with a date (poster, invitation, ticket, booking, meeting screenshot). Resolve relative dates ("this Saturday") using the current date-time. If the year is missing assume the next future occurrence. No event → "action": null.`,
};

// Multer as an explicit step so its errors (e.g. LIMIT_FILE_SIZE) become
// clean JSON the app can show, instead of falling through to the generic
// 500 handler.
const receiveFile = (req, res, next) =>
  upload.single("file")(req, res, (err) => {
    if (!err) return next();
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({ error: "file too large (max 18 MB)" });
    }
    console.error("vision upload:", err.message);
    return res.status(400).json({ error: "bad upload" });
  });

router.post("/", receiveFile, async (req, res) => {
  try {
    const f = req.file;
    if (!f || !f.buffer?.length) {
      return res.status(400).json({ error: "file required" });
    }
    if (!OK_MIME.has(f.mimetype)) {
      return res.status(415).json({ error: `unsupported type ${f.mimetype}` });
    }
    const key = process.env.GEMINI_API_KEY;
    if (!key) {
      // Vision needs Gemini specifically — make the
      // misconfiguration loud in the logs so it isn't mistaken for a
      // client-side network problem.
      console.error("vision: GEMINI_API_KEY is not set — /vision disabled");
      return res.status(503).json({ error: "vision not configured" });
    }

    const mode = ["ask", "ocr", "screenshot"].includes(req.body.mode)
      ? req.body.mode
      : "ask";
    const question = String(req.body.question || "").slice(0, 2000);
    const tz = Number(req.get("X-TZ-Offset")) || 330;
    const nowIso = new Date(Date.now() + tz * 60000)
      .toISOString()
      .replace("Z", "");

    const prompt =
      mode === "ocr"
        ? PROMPTS.ocr
        : mode === "screenshot"
          ? PROMPTS.screenshot(question, nowIso, tz)
          : PROMPTS.ask(question);

    // Prior Q&A about this same file (JSON [{role, content}…]) so
    // follow-ups have context without re-describing the file.
    let history = [];
    try {
      const h = JSON.parse(req.body.history || "[]");
      if (Array.isArray(h)) {
        history = h.slice(-8).map((m) => ({
          role: m.role === "assistant" ? "model" : "user",
          parts: [{ text: String(m.content || "").slice(0, 4000) }],
        }));
      }
    } catch (_) {}

    const model = process.env.GEMINI_VISION_MODEL || "gemini-2.5-flash";
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": key },
        signal: AbortSignal.timeout(60_000), // 50-page PDFs need headroom
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [
                {
                  inline_data: {
                    mime_type: f.mimetype,
                    data: f.buffer.toString("base64"),
                  },
                },
                { text: prompt },
              ],
            },
            ...history,
            // History present → the last user question drives the turn.
            ...(history.length && question
              ? [{ role: "user", parts: [{ text: question }] }]
              : []),
          ],
          generationConfig:
            mode === "screenshot"
              ? { response_mime_type: "application/json", temperature: 0.2 }
              : { temperature: 0.4 },
        }),
      }
    );
    if (!r.ok) {
      // Gemini's body says WHY (invalid key, unknown model, quota…) — the
      // status alone (400/403/429) is not enough to fix anything.
      const detail = (await r.text().catch(() => "")).slice(0, 500);
      console.error("vision gemini", r.status, detail);
      if (r.status === 429) {
        return res
          .status(429)
          .json({ error: "AI is busy right now — try again in a moment" });
      }
      return res.status(502).json({ error: "vision failed" });
    }
    const data = await r.json();
    const text =
      data.candidates?.[0]?.content?.parts?.map((p) => p.text).join("\n") ||
      "";

    if (mode === "screenshot") {
      // response_mime_type guarantees JSON, but never trust it blindly.
      try {
        const j = JSON.parse(text);
        return res.json({
          answer: String(j.answer || "").slice(0, 4000),
          action:
            j.action && j.action.type === "calendar" && j.action.title
              ? {
                  type: "calendar",
                  title: String(j.action.title).slice(0, 200),
                  startIso: String(j.action.startIso || ""),
                  endIso: j.action.endIso ? String(j.action.endIso) : null,
                  location: j.action.location
                    ? String(j.action.location).slice(0, 200)
                    : null,
                }
              : null,
        });
      } catch (_) {
        return res.json({ answer: text.slice(0, 4000), action: null });
      }
    }
    res.json({ answer: text, action: null });
  } catch (e) {
    console.error("vision error:", e.message);
    res.status(500).json({ error: "vision failed" });
  }
});

module.exports = router;
