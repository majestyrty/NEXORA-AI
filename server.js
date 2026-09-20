import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import session from "express-session";
import createMemoryStore from "memorystore";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import multer from "multer";
import mammoth from "mammoth";
import { PDFParse } from "pdf-parse";
import ExcelJS from "exceljs";
import { fileTypeFromBuffer } from "file-type";
import { GoogleGenAI } from "@google/genai";
import OpenAI from "openai";
import { OAuth2Client } from "google-auth-library";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MAX_FILE_SIZE = 100 * 1024 * 1024;
const MAX_FILES = 5;
const SESSION_MAX_AGE = 7 * 24 * 60 * 60 * 1000;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const SESSION_SECRET = process.env.SESSION_SECRET || "";
const googleClient = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;
const SessionStore = createMemoryStore(session);

/*
|--------------------------------------------------------------------------
| MODELS
|--------------------------------------------------------------------------
*/

const GEMINI_MODELS = {
    "gemini-3.6-flash": "gemini-3.6-flash",
    "gemini-3.1-pro": "gemini-3.1-pro-preview"
};

const OPENAI_MODELS = {
    "gpt-5.6": "gpt-5.6",
    "gpt-5.6-sol": "gpt-5.6-sol",
    "gpt-5.6-terra": "gpt-5.6-terra",
    "gpt-5.6-luna": "gpt-5.6-luna"
};

/*
|--------------------------------------------------------------------------
| FILE TYPES
|--------------------------------------------------------------------------
*/

const ALLOWED_TYPES = new Map([
    ["application/pdf", "pdf"],
    ["text/plain", "text"],
    ["text/csv", "csv"],
    ["application/msword", "doc"],
    [
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "docx"
    ],
    ["application/vnd.ms-excel", "xlsx"],
    [
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "xlsx"
    ],
    ["image/jpeg", "image"],
    ["image/png", "image"],
    ["image/webp", "image"]
]);

/*
|--------------------------------------------------------------------------
| API CLIENTS
|--------------------------------------------------------------------------
*/

if (!process.env.GEMINI_API_KEY) {
    console.warn("GEMINI_API_KEY not found in .env");
}

if (!process.env.OPENAI_API_KEY) {
    console.warn("OPENAI_API_KEY not found in .env");
}

const gemini = process.env.GEMINI_API_KEY
    ? new GoogleGenAI({
          apiKey: process.env.GEMINI_API_KEY
      })
    : null;

const openai = process.env.OPENAI_API_KEY
    ? new OpenAI({
          apiKey: process.env.OPENAI_API_KEY
      })
    : null;

/*
|--------------------------------------------------------------------------
| MIDDLEWARE
|--------------------------------------------------------------------------
*/

const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: MAX_FILE_SIZE,
        files: MAX_FILES
    }
});

app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.set("trust proxy", 1);
app.use(session({
    name: "nexora.sid",
    secret: SESSION_SECRET || "development-session-secret-change-me",
    store: new SessionStore({ checkPeriod: 86400000 }),
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        maxAge: SESSION_MAX_AGE
    }
}));
app.use(express.static(__dirname));

if (!GOOGLE_CLIENT_ID) {
    console.warn("GOOGLE_CLIENT_ID is not configured. Google sign-in is unavailable.");
}
if (!SESSION_SECRET) {
    console.warn("SESSION_SECRET is not configured. Set it before production use.");
}

function requireAuth(req, res, next) {
    if (req.session.user) return next();
    return res.status(401).json({ error: "NOT_AUTHENTICATED", message: "Please sign in to continue." });
}

/*
|--------------------------------------------------------------------------
| MODEL HELPERS
|--------------------------------------------------------------------------
*/

function getProvider(requested) {
    return requested === "openai" || requested === "gemini" ? requested : null;
}

function getModel(provider, requestedModel) {
    if (!provider || !requestedModel) return null;
    return provider === "openai" ? OPENAI_MODELS[requestedModel] || null : GEMINI_MODELS[requestedModel] || null;
}

/*
|--------------------------------------------------------------------------
| FRIENDLY ERRORS
|--------------------------------------------------------------------------
*/

function friendlyError(error) {
    const message = String(error?.message || "");

    if (/404|not found|model/i.test(message)) {
        return "Nexora AI couldn't use this model. Please select another available model.";
    }

    if (/401|unauthorized|api key/i.test(message)) {
        return "Nexora AI API authentication failed. Please check your API key.";
    }

    if (/429|rate limit|quota/i.test(message)) {
        return "Nexora AI has reached the provider's current usage limit. Please try again later.";
    }

    return "Nexora AI is having trouble connecting. Please check your connection and try again.";
}

/*
|--------------------------------------------------------------------------
| FILE EXTRACTION
|--------------------------------------------------------------------------
*/

async function extractFile(file) {
    const detected = await fileTypeFromBuffer(file.buffer);

    const type =
        ALLOWED_TYPES.get(file.mimetype) ||
        ALLOWED_TYPES.get(detected?.mime);

    if (!type) {
        throw new Error(`Unsupported file type: ${file.originalname}`);
    }

    /*
    |----------------------------------------------------------------------
    | Images
    |----------------------------------------------------------------------
    */

    if (type === "image") {
        return {
            name: file.originalname,
            kind: "image",
            mimeType: detected?.mime || file.mimetype,
            data: file.buffer.toString("base64")
        };
    }

    try {
        /*
        |------------------------------------------------------------------
        | PDF
        |------------------------------------------------------------------
        */

        if (type === "pdf") {
            const parser = new PDFParse({
                data: file.buffer
            });

            const result = await parser.getText();

            await parser.destroy();

            return {
                name: file.originalname,
                kind: "text",
                text: result.text
            };
        }

        /*
        |------------------------------------------------------------------
        | DOCX
        |------------------------------------------------------------------
        */

        if (type === "docx") {
            const result = await mammoth.extractRawText({
                buffer: file.buffer
            });

            return {
                name: file.originalname,
                kind: "text",
                text: result.value
            };
        }

        /*
        |------------------------------------------------------------------
        | XLSX
        |------------------------------------------------------------------
        */

       if (type === "xlsx") {
    const workbook = new ExcelJS.Workbook();

    await workbook.xlsx.load(file.buffer);

    const sheets = [];

    workbook.eachWorksheet((worksheet) => {
        const rows = [];

        worksheet.eachRow((row) => {
            const values = row.values
                .slice(1)
                .map((value) => {
                    if (value === null || value === undefined) {
                        return "";
                    }

                    if (typeof value === "object") {
                        if (value.text) return value.text;
                        if (value.result !== undefined) {
                            return value.result;
                        }
                        return JSON.stringify(value);
                    }

                    return String(value);
                });

            rows.push(values.join(","));
        });

        sheets.push(
            `Sheet: ${worksheet.name}\n${rows.join("\n")}`
        );
    });

    return {
        name: file.originalname,
        kind: "text",
        text: sheets.join("\n\n")
    };
}

        /*
        |------------------------------------------------------------------
        | TXT / CSV
        |------------------------------------------------------------------
        */

        return {
            name: file.originalname,
            kind: "text",
            text: file.buffer.toString("utf8")
        };
    } catch (error) {
        console.error(
            `Unable to read ${file.originalname}:`,
            error
        );

        throw new Error(
            `Unable to read document: ${file.originalname}`
        );
    }
}

/*
|--------------------------------------------------------------------------
| PROMPT
|--------------------------------------------------------------------------
*/

function buildPrompt(message, files, responseStyle = "Balanced") {
    let prompt = `
You are Nexora AI.

Answer clearly, accurately and helpfully.

If the user asks a school or technical problem:
- Explain the important reasoning.
- Show the necessary steps.
- Give the final answer clearly.

Response style: ${responseStyle}.

User question:
${message || "Please analyze the uploaded files."}
`;

    for (const file of files) {
        if (file.kind === "text") {
            prompt += `

Uploaded file: ${file.name}

${file.text.slice(0, 120000)}
`;
        }
    }

    return prompt;
}

/*
|--------------------------------------------------------------------------
| GEMINI CONTENT
|--------------------------------------------------------------------------
*/

function buildGeminiContents(
    message,
    files,
    responseStyle = "Balanced"
) {
    const parts = [
        {
            text: buildPrompt(
                message,
                files,
                responseStyle
            )
        }
    ];

    for (const file of files) {
        if (file.kind === "image") {
            parts.push({
                inlineData: {
                    mimeType: file.mimeType,
                    data: file.data
                }
            });
        }
    }

    return [
        {
            role: "user",
            parts
        }
    ];
}

/*
|--------------------------------------------------------------------------
| OPENAI INPUT
|--------------------------------------------------------------------------
*/

function buildOpenAIInput(
    message,
    files,
    responseStyle = "Balanced"
) {
    const content = [
        {
            type: "input_text",
            text: buildPrompt(
                message,
                files,
                responseStyle
            )
        }
    ];

    for (const file of files) {
        /*
        |------------------------------------------------------------------
        | Images
        |------------------------------------------------------------------
        */

        if (file.kind === "image") {
            content.push({
                type: "input_image",
                image_url: `data:${file.mimeType};base64,${file.data}`
            });
        }
    }

    return [
        {
            role: "user",
            content
        }
    ];
}

/*
|--------------------------------------------------------------------------
| GEMINI GENERATION
|--------------------------------------------------------------------------
*/

async function generateGeminiResponse(
    message,
    model,
    files,
    responseStyle
) {
    if (!gemini) {
        throw new Error("GEMINI_API_KEY is not configured.");
    }

    const response = await gemini.models.generateContent({
        model,
        contents: buildGeminiContents(
            message,
            files,
            responseStyle
        )
    });

    return (
        response.text ||
        "Sorry, I couldn't generate a response."
    );
}

/*
|--------------------------------------------------------------------------
| OPENAI GENERATION
|--------------------------------------------------------------------------
*/

async function generateOpenAIResponse(
    message,
    model,
    files,
    responseStyle
) {
    if (!openai) {
        throw new Error("OPENAI_API_KEY is not configured.");
    }

    const response = await openai.responses.create({
        model,
        input: buildOpenAIInput(
            message,
            files,
            responseStyle
        )
    });

    return (
        response.output_text ||
        "Sorry, I couldn't generate a response."
    );
}

/*
|--------------------------------------------------------------------------
| MAIN GENERATION ROUTER
|--------------------------------------------------------------------------
*/

async function generateResponse(
    provider,
    message,
    model,
    files = [],
    responseStyle
) {
    if (provider === "openai") {
        return generateOpenAIResponse(
            message,
            model,
            files,
            responseStyle
        );
    }

    return generateGeminiResponse(
        message,
        model,
        files,
        responseStyle
    );
}

/*
|--------------------------------------------------------------------------
| AUTHENTICATION
|--------------------------------------------------------------------------
| In Google Cloud Console, authorize http://localhost:3000 as an
| authorized JavaScript origin for local development.
*/
app.post("/auth/google", async (req, res) => {
    try {
        if (!googleClient || !GOOGLE_CLIENT_ID) {
            return res.status(503).json({ message: "Google sign-in is not configured on the server." });
        }
        const credential = typeof req.body?.credential === "string" ? req.body.credential : "";
        if (!credential) return res.status(400).json({ message: "Google authentication credential is missing." });
        const ticket = await googleClient.verifyIdToken({ idToken: credential, audience: GOOGLE_CLIENT_ID });
        const payload = ticket.getPayload();
        if (!payload?.sub || !payload.email) return res.status(401).json({ message: "Google authentication could not be verified." });
        req.session.user = {
            sub: payload.sub,
            name: payload.name || payload.email.split("@")[0],
            email: payload.email,
            picture: payload.picture || ""
        };
        return req.session.save((error) => {
            if (error) {
                console.error("Session creation error:", error);
                return res.status(500).json({ message: "Unable to create your session. Please try again." });
            }
            return res.json({ user: req.session.user });
        });
    } catch (error) {
        console.error("Google authentication error:", error.message);
        return res.status(401).json({ message: "Google authentication failed. Please try again." });
    }
});

app.post("/auth/guest", (req, res) => {
    req.session.user = {
        sub: `guest:${crypto.randomUUID()}`,
        name: "Guest user",
        email: "",
        picture: "",
        isGuest: true
    };
    return req.session.save((error) => {
        if (error) {
            console.error("Guest session creation error:", error);
            return res.status(500).json({ message: "Unable to start a guest session. Please try again." });
        }
        return res.json({ user: req.session.user });
    });
});

app.get("/auth/me", (req, res) => {
    if (!req.session.user) return res.status(401).json({ authenticated: false });
    return res.json({ authenticated: true, user: req.session.user });
});

app.post("/auth/logout", (req, res) => {
    req.session.destroy((error) => {
        if (error) {
            console.error("Session destruction error:", error);
            return res.status(500).json({ message: "Unable to sign you out. Please try again." });
        }
        res.clearCookie("nexora.sid", { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production" });
        return res.json({ authenticated: false });
    });
});

/*
|--------------------------------------------------------------------------
| CHAT
|--------------------------------------------------------------------------
*/

app.post(
    "/chat",
    requireAuth,
    upload.array("attachments", MAX_FILES),
    async (req, res) => {
        try {
            const message =
                typeof req.body.message === "string"
                    ? req.body.message
                    : "";

            if (
                !message.trim() &&
                !req.files?.length
            ) {
                return res.status(400).json({
                    reply:
                        "Please enter a message or attach a file."
                });
            }

            const provider = getProvider(
                req.body.provider
            );

            const model = getModel(
                provider,
                req.body.model
            );
            if (!provider || !model) return res.status(400).json({ reply: "Nexora AI couldn't use this provider or model. Please select an available option." });

            const files = await Promise.all(
                (req.files || []).map(extractFile)
            );

            const reply = await generateResponse(
                provider,
                message,
                model,
                files,
                req.body.responseStyle
            );

            res.json({
                reply,
                provider,
                model
            });
        } catch (error) {
            console.error(
                "AI/file processing error:",
                error
            );

            const status =
                /Unsupported|Unable to read|File too large/i.test(
                    error.message
                )
                    ? 400
                    : 500;

            res.status(status).json({
                reply:
                    status === 400
                        ? "I couldn't read that file. Please try another supported file."
                        : friendlyError(error)
            });
        }
    }
);

/*
|--------------------------------------------------------------------------
| STREAMING
|--------------------------------------------------------------------------
*/

app.get("/stream", requireAuth, async (req, res) => {
    const message =
        typeof req.query.message === "string"
            ? req.query.message
            : "";

    if (!message.trim()) {
        return res.status(400).end();
    }

    res.setHeader(
        "Content-Type",
        "text/event-stream"
    );

    res.setHeader(
        "Cache-Control",
        "no-cache"
    );

    res.setHeader(
        "Connection",
        "keep-alive"
    );

    try {
        const provider = getProvider(
            req.query.provider
        );

        const model = getModel(
            provider,
            req.query.model
        );
        if (!provider || !model) {
            res.write(`data: ${JSON.stringify({ type: "error", message: "Nexora AI couldn't use this provider or model. Please select an available option." })}\n\n`);
            return res.end();
        }

        /*
        |------------------------------------------------------------------
        | OPENAI STREAM
        |------------------------------------------------------------------
        */

        if (provider === "openai") {
            if (!openai) {
                throw new Error(
                    "OPENAI_API_KEY is not configured."
                );
            }

            const stream =
                await openai.responses.create({
                    model,
                    input: buildOpenAIInput(
                        message,
                        [],
                        req.query.responseStyle
                    ),
                    stream: true
                });

            for await (const event of stream) {
                if (
                    event.type ===
                    "response.output_text.delta"
                ) {
                    res.write(
                        `data: ${JSON.stringify({
                            type: "partial",
                            text: event.delta
                        })}\n\n`
                    );
                }
            }

            res.write(
                `data: ${JSON.stringify({
                    type: "done"
                })}\n\n`
            );

            return res.end();
        }

        /*
        |------------------------------------------------------------------
        | GEMINI STREAM
        |------------------------------------------------------------------
        */

        if (!gemini) {
            throw new Error(
                "GEMINI_API_KEY is not configured."
            );
        }

        const stream =
            await gemini.models.generateContentStream({
                model,
                contents: buildGeminiContents(
                    message,
                    [],
                    req.query.responseStyle
                )
            });

        for await (const chunk of stream) {
            if (chunk.text) {
                res.write(
                    `data: ${JSON.stringify({
                        type: "partial",
                        text: chunk.text
                    })}\n\n`
                );
            }
        }

        res.write(
            `data: ${JSON.stringify({
                type: "done"
            })}\n\n`
        );
    } catch (error) {
        console.error(
            "Streaming error:",
            error
        );

        res.write(
            `data: ${JSON.stringify({
                type: "error",
                message: friendlyError(error)
            })}\n\n`
        );
    } finally {
        res.end();
    }
});

/*
|--------------------------------------------------------------------------
| FRONTEND CONFIG
|--------------------------------------------------------------------------
*/

app.get("/config", (req, res) => {
    res.json({
        googleClientId: GOOGLE_CLIENT_ID,
        providers: {
            gemini: {
                name: "Google Gemini",
                models: Object.keys(
                    GEMINI_MODELS
                )
            },

            openai: {
                name: "OpenAI",
                models: Object.keys(
                    OPENAI_MODELS
                )
            }
        },

        maxFileSize: MAX_FILE_SIZE,
        maxFiles: MAX_FILES,

        fileTypes: [
            ...new Set(
                ALLOWED_TYPES.values()
            )
        ]
    });
});

/*
|--------------------------------------------------------------------------
| HOME
|--------------------------------------------------------------------------
*/

app.get("/", (req, res) => {
    res.sendFile(
        path.join(
            __dirname,
            "index.html"
        )
    );
});

/*
|--------------------------------------------------------------------------
| ERROR HANDLER
|--------------------------------------------------------------------------
*/

app.use(
    (
        error,
        req,
        res,
        next
    ) => {
        if (
            error?.code ===
            "LIMIT_FILE_SIZE"
        ) {
            return res.status(400).json({
                reply:
                    "File is too large. Maximum supported size is 100 MB."
            });
        }

        if (
            error?.code ===
                "LIMIT_FILE_COUNT" ||
            error?.code ===
                "LIMIT_UNEXPECTED_FILE"
        ) {
            return res.status(400).json({
                reply:
                    "You can attach up to 5 supported files."
            });
        }

        if (error) {
            console.error(
                "Request validation error:",
                error
            );

            return res.status(400).json({
                reply:
                    "I couldn't read that file. Please try another supported file."
            });
        }

        return next();
    }
);

/*
|--------------------------------------------------------------------------
| START
|--------------------------------------------------------------------------
*/

app.listen(PORT, () => {
    console.log(
        `NEXORA AI running at http://localhost:${PORT}`
    );
});