
import express from "express";
import axios from "axios";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import cors from "cors";

dotenv.config();

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: "10mb" }));

async function summarizeMessages(oldMessages) {
  const text = oldMessages
    .map(msg => `${msg.role}: ${msg.content}`)
    .join("\n");

  return text.length > 2000
    ? text.slice(-2000) + "..."
    : text;
}

app.post("/v1/chat/completions", async (req, res) => {
  try {
    const { messages, stream = true } = req.body;

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({
        error: "messages precisa ser um array"
      });
    }

    const lastMessages = messages.slice(-50);
    const oldMessages = messages.slice(0, -50);

    const summary = await summarizeMessages(oldMessages);

    const charPersonality =
      messages.find(m => m.role === "system")?.content || "";

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
      stream: stream
    };

    // STREAMING MODE
    if (stream) {
      const response = await axios.post(
        process.env.NVIDIA_API_URL,
        payload,
        {
          responseType: "stream",
          headers: {
            "Authorization": `Bearer ${process.env.NVIDIA_API_KEY}`,
            "Content-Type": "application/json",
            "Accept": "text/event-stream"
          }
        }
      );

      // Forward SSE headers
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");

      res.flushHeaders();

      // Forward NVIDIA stream directly to Janitor AI
      response.data.on("data", chunk => {
        if (!res.destroyed) {
          res.write(chunk);
        }
      });

      response.data.on("end", () => {
        if (!res.destroyed) {
          res.end();
        }
      });

      response.data.on("error", err => {
        console.error("STREAM ERROR:", err.message);

        if (!res.destroyed) {
          res.end();
        }
      });

      // Stop NVIDIA request if client disconnects
      req.on("close", () => {
        if (!res.writableEnded) {
          response.data.destroy();
        }
      });

      return;
    }

    // NON-STREAMING MODE
    const response = await axios.post(
      process.env.NVIDIA_API_URL,
      payload,
      {
        headers: {
          "Authorization": `Bearer ${process.env.NVIDIA_API_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );

    res.json(response.data);

  } catch (err) {
    console.error(
      "ERRO DA NVIDIA:",
      err.response?.data || err.message
    );

    if (!res.headersSent) {
      res.status(500).json({
        error: "Erro na NVIDIA",
        detalhes: err.response?.data?.body?.detail || err.message
      });
    } else {
      res.end();
    }
  }
});

app.listen(process.env.PORT || 3000, () => {
  console.log(`API rodando na porta ${process.env.PORT || 3000}`);
});


