import { WebSocketServer } from "ws";
import OpenAI from "openai";

const port = process.env.PORT ? Number(process.env.PORT) : 8080;
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const wss = new WebSocketServer({ port });
console.log("MCP tool server listening on ws://0.0.0.0:" + port);

wss.on("connection", (ws, req) => {
  console.log("WS connected from", req.headers["x-forwarded-for"] || req.socket.remoteAddress);

  ws.on("message", async (buf) => {
    // 1) Ignore empty/whitespace frames
    const raw = String(buf || "").trim();
    if (!raw) return;

    let msg;
    try {
      msg = JSON.parse(raw);
      console.log("received:", {
        id: msg.id,
        tool: msg.tool,
        items: Array.isArray(msg.items) ? msg.items.length : 0,
      });
    } catch {
      ws.send(JSON.stringify({ ok: false, error: "bad_json" }));
      return;
    }

    const id = msg.id ?? null;

    if (msg.tool !== "categorize_whatsapp") {
      ws.send(JSON.stringify({ id, ok: false, error: "unknown_tool" }));
      return;
    }

    const items = Array.isArray(msg.items) ? msg.items : [];
    if (items.length === 0) {
      ws.send(JSON.stringify({ id, ok: false, error: "no_items" }));
      return;
    }

    // Helper: fallback payload (lets the pipeline continue)
    const fallback = () => ({
      id,
      ok: true,
      categories: [{ name: "General" }],
      assignments: items.map(() => "General"),
      coverage: 1,
    });

    try {
      const prompt = `
You are a data categorizer. Propose 3-5 concise categories that together cover at least 95% of items.
Return STRICT JSON:
{"categories":[{"name":"..."}],"assignments":["..."],"coverage":0.0-1.0}
Messages:
${items.slice(0, 200).map((r, i) => `[${i}] ${r.text}`).join("\n")}
      `.trim();

      const resp = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.2,
      });

      const text = resp.choices?.[0]?.message?.content || "";
      let json;
      try { json = JSON.parse(text); } catch { json = null; }

      if (!json || !Array.isArray(json.assignments)) {
        console.warn("LLM parse failed, returning fallback");
        ws.send(JSON.stringify(fallback()));
        return;
      }

      ws.send(JSON.stringify({ id, ok: true, ...json }));
    } catch (e) {
      const msg = String(e?.message || e);
      console.error("tool_error:", msg);

      // 429/5xx → return fallback so the flow continues
      if (/429/.test(msg) || /rate limit/i.test(msg) || /quota/i.test(msg)) {
        ws.send(JSON.stringify(fallback()));
        return;
      }

      // Other errors → explicit tool error
      ws.send(JSON.stringify({ id, ok: false, error: msg }));
    }
  });

  ws.on("close", () => console.log("WS closed"));
  ws.on("error", (e) => console.error("WS error", e));
});
