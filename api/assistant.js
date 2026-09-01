// Serverless AI proxy (Vercel). Keeps the provider key on the server.
// Works with any OpenAI-compatible endpoint (Groq, Gemini, OpenRouter, DeepSeek...).
export default async function handler(req, res) {
  if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }
  const base = process.env.AI_BASE_URL, key = process.env.AI_API_KEY, model = process.env.AI_MODEL;
  if (!base || !key || !model) { res.status(500).json({ error: "AI not configured (set AI_BASE_URL, AI_API_KEY, AI_MODEL)" }); return; }
  try {
    let body = req.body;
    if (typeof body === "string") body = JSON.parse(body || "{}");
    const { system, messages = [] } = body || {};
    const r = await fetch(`${base.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model, max_tokens: 1000, temperature: 0.2,
        messages: [{ role: "system", content: system || "" }, ...messages],
      }),
    });
    const data = await r.json();
    if (!r.ok) { res.status(502).json({ error: data.error?.message || "Provider error" }); return; }
    const text = data.choices?.[0]?.message?.content || "";
    res.status(200).json({ text });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}
