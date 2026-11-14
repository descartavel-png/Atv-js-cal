import express from "express";
import axios from "axios";
import dotenv from "dotenv";
import cors from "cors";

dotenv.config();

const app = express();

app.use((req, res, next) => {
    console.log("================================");
    console.log("INCOMING REQUEST");
    console.log("Method:", req.method);
    console.log("Path:", req.originalUrl);
    console.log("Time:", new Date().toISOString());
    console.log("Content-Type:", req.headers["content-type"]);
    console.log("================================");

    next();
});

app.get("/health", (req, res) => {
    console.log("HEALTH CHECK RECEIVED");

    res.status(200).json({
        status: "ok",
        timestamp: new Date().toISOString()
    });
});

app.use(cors());
app.use(express.json({ limit: "10mb" }));

const PORT = process.env.PORT || 3000;

async function summarizeMessages(oldMessages) {
    const text = oldMessages
        .map(msg => `${msg.role}: ${msg.content}`)
        .join("\n");

    return text.length > 2000
        ? text.slice(-2000) + "..."
        : text;
}

app.post("/v1/chat/completions", async (req, res) => {
    const controller = new AbortController();

    let heartbeat;
    let upstream;

    try {
        const { messages, stream = true } = req.body;

        if (!Array.isArray(messages)) {
            return res.status(400).json({
                error: "messages precisa ser um array"
            });
        }

        if (!process.env.NVIDIA_API_URL || !process.env.NVIDIA_API_KEY) {
            return res.status(500).json({
                error: "NVIDIA API configuration missing"
            });
        }

        const systemMessage = messages.find(
            m => m.role === "system"
        )?.content || "";

        const conversation = messages.filter(
            m => m.role !== "system"
        );

        const lastMessages = conversation.slice(-30);
        const oldMessages = conversation.slice(0, -30);

        const summary = await summarizeMessages(oldMessages);

        const payload = {
            model: "deepseek-ai/deepseek-v4.1-flash",

            messages: [
                {
                    role: "system",
                    content: systemMessage
                },
                {
                    role: "system",
                    content: `Resumo do histórico: ${summary}`
                },
                ...lastMessages
            ],

            max_tokens: 16384,
            temperature: 0.6,
            top_p: 0.95,
            stream: stream
        };

        // =================================
        // STREAMING MODE
        // =================================

        if (stream) {

            res.status(200);

            res.setHeader(
                "Content-Type",
                "text/event-stream; charset=utf-8"
            );

            res.setHeader(
                "Cache-Control",
                "no-cache, no-transform"
            );

            res.setHeader(
                "Connection",
                "keep-alive"
            );

            res.setHeader(
                "X-Accel-Buffering",
                "no"
            );

            res.flushHeaders();

            // Send heartbeat to keep connection alive
            heartbeat = setInterval(() => {
    if (!res.destroyed && !res.writableEnded) {
        res.write(": keep-alive\n\n");
    }
}, 10000);

res.write(": connected\n\n");

            // Cancel NVIDIA request if client disconnects
            res.on("close", () => {
                clearInterval(heartbeat);

                if (!res.writableEnded) {
                    controller.abort();
                }
            });

console.log("REQUEST RECEIVED:", new Date().toISOString());

            console.log("NVIDIA REQUEST STARTED:", new Date().toISOString());

upstream = await axios.post(
    process.env.NVIDIA_API_URL,
    payload,
    {
        responseType: "stream",
        timeout: 180000,
        signal: controller.signal,
        headers: {
            Authorization: `Bearer ${process.env.NVIDIA_API_KEY}`,
            "Content-Type": "application/json",
            Accept: "text/event-stream"
        }
    }
);

            console.log("NVIDIA CONNECTION ESTABLISHED:", new Date().toISOString());

console.log("NVIDIA STATUS:", upstream.status);

console.log(
    "NVIDIA CONTENT TYPE:",
    upstream.headers["content-type"]
);

console.log("NVIDIA CONNECTED:", new Date().toISOString());

let firstChunk = true;

upstream.data.on("data", chunk => {

    if (firstChunk) {
        console.log("FIRST NVIDIA CHUNK:", new Date().toISOString());
        firstChunk = false;
    }

    if (!res.destroyed && !res.writableEnded) {
        res.write(chunk);
    }
});
            upstream.data.on("end", () => {
                clearInterval(heartbeat);

                if (!res.destroyed && !res.writableEnded) {
                    res.end();
                }
            });

            upstream.data.on("error", err => {
                console.error("NVIDIA STREAM ERROR:", err.message);

                clearInterval(heartbeat);

                if (!res.destroyed && !res.writableEnded) {
                    res.end();
                }
            });

            return;
        }

        // =================================
        // NON-STREAMING MODE
        // =================================

        const response = await axios.post(
            process.env.NVIDIA_API_URL,
            payload,
            {
                timeout: 3600000,

                headers: {
                    Authorization: `Bearer ${process.env.NVIDIA_API_KEY}`,
                    "Content-Type": "application/json"
                }
            }
        );

        return res.status(200).json(response.data);

    } catch (err) {

        clearInterval(heartbeat);

        if (err.response) {
            console.error(
                "NVIDIA STATUS:",
                err.response.status
            );

            console.error(
                "NVIDIA ERROR:",
                err.message
            );
        } else {
            console.error(
                "SERVER ERROR:",
                err.message
            );
        }

        if (!res.headersSent) {
            return res.status(
                err.response?.status || 500
            ).json({
                error: "NVIDIA API Error",
                details: err.message
            });
        }

        if (!res.destroyed && !res.writableEnded) {
            res.end();
        }
    }
});

// =================================
// START SERVER
// =================================

app.listen(PORT, "0.0.0.0", () => {
    console.log(`API running on port ${PORT}`);
});
