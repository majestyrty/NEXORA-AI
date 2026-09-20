import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import multer from "multer";
import mammoth from "mammoth";
import { PDFParse } from "pdf-parse";
import XLSX from "xlsx";
import { fileTypeFromBuffer } from "file-type";
import { GoogleGenAI } from "@google/genai";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MAX_FILE_SIZE = 10 * 1024 * 1024;
const MAX_FILES = 5;

const AVAILABLE_MODELS = {
    "gemini-3.6-flash": "models/gemini-3.6-flash",
    "gemini-3.6-pro": "models/gemini-3.6-pro"
};
const ALLOWED_TYPES = new Map([
    ["application/pdf", "pdf"], ["text/plain", "text"], ["text/csv", "csv"],
    ["application/msword", "doc"], ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "docx"],
    ["application/vnd.ms-excel", "xlsx"], ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "xlsx"],
    ["image/jpeg", "image"], ["image/png", "image"], ["image/webp", "image"]
]);

if (!process.env.GEMINI_API_KEY) {
    console.error("GEMINI_API_KEY not found in .env");
    process.exit(1);
}

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_FILE_SIZE, files: MAX_FILES }
});

app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.static(__dirname));

function modelFor(requested) {
    if (!requested) return AVAILABLE_MODELS["gemini-3.6-flash"];
    return AVAILABLE_MODELS[requested] || null;
}

function friendlyError(error) {
    const message = String(error?.message || "");
    if (/404|model/i.test(message)) return "Nexora AI couldn't use this model. Please select another available model.";
    return "Nexora AI is having trouble connecting. Please check your connection and try again.";
}

async function extractFile(file) {
    const detected = await fileTypeFromBuffer(file.buffer);
    const type = ALLOWED_TYPES.get(file.mimetype) || ALLOWED_TYPES.get(detected?.mime);
    if (!type) throw new Error(`Unsupported file type: ${file.originalname}`);
    if (type === "image") {
        return { name: file.originalname, kind: "image", mimeType: detected?.mime || file.mimetype, data: file.buffer.toString("base64") };
    }
    try {
        if (type === "pdf") {
            const parser = new PDFParse({ data: file.buffer });
            const result = await parser.getText();
            await parser.destroy();
            return { name: file.originalname, kind: "text", text: result.text };
        }
        if (type === "docx") return { name: file.originalname, kind: "text", text: (await mammoth.extractRawText({ buffer: file.buffer })).value };
        if (type === "xlsx") {
            const workbook = XLSX.read(file.buffer, { type: "buffer" });
            const text = workbook.SheetNames.map((sheet) => `Sheet: ${sheet}\n${XLSX.utils.sheet_to_csv(workbook.Sheets[sheet])}`).join("\n\n");
            return { name: file.originalname, kind: "text", text };
        }
        return { name: file.originalname, kind: "text", text: file.buffer.toString("utf8") };
    } catch (error) {
        console.error(`Unable to read ${file.originalname}:`, error);
        throw new Error(`Unable to read document: ${file.originalname}`);
    }
}

function buildContents(message, files, responseStyle = "Balanced") {
    const parts = [{
        text: `You are Nexora AI. Answer clearly and helpfully. If this is a problem, show the key reasoning steps and a final answer. Response style: ${responseStyle}.\n\nUser question:\n${message || "Please analyze the uploaded files."}`
    }];
    for (const file of files) {
        if (file.kind === "image") parts.push({ inlineData: { mimeType: file.mimeType, data: file.data } });
        else parts.push({ text: `\n\nUploaded file: ${file.name}\n${file.text.slice(0, 120000)}` });
    }
    return [{ role: "user", parts }];
}

async function generateResponse(message, model, files = [], responseStyle) {
    const response = await ai.models.generateContent({ model, contents: buildContents(message, files, responseStyle) });
    return response.text || "Sorry, I couldn't generate a response.";
}

app.post("/chat", upload.array("attachments", MAX_FILES), async (req, res) => {
    try {
        const message = typeof req.body.message === "string" ? req.body.message : "";
        if (!message.trim() && !req.files?.length) return res.status(400).json({ reply: "Please enter a message or attach a file." });
        const selectedModel = modelFor(req.body.model);
        if (!selectedModel) return res.status(400).json({ reply: "Nexora AI couldn't use this model. Please select another available model." });
        const files = await Promise.all((req.files || []).map(extractFile));
        const reply = await generateResponse(message, selectedModel, files, req.body.responseStyle);
        res.json({ reply });
    } catch (error) {
        console.error("Gemini/file processing error:", error);
        const status = /Unsupported|Unable to read|File too large/i.test(error.message) ? 400 : 500;
        res.status(status).json({ reply: status === 400 ? "I couldn't read that file. Please try another supported file." : friendlyError(error) });
    }
});

app.get("/stream", async (req, res) => {
    const message = typeof req.query.message === "string" ? req.query.message : "";
    if (!message.trim()) return res.status(400).end();
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    try {
        const selectedModel = modelFor(req.query.model);
        if (!selectedModel) {
            res.write(`data: ${JSON.stringify({ type: "error", message: "Nexora AI couldn't use this model. Please select another available model." })}\n\n`);
            return res.end();
        }
        const stream = await ai.models.generateContentStream({ model: selectedModel, contents: buildContents(message, [], req.query.responseStyle) });
        for await (const chunk of stream) {
            if (chunk.text) res.write(`data: ${JSON.stringify({ type: "partial", text: chunk.text })}\n\n`);
        }
        res.write(`data: ${JSON.stringify({ type: "done" })}\n\n`);
    } catch (error) {
        console.error("Streaming error:", error);
        res.write(`data: ${JSON.stringify({ type: "error", message: friendlyError(error) })}\n\n`);
    } finally {
        res.end();
    }
});

app.get("/config", (req, res) => res.json({ models: Object.keys(AVAILABLE_MODELS), maxFileSize: MAX_FILE_SIZE, maxFiles: MAX_FILES, fileTypes: [...ALLOWED_TYPES.values()] }));
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));
app.use((error, req, res, next) => {
    if (error?.code === "LIMIT_FILE_SIZE") return res.status(400).json({ reply: "File is too large. Maximum supported size is 10 MB." });
    if (error?.code === "LIMIT_FILE_COUNT" || error?.code === "LIMIT_UNEXPECTED_FILE") return res.status(400).json({ reply: "You can attach up to 5 supported files." });
    if (error) {
        console.error("Request validation error:", error);
        return res.status(400).json({ reply: "I couldn't read that file. Please try another supported file." });
    }
    return next();
});
app.listen(PORT, () => console.log(`NEXORA AI running at http://localhost:${PORT}`));
