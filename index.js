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
  const text = oldMessages.map(msg => `${msg.role}: ${msg.content}`).join("\n");
  return text.length > 2000 ? text.slice(-2000) + "..." : text;
}

app.post("/v1/chat/completions", async (req, res) => {
  try {
    const { messages } = req.body;

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
      max_tokens: 16384, // Você pode manter o limite alto agora com segurança!
      temperature: 0.6,
      top_p: 0.95,
      stream: true // <--- ATIVA O STREAMING NA API
    };

    // Configura os headers para Server-Sent Events (SSE)
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    // Faz a requisição para a NVIDIA esperando um stream de dados
    const response = await axios.post(
      process.env.NVIDIA_API_URL,
      payload,
      {
        headers: {
          "Authorization": `Bearer ${process.env.NVIDIA_API_KEY}`,
          "Content-Type": "application/json"
        },
        responseType: "stream" // <--- TRATA A RESPOSTA COMO UM FLUXO DE DADOS
      }
    );

    // Repassa os pedaços (chunks) recebidos da NVIDIA diretamente para o Janitor AI
    response.data.on("data", (chunk) => {
      // Opcional: Se quiser filtrar as tags <think> em tempo real, você pode tratá-las aqui.
      // Por segurança e compatibilidade com o formato OpenAI/Janitor, repassamos o stream bruto:
      res.write(chunk);
    });

    response.data.on("end", () => {
      res.end();
    });

    response.data.on("error", (err) => {
      console.error("Erro no stream da NVIDIA:", err);
      res.end();
    });

  } catch (err) {
    console.error("ERRO DA NVIDIA:", err.response?.data || err.message);
    if (!res.headersSent) {
      res.status(500).json({ 
        error: "Erro na NVIDIA", 
        detalhes: err.message 
      });
    }
  }
});

app.listen(process.env.PORT || 3000, () => {
  console.log(`API rodando na porta ${process.env.PORT || 3000}`);
});
