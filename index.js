
import express from "express";
import axios from "axios";
import dotenv from "dotenv";
import cors from "cors";
import { pipeline } from "node:stream";

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json({ limit: "10mb" }));

const PORT = process.env.PORT || 3000;

app.get("/health", (req, res) => {
    res.json({ status: "ok" });
});

app.post("/v1/chat/completions", async (req, res) => {
    const controller = new AbortController();

    let heartbeat;
    let upstream;
    let disconnected = false;

    try {
        const { messages, stream = true } = req.body;

        if (!Array.isArray(messages)) {
            return res.status(400).json({
                error: {
                    message: "messages must be an array",
                    type: "invalid_request_error"
                }
            });
        }

        if (!process.env.NVIDIA_API_URL ||
            !process.env.NVIDIA_API_KEY) {
            return res.status(500).json({
                error: {
                    message: "NVIDIA API configuration missing",
                    type: "server_error"
                }
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

        const summary = oldMessages
            .map(m => `${m.role}: ${m.content}`)
            .join("\n")
            .slice(-2000);

        const payload = {
            model: "deepseek-ai/deepseek-v4.1-flash",
            messages: [
                {
                    role: "system",
                    content: systemMessage
                },
                ...(summary ? [{
                    role: "system",
                    content: `Previous conversation summary:\n${summary}`
                }] : []),
                ...lastMessages
            ],
            max_tokens: 16384,
            temperature: 0.6,
            top_p: 0.95,
            stream: Boolean(stream)
        };

        req.on("aborted", () => {
            disconnected = true;
            controller.abort();
        });

        res.on("close", () => {
            if (!res.writableEnded) {
                disconnected = true;
                controller.abort();
            }

            clearInterval(heartbeat);
        });

        // STREAMING
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

            // Initial SSE comment
            res.write(": connected\n\n");

            heartbeat = setInterval(() => {
                if (!res.destroyed && !res.writableEnded) {
                    res.write(": keep-alive\n\n");
                }
            }, 10000);

            console.log("NVIDIA STREAM REQUEST STARTED");

            upstream = await axios.post(
                process.env.NVIDIA_API_URL,
                payload,
                {
                    responseType: "stream",
                    timeout: 3600000,
                    signal: controller.signal,
                    headers: {
                        Authorization:
                            `Bearer ${process.env.NVIDIA_API_KEY}`,
                        "Content-Type": "application/json",
                        Accept: "text/event-stream"
                    }
                }
            );

            if (disconnected) {
                upstream.data.destroy();
                return;
            }

            console.log("NVIDIA STREAM CONNECTED");

            const contentType =
                upstream.headers["content-type"] || "";

            if (!contentType.includes("text/event-stream")) {
                console.error(
                    "Unexpected NVIDIA content type:",
                    contentType
                );
            }

            // Forward upstream SSE with backpressure
            pipeline(upstream.data, res, err => {
                clearInterval(heartbeat);

                if (err) {
                    console.error(
                        "STREAM PIPELINE ERROR:",
                        err.message
                    );

                    if (!res.destroyed) {
                        res.destroy();
                    }
                } else {
                    console.log("STREAM FINISHED");
                }
            });

            return;
        }

        // NON-STREAMING
        const response = await axios.post(
            process.env.NVIDIA_API_URL,
            payload,
            {
                timeout: 3600000,
                signal: controller.signal,
                headers: {
                    Authorization:
                        `Bearer ${process.env.NVIDIA_API_KEY}`,
                    "Content-Type": "application/json"
                }
            }
        );

        return res.status(200).json(response.data);

    } catch (err) {
        clearInterval(heartbeat);

        console.error(
            "API ERROR:",
            err.response?.status || "",
            err.message
        );

        if (upstream?.data) {
            upstream.data.destroy();
        }

        if (!res.headersSent) {
            return res.status(
                err.response?.status || 502
            ).json({
                error: {
                    message:
                        err.response?.data?.error?.message ||
                        err.message ||
                        "NVIDIA API error",
                    type: "upstream_error"
                }
            });
        }

        if (!res.destroyed && !res.writableEnded) {
            res.end();
        }
    }
});

app.listen(PORT, "0.0.0.0", () => {
    console.log(`API running on port ${PORT}`);
});
