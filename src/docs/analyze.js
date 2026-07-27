/**
 * DOCUMENT ANALYZER — one Gemini multimodal call per saved document.
 * Runs ONCE at upload time; every later recall is a pure DB lookup,
 * so remembering costs one AI call ever, not one per question.
 */
const MODEL = () => process.env.GEMINI_VISION_MODEL || "gemini-2.0-flash";

const PROMPT = `You are filing a document into a personal assistant's memory.
Look at the attached file and reply with STRICT JSON only (no markdown fences):
{"title": "<short human title, e.g. 'Blood test report — City Hospital'>",
 "category": "medical" | "prescription" | "receipt" | "bill" | "id" | "ticket" | "other",
 "doc_date": "<yyyy-mm-dd printed on the document, or empty string>",
 "summary": "<3-6 plain sentences: what this is, key values/amounts, and anything the person must act on (medicines + dosage, follow-up dates, totals, deadlines). Keep the document's language for names.>",
 "tags": ["<5-10 lowercase search keywords: place names, doctor names, test names, illnesses, shops>"]}`;

/**
 * @returns {Promise<object|null>} parsed metadata, or null on any failure —
 * the caller keeps filename-based placeholders so saving NEVER fails just
 * because analysis did.
 */
async function analyzeDocument(buffer, mime) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;
  try {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL()}:generateContent`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": key },
        signal: AbortSignal.timeout(45_000),
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [
                { inline_data: { mime_type: mime, data: buffer.toString("base64") } },
                { text: PROMPT },
              ],
            },
          ],
          generationConfig: {
            response_mime_type: "application/json",
            temperature: 0.2,
          },
        }),
      }
    );
    if (!r.ok) return null;
    const data = await r.json();
    const text =
      data.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || "";
    const j = JSON.parse(text);
    return {
      title: j.title,
      category: j.category,
      docDate: j.doc_date,
      summary: j.summary,
      tags: j.tags,
    };
  } catch (e) {
    console.error("doc analyze failed:", e.message);
    return null;
  }
}

module.exports = { analyzeDocument };
