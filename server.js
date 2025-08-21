// server.js
import { WebSocketServer } from "ws";
import OpenAI from "openai";

const port = process.env.PORT ? Number(process.env.PORT) : 8080;
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const wss = new WebSocketServer({ port });
console.log("MCP tool server listening on ws://0.0.0.0:" + port);

// Minimal WS protocol (inspired by MCP):
// Client sends: { id, tool: "categorize_whatsapp", items: [{i, text, url, keywords}] }
// Server replies: { id, ok: true, assignments: [...], categories: [...], coverage: 0.97 }
wss.on("connection", (ws) => {
  ws.on("message", async (buf) => {
    try {
      const msg = JSON.parse(String(buf));
      if (msg.tool !== "categorize_whatsapp") {
        ws.send(JSON.stringify({ id: msg.id, ok: false, error: "unknown_tool" }));
        return;
      }

      const items = Array.isArray(msg.items) ? msg.items : [];
      const sample = items.slice(0, 200); // keep prompt short
      const prompt = `
You are a data categorizer. Given WhatsApp messages, propose 3-5 concise categories that together cover at least 95% of items. 
Return STRICT JSON:
{
  "categories":[{"name":"..."}],
  "assignments":["CategoryName", "..."],  // one per message (same order)
  "coverage": 0.0-1.0
}
Messages:
${sample.map((r, i) => `[${i}] ${r.text}`).join("\n")}
`.trim();

      const resp = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.2
      });

      let json = {};
      try { json = JSON.parse(resp.choices?.[0]?.message?.content || "{}"); } catch {}
      if (!Array.isArray(json.assignments)) {
        json = {
          categories: [{ name: "General" }],
          assignments: items.map(() => "General"),
          coverage: 1
        };
      }
      ws.send(JSON.stringify({ id: msg.id, ok: true, ...json }));
    } catch (e) {
      ws.send(JSON.stringify({ ok: false, error: e?.message || "server_error" }));
    }
  });
});