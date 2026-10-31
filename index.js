
import express from "express";
import axios from "axios";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import cors from "cors";

dotenv.config();

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: "10mb" })); // aumenta limite de payload

// Função simples de resumo de mensagens antigas
async function summarizeMessages(oldMessages) {
  const text = oldMessages.map(msg => `${msg.role}: ${msg.content}`).join("\n");
  // Se for muito grande, cortar mantendo o final
  return text.length > 2000 ? text.slice(-2000) + "..." : text;
}

app.post("/v1/chat/completions", async (req, res) => { try { const { messages } = req.body;

if (!messages || !Array.isArray(messages)) {
  return res.status(400).json({ error: "messages precisa ser um array" });
}

const lastMessages = messages.slice(-50);
const oldMessages = messages.slice(0, -50);
const summary = await summarizeMessages(oldMessages);

const charPersonality = messages.find(m => m.role === 'system')?.content || "";

const payload = {
  model: "deepseek-ai/deepseek-v4.1-flash",
  messages: [
    { role: "system", content: charPersonality },
    { role: "system", content: `Resumo do histórico: ${summary}` },
    ...lastMessages
  ],
  max_tokens: 16384,
  temperature: 0.6,
  top_p: 0.95,
  stream: true
};

const response = await axios.post(
  process.env.NVIDIA_API_URL,
  payload,
  {
    headers: {
      "Authorization": `Bearer ${process.env.NVIDIA_API_KEY}`,
      "Content-Type": "application/json",
      "Accept": "text/event-stream"
    },
    responseType: "stream",
    timeout: 0
  }
);

res.status(200);
res.setHeader("Content-Type", "text/event-stream");
res.setHeader("Cache-Control", "no-cache, no-transform");
res.setHeader("Connection", "keep-alive");
res.setHeader("X-Accel-Buffering", "no");
res.flushHeaders();

let buffer = "";

response.data.on("data", (chunk) => {
  buffer += chunk.toString();

  const lines = buffer.split("\n");
  buffer = lines.pop();

  for (const line of lines) {
    if (!line.startsWith("data:")) continue;

    const data = line.slice(5).trim();

    if (!data || data === "[DONE]") {
      if (data === "[DONE]") {
        res.write("data: [DONE]\n\n");
      }
      continue;
    }

    try {
      const parsed = JSON.parse(data);

      const content = parsed.choices?.[0]?.delta?.content;

      if (content) {
        parsed.choices[0].delta.content = content
          .replace(/<think>[\s\S]*?<\/think>/gi, "")
          .replace(/<\/?think>/gi, "");
      }

      res.write(`data: ${JSON.stringify(parsed)}\n\n`);
    } catch (e) {
      console.error("Erro ao processar chunk:", e.message);
    }
  }
});

response.data.on("end", () => {
  if (buffer.trim().startsWith("data:")) {
    const data = buffer.trim().slice(5).trim();

    if (data && data !== "[DONE]") {
      try {
        const parsed = JSON.parse(data);
        res.write(`data: ${JSON.stringify(parsed)}\n\n`);
      } catch (e) {}
    }
  }

  if (!res.writableEnded) {
    res.end();
  }
});

response.data.on("error", (err) => {
  console.error("Erro no streaming:", err.message);
  if (!res.writableEnded) res.end();
});

req.on("close", () => {
  if (!res.writableEnded) {
    response.data.destroy();
  }
});


} catch (err) { console.error("ERRO DA NVIDIA:", err.response?.data || err.message);

if (!res.headersSent) {
  res.status(500).json({
    error: "Erro na NVIDIA",
    detalhes: err.message
  });
} else {
  res.end();
}


} });

app.listen(process.env.PORT || 3000, () => {
  console.log(`API rodando na porta ${process.env.PORT || 3000}`);
});
