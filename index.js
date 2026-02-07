
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

app.post("/v1/chat/completions", async (req, res) => {
  try {
    const { messages } = req.body;

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: "messages precisa ser um array" });
    }

    const lastMessages = messages.slice(-50);
    const oldMessages = messages.slice(0, -50);
    const summary = await summarizeMessages(oldMessages);

    // Separe a definição do personagem (que não deve ser resumida)
    const charPersonality = messages.find(m => m.role === 'system')?.content || "";
    
    const payload = {
      model: "moonshotai/kimi-k2-thinking",
      messages: [
        { role: "system", content: charPersonality }, // A personalidade SEMPRE inteira aqui
        { role: "system", content: `Resumo do histórico: ${summary}` },
        ...lastMessages
      ],
      max_tokens: 16384, 
      temperature: 0.6,
      top_p: 0.95
    };

    // Pega a resposta da NVIDIA
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

    // 1. Criamos uma cópia dos dados para não dar erro de referência
    let responseData = response.data;

    // 2. Localizamos onde está o texto (normalmente em choices[0].message.content)
    if (responseData.choices && responseData.choices[0]) {
      let message = responseData.choices[0].message;
      let content = message.content || "";

      console.log("--- TEXTO RECEBIDO ---");
      console.log(content.substring(0, 100) + "..."); // Isso vai mostrar no seu terminal se o <think> chegou

      // 3. REMOÇÃO AGRESSIVA:
      // Remove o bloco completo <think>...</think>
      content = content.replace(/<think>[\s\S]*?<\/think>/gi, "");
      
      // Remove tags <think> ou </think> que sobraram sozinhas
      content = content.replace(/<\/?think>/gi, "");
      
      // Remove qualquer coisa que tenha sobrado se o modelo foi cortado no meio do pensamento
      content = content.replace(/^[\s\S]*?<\/think>/gi, ""); 

      // 4. Devolve o texto limpo para o objeto
      responseData.choices[0].message.content = content.trim();
      
      console.log("--- TEXTO LIMPO ---");
      console.log(responseData.choices[0].message.content.substring(0, 100));
    }

    // Envia para o Janitor AI
    res.json(responseData);
  } catch (err) {
    console.error("ERRO DA NVIDIA:", err.response?.data || err.message);
    res.status(500).json({ 
      error: "Erro na NVIDIA", 
      detalhes: err.response?.data?.body?.detail || err.message 
    });
  }
});

app.listen(process.env.PORT || 3000, () => {
  console.log(`API rodando na porta ${process.env.PORT || 3000}`);
});
