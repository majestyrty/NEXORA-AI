import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { GoogleGenAI } from "@google/genai";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static("./"));

// Check API Key
if (!process.env.GEMINI_API_KEY) {
    console.error("❌ GEMINI_API_KEY not found in .env");
    process.exit(1);
}

// Initialize Gemini
const ai = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY,
});

// Candidate models to try if a preferred one is unavailable. Order is from preferred to fallback.
const MODEL_CANDIDATES = [
    // newer Interaction-style model identifiers may be required; keep multiple guesses
    'models/gemini-1.5',
    'models/gemini-1.0',
    'gemini-1.5',
    'gemini-1.0',
    'text-bison-001',
    'models/text-bison-001'
];

async function generateWithFallback(message) {
    let lastErr = null;
    for (const model of MODEL_CANDIDATES) {
        try {
            const resp = await ai.models.generateContent({ model, contents: message });
            return resp;
        } catch (err) {
            lastErr = err;
            // If it's a 404 for model, try next candidate; otherwise rethrow
            const code = err && err.status || (err && err.code) || (err && err.error && err.error.code);
            if (code && (code === 404 || code === 'NOT_FOUND')) {
                console.warn(`Model ${model} not available, trying next candidate.`);
                continue;
            }
            // For other errors, throw to allow upstream handling
            throw err;
        }
    }
    // All candidates failed with NOT_FOUND; throw last error to surface details
    throw lastErr || new Error('No model candidates succeeded');
}

// Chat endpoint
app.post("/chat", async (req, res) => {
    try {
        const { message } = req.body;

        if (!message) {
            return res.status(400).json({
                reply: "Please enter a message."
            });
        }

        // Use model fallback helper to attempt a working model
        const response = await generateWithFallback(message);

        // Normalize common Gemini response shapes to extract text safely
        let replyText = "";
        if (response && typeof response === 'string') {
            replyText = response;
        } else if (response && typeof response.text === 'string') {
            replyText = response.text;
        } else if (response && Array.isArray(response.candidates) && response.candidates[0]) {
            // some libs return candidates with content/text
            const cand = response.candidates[0];
            replyText = typeof cand.content === 'string' ? cand.content : (cand.text || JSON.stringify(cand));
        } else if (response && Array.isArray(response.output) && response.output[0]) {
            const out = response.output[0].content || response.output[0];
            if (Array.isArray(out)) {
                replyText = out.map(o => o.text || JSON.stringify(o)).join('\n');
            } else {
                replyText = out.text || JSON.stringify(out);
            }
        } else {
            replyText = String(response || "");
        }

        res.json({ reply: replyText });

    } catch (error) {
        console.error("Gemini Error:", error);

        res.status(500).json({
            reply: "Sorry, an error occurred while contacting Nexora AI."
        });
    }
});

// SSE streaming endpoint
app.get('/stream', async (req, res) => {
    try {
        const message = req.query.message || '';
        if (!message) {
            res.status(400).end();
            return;
        }

        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders && res.flushHeaders();

        // If the client library supports streaming responses, try to use it
        if (ai.responses && typeof ai.responses.stream === 'function') {
            // consume async iterator/stream and forward partials as SSE
            for await (const part of ai.responses.stream({ model: 'gemini-2.0-flash', input: message })) {
                let text = '';
                if (typeof part === 'string') text = part;
                else if (part.outputText) text = part.outputText;
                else if (part.text) text = part.text;
                else if (part.delta) text = part.delta;
                if (text) {
                    res.write(`data: ${JSON.stringify({ type: 'partial', text })}\n\n`);
                }
            }

            res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
            res.end();
            return;
        }

        // Fallback: single non-streaming response and send as one partial then done
        // Try candidate models via helper
        const response = await generateWithFallback(message);

        // normalize response similar to /chat handler
        let replyText = '';
        if (response && typeof response === 'string') {
            replyText = response;
        } else if (response && typeof response.text === 'string') {
            replyText = response.text;
        } else if (response && Array.isArray(response.candidates) && response.candidates[0]) {
            const cand = response.candidates[0];
            replyText = typeof cand.content === 'string' ? cand.content : (cand.text || JSON.stringify(cand));
        } else if (response && Array.isArray(response.output) && response.output[0]) {
            const out = response.output[0].content || response.output[0];
            if (Array.isArray(out)) {
                replyText = out.map(o => o.text || JSON.stringify(o)).join('\n');
            } else {
                replyText = out.text || JSON.stringify(out);
            }
        } else {
            replyText = String(response || '');
        }

        res.write(`data: ${JSON.stringify({ type: 'partial', text: replyText })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
        res.end();

    } catch (err) {
        console.error('Streaming error:', err);
        res.write(`data: ${JSON.stringify({ type: 'error', message: err.message || 'Streaming failed' })}\n\n`);
        res.end();
    }
});

import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(express.static(__dirname));

app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "index.html"));
});
// Start server
app.listen(PORT, () => {
    console.log("=================================");
    console.log("✅ Nexora AI Server Started");
    console.log(`🌐 http://localhost:${PORT}`);
    console.log("=================================");
});