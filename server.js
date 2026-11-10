import express from "express";
import dotenv from "dotenv";
import session from "express-session";
import createMemoryStore from "memorystore";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import multer from "multer";
import mammoth from "mammoth";
import "@napi-rs/canvas";
import { PDFParse } from "pdf-parse";
import ExcelJS from "exceljs";
import { fileTypeFromBuffer } from "file-type";
import { GoogleGenAI } from "@google/genai";
import OpenAI from "openai";
import { OAuth2Client } from "google-auth-library";

dotenv.config();
dotenv.config();

console.log("SESSION_SECRET STATUS:", {
    loaded: !!process.env.SESSION_SECRET,
    length: process.env.SESSION_SECRET?.length || 0
});
const app = express();
const PORT = process.env.PORT || 3000;
const DEPLOYMENT_HOST = process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL;
const DEFAULT_APP_BASE_URL = DEPLOYMENT_HOST
    ? `https://${DEPLOYMENT_HOST}`
    : `http://localhost:${PORT}`;
const CONFIGURED_APP_BASE_URL = process.env.APP_BASE_URL?.trim();
const USE_DEPLOYMENT_BASE_URL = DEPLOYMENT_HOST &&
    (!CONFIGURED_APP_BASE_URL || !/^https:\/\//i.test(CONFIGURED_APP_BASE_URL));
const APP_BASE_URL = (USE_DEPLOYMENT_BASE_URL
    ? DEFAULT_APP_BASE_URL
    : CONFIGURED_APP_BASE_URL || DEFAULT_APP_BASE_URL).replace(/\/$/, "");
const APP_ORIGIN = new URL(APP_BASE_URL).origin;
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY || "";
const ALLOW_GUEST_ACCESS = process.env.ALLOW_GUEST_ACCESS === "true";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, "public");

const MAX_FILE_SIZE = 20 * 1024 * 1024;
const MAX_FILES = 3;
const MAX_MESSAGE_LENGTH = 20000;
const SESSION_MAX_AGE = 7 * 24 * 60 * 60 * 1000;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const MICROSOFT_CLIENT_ID = process.env.MICROSOFT_CLIENT_ID || "";
const MICROSOFT_CLIENT_SECRET = process.env.MICROSOFT_CLIENT_SECRET || "";
const MICROSOFT_TENANT = process.env.MICROSOFT_TENANT || "common";
const MICROSOFT_AUTHORITY = `https://login.microsoftonline.com/${encodeURIComponent(MICROSOFT_TENANT)}`;
const SESSION_SECRET = process.env.SESSION_SECRET || "";
const SESSION_SECRET_CONFIGURED = Buffer.byteLength(SESSION_SECRET) >= 32;
const IS_PRODUCTION = process.env.NODE_ENV === "production";
const googleClient = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;
const SessionStore = createMemoryStore(session);
const SESSION_COOKIE_NAME = IS_PRODUCTION ? "__Host-nexora.sid" : "nexora.sid";

if (IS_PRODUCTION && new URL(APP_BASE_URL).protocol !== "https:") {
    throw new Error("Production requires APP_BASE_URL to use HTTPS.");
}

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

const PRICING_PLANS = [
    { id: "go", name: "Nexora Go", usdMonthly: 10 },
    { id: "pro", name: "Nexora Pro", usdMonthly: 25 },
    { id: "plus", name: "Nexora Plus", usdMonthly: 50 }
];
const PRICING_COUNTRIES = {
    AU: { name: "Australia", currency: "AUD" },
    BR: { name: "Brazil", currency: "BRL" },
    CA: { name: "Canada", currency: "CAD" },
    CN: { name: "China", currency: "CNY" },
    FR: { name: "France", currency: "EUR" },
    DE: { name: "Germany", currency: "EUR" },
    GH: { name: "Ghana", currency: "GHS" },
    IN: { name: "India", currency: "INR" },
    IE: { name: "Ireland", currency: "EUR" },
    IT: { name: "Italy", currency: "EUR" },
    JP: { name: "Japan", currency: "JPY" },
    KE: { name: "Kenya", currency: "KES" },
    MX: { name: "Mexico", currency: "MXN" },
    NG: { name: "Nigeria", currency: "NGN" },
    NZ: { name: "New Zealand", currency: "NZD" },
    PK: { name: "Pakistan", currency: "PKR" },
    SG: { name: "Singapore", currency: "SGD" },
    ZA: { name: "South Africa", currency: "ZAR" },
    KR: { name: "South Korea", currency: "KRW" },
    ES: { name: "Spain", currency: "EUR" },
    CH: { name: "Switzerland", currency: "CHF" },
    AE: { name: "United Arab Emirates", currency: "AED" },
    GB: { name: "United Kingdom", currency: "GBP" },
    US: { name: "United States", currency: "USD" }
};
const PAYSTACK_SUPPORTED_CURRENCIES = new Set(["GHS", "KES", "NGN", "USD", "ZAR"]);
let exchangeRateCache = null;

async function getUsdExchangeRates() {
    if (exchangeRateCache && exchangeRateCache.expiresAt > Date.now()) {
        return exchangeRateCache.rates;
    }

    const response = await fetch("https://open.er-api.com/v6/latest/USD", {
        signal: AbortSignal.timeout(5000)
    });
    if (!response.ok) {
        throw new Error(`Exchange-rate service responded with ${response.status}.`);
    }

    const data = await response.json();
    if (data.result !== "success" || !data.rates || typeof data.rates !== "object") {
        throw new Error("Exchange-rate service returned invalid data.");
    }

    exchangeRateCache = {
        rates: data.rates,
        updatedAt: data.time_last_update_utc || new Date().toISOString(),
        expiresAt: Date.now() + 12 * 60 * 60 * 1000
    };
    return exchangeRateCache.rates;
}

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

app.set("trust proxy", IS_PRODUCTION ? 1 : false);
app.disable("x-powered-by");
const rateLimitBuckets = new Map();
function rateLimit({ windowMs, max, name }) {
    return (req, res, next) => {
        const now = Date.now();
        const key = `${name}:${req.ip || req.socket.remoteAddress || "unknown"}`;
        let bucket = rateLimitBuckets.get(key);
        if (!bucket || bucket.resetAt <= now) {
            bucket = { count: 0, resetAt: now + windowMs };
            rateLimitBuckets.set(key, bucket);
        }
        bucket.count += 1;
        res.setHeader("RateLimit-Limit", max);
        res.setHeader("RateLimit-Remaining", Math.max(0, max - bucket.count));
        res.setHeader("RateLimit-Reset", Math.ceil(bucket.resetAt / 1000));
        if (bucket.count > max) {
            res.setHeader("Retry-After", Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)));
            return res.status(429).json({ message: "Too many requests. Please wait and try again." });
        }
        if (rateLimitBuckets.size > 10000 && bucket.count % 128 === 1) {
            for (const [bucketKey, entry] of rateLimitBuckets) {
                if (entry.resetAt <= now) rateLimitBuckets.delete(bucketKey);
            }
        }
        return next();
    };
}

const authRateLimit = rateLimit({ name: "auth", windowMs: 15 * 60 * 1000, max: 20 });
const chatRateLimit = rateLimit({ name: "chat", windowMs: 10 * 60 * 1000, max: 20 });
const paymentRateLimit = rateLimit({ name: "payment", windowMs: 15 * 60 * 1000, max: 10 });
const verifyRateLimit = rateLimit({ name: "verify", windowMs: 15 * 60 * 1000, max: 30 });
const publicApiRateLimit = rateLimit({ name: "public-api", windowMs: 60 * 1000, max: 120 });
const pricingRateLimit = rateLimit({ name: "pricing", windowMs: 60 * 1000, max: 60 });

app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin-allow-popups");
    res.setHeader("Content-Security-Policy", [
        "default-src 'self'",
        "base-uri 'self'",
        "object-src 'none'",
        "frame-ancestors 'none'",
        "form-action 'self' https://accounts.google.com",
        "script-src 'self' https://accounts.google.com",
        "style-src 'self' 'unsafe-inline' https://accounts.google.com",
        "img-src 'self' data: blob: https://*.googleusercontent.com",
        "font-src 'self' data:",
        "connect-src 'self' https://accounts.google.com https://oauth2.googleapis.com",
        "frame-src https://accounts.google.com",
        ...(IS_PRODUCTION ? ["upgrade-insecure-requests"] : [])
    ].join("; "));
    if (IS_PRODUCTION) {
        res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    }
    if (req.path.startsWith("/auth/") || req.path.startsWith("/api/") ||
        req.path === "/chat" || req.path === "/stream") {
        res.setHeader("Cache-Control", "no-store");
    }
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
        const origin = req.get("origin");
        const fetchSite = req.get("sec-fetch-site");
        if ((origin && origin !== APP_ORIGIN) || fetchSite === "cross-site") {
            return res.status(403).json({ message: "Cross-origin requests are not allowed." });
        }
    }
    return next();
});

app.use(express.json({ limit: "32kb" }));
app.use(session({
    name: SESSION_COOKIE_NAME,
    secret: SESSION_SECRET_CONFIGURED ? SESSION_SECRET : crypto.randomBytes(32).toString("hex"),
    store: new SessionStore({ checkPeriod: 86400000 }),
    resave: false,
    saveUninitialized: false,
    proxy: IS_PRODUCTION,
    cookie: {
        httpOnly: true,
        sameSite: "lax",
        secure: IS_PRODUCTION,
        path: "/",
        maxAge: SESSION_MAX_AGE
    }
}));
const publicFilePaths = new Set([
    "/index.html",
    "/style.css",
    "/settings.js",
    "/script.js",
    "/particles.js",
    "/logo.png",
    "/favicon.svg"
]);
const servePublicFiles = express.static(PUBLIC_DIR, {
    dotfiles: "deny",
    index: false,
    fallthrough: true
});
app.use((req, res, next) => {
    if (["GET", "HEAD"].includes(req.method) && publicFilePaths.has(req.path)) {
        return servePublicFiles(req, res, next);
    }
    return next();
});

if (!GOOGLE_CLIENT_ID) {
    console.warn("GOOGLE_CLIENT_ID is not configured. Google sign-in is unavailable.");
}
if (!SESSION_SECRET_CONFIGURED) {
    console.warn(IS_PRODUCTION
        ? "SESSION_SECRET is missing or shorter than 32 bytes. Authentication is disabled until it is configured."
        : "SESSION_SECRET is not configured. A temporary random development secret will be used.");
}
if (IS_PRODUCTION) {
    console.warn("Use a persistent shared session store in production; the configured in-memory store is for development only.");
}

function requireAuth(req, res, next) {
    if (IS_PRODUCTION && !SESSION_SECRET_CONFIGURED) {
        return res.status(503).json({
            error: "SESSION_SECRET_REQUIRED",
            message: "Authentication is temporarily unavailable. Configure SESSION_SECRET on the server and redeploy."
        });
    }
    if (req.session.user) return next();
    if (req.method === "GET") {
        return res.redirect(`/?redirect=${encodeURIComponent(req.originalUrl)}`);
    }
    return res.status(401).json({ error: "NOT_AUTHENTICATED", message: "Please sign in to continue." });
}

app.use("/auth", (req, res, next) => {
    if (IS_PRODUCTION && !SESSION_SECRET_CONFIGURED) {
        return res.status(503).json({
            error: "SESSION_SECRET_REQUIRED",
            message: "Authentication is temporarily unavailable. Configure SESSION_SECRET on the server and redeploy."
        });
    }
    return next();
});

function regenerateSession(req) {
    return new Promise((resolve, reject) => {
        req.session.regenerate((error) => {
            if (error) return reject(error);
            return resolve();
        });
    });
}

const emailAccounts = new Map();
const pendingEmailAuthentications = new Map();

function normalizeEmailAddress(value) {
    return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function isValidEmail(value) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value || "");
}

function hashPassword(password) {
    const salt = crypto.randomBytes(16).toString("hex");
    const hashed = crypto.pbkdf2Sync(password, salt, 200000, 32, "sha256");
    return `${salt}:${hashed.toString("hex")}`;
}

function verifyPassword(password, storedValue) {
    if (typeof password !== "string" || typeof storedValue !== "string") {
        return false;
    }

    const separatorIndex = storedValue.indexOf(":");
    if (separatorIndex <= 0 || separatorIndex === storedValue.length - 1) {
        return false;
    }

    const salt = storedValue.slice(0, separatorIndex);
    const expectedHex = storedValue.slice(separatorIndex + 1);
    const candidateHex = crypto.pbkdf2Sync(password, salt, 200000, 32, "sha256").toString("hex");

    try {
        return crypto.timingSafeEqual(
            Buffer.from(expectedHex, "hex"),
            Buffer.from(candidateHex, "hex")
        );
    } catch (error) {
        return false;
    }
}

function generateOtpCode() {
    return crypto.randomInt(100000, 1000000).toString().padStart(6, "0");
}

function createPendingEmailAuth(email, payload) {
    const code = generateOtpCode();
    const entry = {
        ...payload,
        email,
        codeHash: crypto.createHash("sha256").update(code).digest("hex"),
        createdAt: Date.now(),
        expiresAt: Date.now() + 10 * 60 * 1000
    };
    pendingEmailAuthentications.set(email, entry);
    console.log(`[Nexora OTP] ${email}: ${code}`);
    return code;
}

function getUserFromEmailAccount(account) {
    if (!account || typeof account !== "object") return null;
    return {
        sub: `email:${account.email}`,
        name: account.name || account.email.split("@")[0],
        email: account.email,
        picture: "",
        age: account.age ?? null,
        isEmailUser: true
    };
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

function buildPrompt(message, files, responseStyle = "Balanced", audienceAge = null) {
    const ageGuidance = Number.isInteger(audienceAge)
        ? audienceAge < 13
            ? "The user's self-reported age is under 13. Use simple, age-appropriate language, protect their privacy, and keep examples and guidance suitable for a young child."
            : audienceAge < 18
                ? "The user's self-reported age is 13 to 17. Use age-appropriate language and examples, protect their privacy, and give supportive, safe guidance."
                : "The user's self-reported age is 18 or older. Use clear adult-level language while maintaining standard safety and privacy protections."
        : "The user's age is unknown. Keep responses suitable for a general audience.";
    let prompt = `
You are Nexora AI.

Answer clearly, accurately and helpfully.
${ageGuidance}

If the user sends a brief greeting such as "hi" or "hello", answer in a warm, natural, conversational way. Briefly introduce yourself as Nexora AI, mention one or two things you can help with (such as writing, learning, or understanding uploaded files), and ask what they would like to work on. Keep it concise and do not turn a greeting into a sales pitch.

If the user asks about Nexora subscriptions or pricing, explain the monthly plans accurately: Nexora Go is $10 USD/month, Nexora Pro is $25 USD/month, and Nexora Plus is $50 USD/month. The in-app pricing panel can display an approximate localized currency conversion based on the selected country. Do not invent plan benefits, taxes, exchange rates, or checkout availability.

For a question with multiple parts or one that needs a lengthy explanation:
- Start with a short "Summary" that answers the main question or states the key takeaway.
- Then use clear headings and address each part of the request without skipping anything.
- Prefer concise paragraphs, bullets for related points, and numbered steps for procedures.
- Include useful details and examples, but avoid repetition, filler, or restating the question.
For simple questions, answer directly without forcing a summary or headings. Follow the requested response style for depth while keeping the answer focused.

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
    responseStyle = "Balanced",
    audienceAge = null
) {
    const parts = [
        {
            text: buildPrompt(
                message,
                files,
                responseStyle,
                audienceAge
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
    responseStyle = "Balanced",
    audienceAge = null
) {
    const content = [
        {
            type: "input_text",
            text: buildPrompt(
                message,
                files,
                responseStyle,
                audienceAge
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
    responseStyle,
    audienceAge
) {
    if (!gemini) {
        throw new Error("GEMINI_API_KEY is not configured.");
    }

    const response = await gemini.models.generateContent({
        model,
        contents: buildGeminiContents(
            message,
            files,
            responseStyle,
            audienceAge
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
    responseStyle,
    audienceAge
) {
    if (!openai) {
        throw new Error("OPENAI_API_KEY is not configured.");
    }

    const response = await openai.responses.create({
        model,
        input: buildOpenAIInput(
            message,
            files,
            responseStyle,
            audienceAge
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
    responseStyle,
    audienceAge
) {
    if (provider === "openai") {
        return generateOpenAIResponse(
            message,
            model,
            files,
            responseStyle,
            audienceAge
        );
    }

    return generateGeminiResponse(
        message,
        model,
        files,
        responseStyle,
        audienceAge
    );
}

/*
|--------------------------------------------------------------------------
| AUTHENTICATION
|--------------------------------------------------------------------------
| In Google Cloud Console, authorize http://localhost:3000 as an
| authorized JavaScript origin for local development.
*/
app.post("/auth/google", authRateLimit, async (req, res) => {
    try {
        if (!googleClient || !GOOGLE_CLIENT_ID) {
            return res.status(503).json({ message: "Google sign-in is not configured on the server." });
        }
        const credential = typeof req.body?.credential === "string" ? req.body.credential : "";
        if (!credential) return res.status(400).json({ message: "Google authentication credential is missing." });
        const ticket = await googleClient.verifyIdToken({ idToken: credential, audience: GOOGLE_CLIENT_ID });
        const payload = ticket.getPayload();
        if (!payload?.sub || !payload.email || payload.email_verified !== true) return res.status(401).json({ message: "A verified Google account is required." });
        const signup = req.body?.signup;
        let signupName = "";
        let signupAge = null;
        if (signup !== undefined) {
            signupName = typeof signup.name === "string" ? signup.name.trim() : "";
            signupAge = Number(signup.age);
            if (!signupName || signupName.length > 80 || !Number.isInteger(signupAge) || signupAge < 1 || signupAge > 120) {
                return res.status(400).json({ message: "Please provide a name and a valid age between 1 and 120." });
            }
        }
        try {
            await regenerateSession(req);
        } catch (error) {
            console.error("Session regeneration error:", error);
            return res.status(500).json({ message: "Unable to create a secure sign-in session. Please try again." });
        }
        req.session.user = {
            sub: payload.sub,
            name: signupName || payload.name || payload.email.split("@")[0],
            email: payload.email,
            picture: payload.picture || "",
            age: signupAge
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

app.post("/auth/microsoft/start", authRateLimit, (req, res) => {
    if (!MICROSOFT_CLIENT_ID || !MICROSOFT_CLIENT_SECRET) {
        return res.status(503).json({
            message: "Microsoft sign-in is not configured. Set MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET on the server."
        });
    }

    const mode = req.body?.mode === "signup" ? "signup" : "login";
    let signup = null;
    if (mode === "signup") {
        const name = typeof req.body?.signup?.name === "string" ? req.body.signup.name.trim() : "";
        const age = Number(req.body?.signup?.age);
        if (!name || name.length > 80 || !Number.isInteger(age) || age < 1 || age > 120) {
            return res.status(400).json({ message: "Please provide your name and a valid age between 1 and 120." });
        }
        signup = { name, age };
    }

    const state = crypto.randomBytes(32).toString("base64url");
    const nonce = crypto.randomBytes(32).toString("base64url");
    const codeVerifier = crypto.randomBytes(48).toString("base64url");
    const codeChallenge = crypto.createHash("sha256").update(codeVerifier).digest("base64url");
    req.session.microsoftAuth = {
        state,
        nonce,
        codeVerifier,
        mode,
        signup,
        createdAt: Date.now()
    };

    const authorizeUrl = new URL(`${MICROSOFT_AUTHORITY}/oauth2/v2.0/authorize`);
    authorizeUrl.search = new URLSearchParams({
        client_id: MICROSOFT_CLIENT_ID,
        response_type: "code",
        response_mode: "query",
        redirect_uri: `${APP_BASE_URL}/auth/microsoft/callback`,
        scope: "openid profile email",
        state,
        nonce,
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
        prompt: mode === "signup" ? "create" : "select_account"
    }).toString();

    return req.session.save((error) => {
        if (error) {
            console.error("Microsoft auth session save error:", error);
            return res.status(500).json({ message: "Unable to start Microsoft sign-in. Please try again." });
        }
        return res.json({ authorizeUrl: authorizeUrl.toString() });
    });
});

const microsoftSigningKeys = new Map();
let microsoftSigningKeysExpiresAt = 0;

async function getMicrosoftSigningKey(keyId) {
    if (microsoftSigningKeysExpiresAt <= Date.now() || !microsoftSigningKeys.has(keyId)) {
        const response = await fetch("https://login.microsoftonline.com/common/discovery/v2.0/keys", {
            signal: AbortSignal.timeout(10000)
        });
        if (!response.ok) {
            throw new Error(`Microsoft signing-key service responded with ${response.status}.`);
        }
        const keySet = await response.json();
        if (!Array.isArray(keySet.keys)) {
            throw new Error("Microsoft signing-key service returned an invalid key set.");
        }

        microsoftSigningKeys.clear();
        for (const key of keySet.keys) {
            if (key.kid && key.kty === "RSA" && key.use === "sig") {
                microsoftSigningKeys.set(key.kid, key);
            }
        }
        microsoftSigningKeysExpiresAt = Date.now() + 60 * 60 * 1000;
    }

    const jwk = microsoftSigningKeys.get(keyId);
    if (!jwk) {
        throw new Error("Microsoft ID token was signed with an unknown key.");
    }
    return crypto.createPublicKey({ key: jwk, format: "jwk" });
}

async function verifyMicrosoftIdToken(idToken, expectedNonce) {
    if (typeof idToken !== "string") {
        throw new Error("Microsoft did not return an ID token.");
    }

    const parts = idToken.split(".");
    if (parts.length !== 3) {
        throw new Error("Microsoft returned a malformed ID token.");
    }

    const header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    if (header.alg !== "RS256" || typeof header.kid !== "string") {
        throw new Error("Microsoft returned an unsupported ID token.");
    }

    const key = await getMicrosoftSigningKey(header.kid);
    const validSignature = crypto.verify(
        "RSA-SHA256",
        Buffer.from(`${parts[0]}.${parts[1]}`),
        key,
        Buffer.from(parts[2], "base64url")
    );
    if (!validSignature) {
        throw new Error("Microsoft ID token signature verification failed.");
    }

    const now = Math.floor(Date.now() / 1000);
    const tenantId = typeof claims.tid === "string" ? claims.tid : "";
    const expectedIssuer = `https://login.microsoftonline.com/${tenantId}/v2.0`;
    if (!claims.sub ||
        claims.aud !== MICROSOFT_CLIENT_ID ||
        claims.iss !== expectedIssuer ||
        claims.nonce !== expectedNonce ||
        !Number.isFinite(claims.exp) ||
        claims.exp <= now ||
        (Number.isFinite(claims.nbf) && claims.nbf > now + 60) ||
        !/^[0-9a-f-]{36}$/i.test(tenantId)) {
        throw new Error("Microsoft ID token claims could not be validated.");
    }

    if (/^[0-9a-f-]{36}$/i.test(MICROSOFT_TENANT) &&
        tenantId.toLowerCase() !== MICROSOFT_TENANT.toLowerCase()) {
        throw new Error("Microsoft ID token was issued by an unexpected tenant.");
    }
    return claims;
}

app.get("/auth/microsoft/callback", authRateLimit, async (req, res) => {
    const pending = req.session.microsoftAuth;
    delete req.session.microsoftAuth;

    const returnedState = typeof req.query.state === "string" ? req.query.state : "";
    const stateMatches = pending &&
        pending.createdAt + 10 * 60 * 1000 > Date.now() &&
        returnedState.length === pending.state.length &&
        crypto.timingSafeEqual(Buffer.from(returnedState), Buffer.from(pending.state));
    if (!stateMatches) {
        return res.redirect("/?auth_error=microsoft_state");
    }
    if (typeof req.query.error === "string" || typeof req.query.code !== "string") {
        return res.redirect("/?auth_error=microsoft_denied");
    }

    try {
        const tokenResponse = await fetch(`${MICROSOFT_AUTHORITY}/oauth2/v2.0/token`, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
                client_id: MICROSOFT_CLIENT_ID,
                client_secret: MICROSOFT_CLIENT_SECRET,
                grant_type: "authorization_code",
                code: req.query.code,
                redirect_uri: `${APP_BASE_URL}/auth/microsoft/callback`,
                code_verifier: pending.codeVerifier
            }),
            signal: AbortSignal.timeout(15000)
        });
        const tokenData = await tokenResponse.json();
        if (!tokenResponse.ok || typeof tokenData.id_token !== "string") {
            console.error("Microsoft token exchange failed:", tokenData.error || tokenResponse.status);
            return res.redirect("/?auth_error=microsoft_exchange");
        }

        const claims = await verifyMicrosoftIdToken(tokenData.id_token, pending.nonce);
        const email = typeof claims.email === "string"
            ? claims.email
            : typeof claims.preferred_username === "string"
                ? claims.preferred_username
                : "";
        if (!isValidEmail(email)) {
            return res.redirect("/?auth_error=microsoft_email");
        }

        await regenerateSession(req);
        req.session.user = {
            sub: `microsoft:${claims.tid}:${claims.sub}`,
            name: pending.mode === "signup" && pending.signup?.name
                ? pending.signup.name
                : typeof claims.name === "string"
                    ? claims.name.slice(0, 80)
                    : email.split("@")[0],
            email: email.toLowerCase(),
            picture: "",
            age: pending.mode === "signup" ? pending.signup.age : null,
            isMicrosoftUser: true
        };
        return req.session.save((error) => {
            if (error) {
                console.error("Microsoft session creation error:", error);
                return res.redirect("/?auth_error=microsoft_session");
            }
            return res.redirect("/chat");
        });
    } catch (error) {
        console.error("Microsoft authentication error:", error);
        return res.redirect("/?auth_error=microsoft_failed");
    }
});

app.post("/auth/guest", authRateLimit, async (req, res) => {
    if (!ALLOW_GUEST_ACCESS) {
        return res.status(404).json({ message: "Guest access is disabled." });
    }
    try {
        await regenerateSession(req);
    } catch (error) {
        console.error("Guest session regeneration error:", error);
        return res.status(500).json({ message: "Unable to start a secure guest session. Please try again." });
    }
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

app.post("/auth/email/start", authRateLimit, async (req, res) => {
    const mode = req.body?.mode === "signup" ? "signup" : "login";
    const email = normalizeEmailAddress(req.body?.email);
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
    const age = Number(req.body?.age);

    if (!isValidEmail(email)) {
        return res.status(400).json({ message: "Enter a valid email address to continue." });
    }
    if (password.length < 8 || password.length > 128) {
        return res.status(400).json({ message: "Choose a password between 8 and 128 characters." });
    }

    if (mode === "signup") {
        if (!name || name.length > 80) {
            return res.status(400).json({ message: "Please provide your name to create an account." });
        }
        if (!Number.isInteger(age) || age < 1 || age > 120) {
            return res.status(400).json({ message: "Enter a valid age between 1 and 120." });
        }
        if (emailAccounts.has(email)) {
            return res.status(409).json({ message: "This email is already registered. Please log in instead." });
        }
    }

    if (mode === "login") {
        const existing = emailAccounts.get(email);
        if (!existing || !verifyPassword(password, existing.passwordHash)) {
            return res.status(401).json({ message: "Incorrect email or password." });
        }
    }

    const pending = pendingEmailAuthentications.get(email);
    if (pending && pending.expiresAt > Date.now()) {
        pendingEmailAuthentications.delete(email);
    }

    const code = createPendingEmailAuth(email, {
        mode,
        name,
        age: Number.isInteger(age) ? age : null,
        passwordHash: mode === "signup" ? hashPassword(password) : emailAccounts.get(email)?.passwordHash || hashPassword(password)
    });

    const shouldRevealCode = process.env.NODE_ENV !== "production" || process.env.SHOW_OTP_DEV_CODES === "true";
    return res.json({
        requiresOtp: true,
        message: "A 6-digit verification code has been sent to your email.",
        ...(shouldRevealCode ? { debugCode: code } : {})
    });
});

app.post("/auth/email/verify", authRateLimit, async (req, res) => {
    const email = normalizeEmailAddress(req.body?.email);
    const code = String(req.body?.code || "").trim();
    const pending = pendingEmailAuthentications.get(email);

    if (!isValidEmail(email)) {
        return res.status(400).json({ message: "Enter a valid email address to verify." });
    }
    if (!/^\d{6}$/.test(code)) {
        return res.status(400).json({ message: "Enter the 6-digit verification code." });
    }
    if (!pending || pending.expiresAt < Date.now()) {
        return res.status(400).json({ message: "Your verification code has expired. Please request a new one." });
    }

    const enteredHash = crypto.createHash("sha256").update(code).digest("hex");
    const matches = pending.codeHash === enteredHash;
    if (!matches) {
        return res.status(401).json({ message: "The verification code does not match." });
    }

    try {
        await regenerateSession(req);
    } catch (error) {
        console.error("Email session regeneration error:", error);
        return res.status(500).json({ message: "Unable to create a secure email session. Please try again." });
    }

    if (pending.mode === "signup") {
        const existing = emailAccounts.get(email);
        if (existing) {
            pendingEmailAuthentications.delete(email);
            return res.status(409).json({ message: "This email is already registered. Please log in instead." });
        }
        const account = {
            email,
            name: pending.name,
            age: Number.isInteger(pending.age) ? pending.age : null,
            passwordHash: pending.passwordHash
        };
        emailAccounts.set(email, account);
        req.session.user = getUserFromEmailAccount(account);
    } else {
        const account = emailAccounts.get(email);
        if (!account) {
            pendingEmailAuthentications.delete(email);
            return res.status(401).json({ message: "No account was found for this email." });
        }
        req.session.user = getUserFromEmailAccount(account);
    }

    pendingEmailAuthentications.delete(email);
    return req.session.save((error) => {
        if (error) {
            console.error("Email session creation error:", error);
            return res.status(500).json({ message: "Unable to finish sign in. Please try again." });
        }
        return res.json({ user: req.session.user });
    });
});

app.get("/auth/me", publicApiRateLimit, (req, res) => {
    if (!req.session.user) return res.status(401).json({ authenticated: false });
    return res.json({ authenticated: true, user: req.session.user });
});

app.post("/auth/logout", authRateLimit, (req, res) => {
    req.session.destroy((error) => {
        if (error) {
            console.error("Session destruction error:", error);
            return res.status(500).json({ message: "Unable to sign you out. Please try again." });
        }
        res.clearCookie(SESSION_COOKIE_NAME, { httpOnly: true, sameSite: "lax", secure: IS_PRODUCTION, path: "/" });
        return res.json({ authenticated: false });
    });
});

/*
|--------------------------------------------------------------------------
| CHAT PAGE
|--------------------------------------------------------------------------
*/

app.get("/chat", requireAuth, (req, res) => {
    return res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

/*
|--------------------------------------------------------------------------
| CHAT
|--------------------------------------------------------------------------
*/

app.post(
    "/chat",
    chatRateLimit,
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
            if (message.length > MAX_MESSAGE_LENGTH) {
                return res.status(400).json({
                    reply: `Messages must be ${MAX_MESSAGE_LENGTH.toLocaleString()} characters or fewer.`
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
                req.body.responseStyle,
                req.session.user?.age ?? null
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

app.get("/stream", chatRateLimit, requireAuth, async (req, res) => {
    const message =
        typeof req.query.message === "string"
            ? req.query.message
            : "";

    if (!message.trim()) {
        return res.status(400).end();
    }
    if (message.length > MAX_MESSAGE_LENGTH) {
        return res.status(400).json({
            message: `Messages must be ${MAX_MESSAGE_LENGTH.toLocaleString()} characters or fewer.`
        });
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
                        req.query.responseStyle,
                        req.session.user?.age ?? null
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
                    req.query.responseStyle,
                    req.session.user?.age ?? null
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

app.get("/config", publicApiRateLimit, (req, res) => {
    res.json({
        googleClientId: GOOGLE_CLIENT_ID,
        microsoftConfigured: Boolean(MICROSOFT_CLIENT_ID && MICROSOFT_CLIENT_SECRET),
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

app.get("/api/health", publicApiRateLimit, (req, res) => {
    res.json({
        status: "ok",
        environment: IS_PRODUCTION ? "production" : "development",
        sessionSecretConfigured: SESSION_SECRET_CONFIGURED,
        paymentProviderConfigured: Boolean(PAYSTACK_SECRET_KEY),
        providers: {
            gemini: Boolean(process.env.GEMINI_API_KEY),
            openai: Boolean(process.env.OPENAI_API_KEY),
            googleSignIn: Boolean(GOOGLE_CLIENT_ID)
        }
    });
});

app.get("/api/pricing", pricingRateLimit, async (req, res) => {
    const countryCode = String(req.query.country || "US").toUpperCase();
    const country = PRICING_COUNTRIES[countryCode];
    if (!country) {
        return res.status(400).json({
            message: "Choose a supported country to view localized pricing."
        });
    }

    try {
        const rates = country.currency === "USD"
            ? { USD: 1 }
            : await getUsdExchangeRates();
        const rate = rates[country.currency];
        if (!Number.isFinite(rate) || rate <= 0) {
            throw new Error(`No exchange rate is available for ${country.currency}.`);
        }

        const fractionDigits = new Intl.NumberFormat("en", {
            style: "currency",
            currency: country.currency
        }).resolvedOptions().maximumFractionDigits;

        res.json({
            country: { code: countryCode, name: country.name },
            currency: country.currency,
            checkoutAvailable: PAYSTACK_SUPPORTED_CURRENCIES.has(country.currency) &&
                Boolean(PAYSTACK_SECRET_KEY),
            checkoutMessage: !PAYSTACK_SECRET_KEY
                ? "Paystack checkout is not configured on the server yet."
                : PAYSTACK_SUPPORTED_CURRENCIES.has(country.currency)
                    ? "Pay securely with Paystack."
                    : `Paystack checkout is not available in ${country.currency}.`,
            exchangeRate: rate,
            rateUpdatedAt: exchangeRateCache?.updatedAt || null,
            countries: Object.entries(PRICING_COUNTRIES)
                .map(([code, item]) => ({ code, name: item.name }))
                .sort((left, right) => left.name.localeCompare(right.name)),
            plans: PRICING_PLANS.map((plan) => ({
                id: plan.id,
                name: plan.name,
                usdMonthly: plan.usdMonthly,
                monthlyPrice: Number(
                    (plan.usdMonthly * rate).toFixed(fractionDigits)
                )
            }))
        });
    } catch (error) {
        console.error("Unable to load localized pricing:", error);
        res.status(502).json({
            message: "Localized pricing is temporarily unavailable. Please try again."
        });
    }
});

app.post("/api/checkout", paymentRateLimit, requireAuth, async (req, res) => {
    if (!PAYSTACK_SECRET_KEY) {
        return res.status(503).json({
            message: "Payments are not configured yet. Add PAYSTACK_SECRET_KEY to the server environment."
        });
    }

    const { planId, country: countryCode } = req.body || {};
    const plan = PRICING_PLANS.find((item) => item.id === planId);
    const country = PRICING_COUNTRIES[String(countryCode || "").toUpperCase()];
    const email = typeof req.body?.email === "string"
        ? req.body.email.trim().toLowerCase()
        : req.session.user.email;
    const name = typeof req.body?.name === "string" && req.body.name.trim()
        ? req.body.name.trim().slice(0, 120)
        : req.session.user.name;

    if (!plan || !country) {
        return res.status(400).json({ message: "Choose a valid plan and country." });
    }
    if (!PAYSTACK_SUPPORTED_CURRENCIES.has(country.currency)) {
        return res.status(400).json({
            message: `Paystack checkout is not available in ${country.currency}. Choose another country.`
        });
    }
    if (typeof email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(400).json({ message: "Enter a valid email address for your payment receipt." });
    }

    try {
        const rates = country.currency === "USD"
            ? { USD: 1 }
            : await getUsdExchangeRates();
        const rate = rates[country.currency];
        if (!Number.isFinite(rate) || rate <= 0) {
            return res.status(400).json({
                message: `Checkout is not available in ${country.currency}. Choose another country.`
            });
        }

        const fractionDigits = new Intl.NumberFormat("en", {
            style: "currency",
            currency: country.currency
        }).resolvedOptions().maximumFractionDigits;
        const amount = Number((plan.usdMonthly * rate).toFixed(fractionDigits));
        const amountSubunits = Math.round(amount * (10 ** fractionDigits));
        if (!Number.isSafeInteger(amountSubunits) || amountSubunits <= 0) {
            throw new Error("Calculated checkout amount is outside the supported range.");
        }

        const reference = `nexora-${crypto.randomUUID()}`;
        const callbackUrl = new URL("/chat?payment=return", APP_BASE_URL).toString();
        const paystackResponse = await fetch("https://api.paystack.co/transaction/initialize", {
            method: "POST",
            headers: {
                Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                email,
                amount: amountSubunits,
                currency: country.currency,
                reference,
                callback_url: callbackUrl,
                metadata: {
                    plan_id: plan.id,
                    plan_name: plan.name,
                    customer_name: String(name || email.split("@")[0]).slice(0, 120)
                }
            }),
            signal: AbortSignal.timeout(15000)
        });
        const result = await paystackResponse.json();
        const checkoutUrl = result?.data?.authorization_url;
        if (!paystackResponse.ok || result.status !== true ||
            result.data?.reference !== reference || typeof checkoutUrl !== "string") {
            console.error("Paystack checkout initialization failed:", result.message || paystackResponse.status);
            return res.status(502).json({
                message: "Unable to start secure checkout. Please try again."
            });
        }

        const parsedCheckoutUrl = new URL(checkoutUrl);
        if (parsedCheckoutUrl.protocol !== "https:" ||
            parsedCheckoutUrl.hostname !== "checkout.paystack.com") {
            console.error("Paystack returned an unexpected checkout URL.");
            return res.status(502).json({
                message: "Unable to start secure checkout. Please try again."
            });
        }

        req.session.checkout = {
            reference,
            planId: plan.id,
            planName: plan.name,
            amount,
            amountSubunits,
            currency: country.currency,
            createdAt: Date.now()
        };
        req.session.save((error) => {
            if (error) {
                console.error("Unable to save checkout session:", error);
                return res.status(500).json({
                    message: "Unable to prepare checkout. Please try again."
                });
            }
            return res.json({ checkoutUrl, reference });
        });
    } catch (error) {
        console.error("Unable to initialize Paystack checkout:", error);
        return res.status(502).json({
            message: "Unable to start secure checkout. Please try again."
        });
    }
});

app.post("/api/checkout/verify", verifyRateLimit, requireAuth, async (req, res) => {
    if (!PAYSTACK_SECRET_KEY) {
        return res.status(503).json({ message: "Payment verification is not configured." });
    }

    const checkout = req.session.checkout;
    const reference = typeof req.body?.reference === "string" ? req.body.reference : "";
    if (!checkout || checkout.reference !== reference ||
        Date.now() - checkout.createdAt > 24 * 60 * 60 * 1000) {
        return res.status(400).json({
            message: "This payment could not be matched to your active checkout."
        });
    }

    try {
        const response = await fetch(
            `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
            {
                headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` },
                signal: AbortSignal.timeout(15000)
            }
        );
        const result = await response.json();
        const transaction = result?.data;
        if (!response.ok || result.status !== true || !transaction) {
            console.error("Paystack payment verification failed:", result.message || response.status);
            return res.status(502).json({
                message: "Unable to verify this payment yet. Please try again."
            });
        }
        if (transaction.reference !== checkout.reference ||
            transaction.currency !== checkout.currency ||
            !Number.isSafeInteger(transaction.amount) ||
            transaction.amount < checkout.amountSubunits) {
            return res.status(400).json({
                message: "The payment details did not match this checkout."
            });
        }

        if (transaction.status !== "success") {
            const failed = ["failed", "abandoned"].includes(transaction.status);
            return res.json({
                status: failed ? "failed" : "pending",
                message: failed
                    ? "The payment was not completed. You can start checkout again."
                    : "Payment is still processing. Check again shortly."
            });
        }

        const paidAt = Date.now();
        const validUntil = new Date(paidAt);
        validUntil.setMonth(validUntil.getMonth() + 1);
        const payment = {
            planId: checkout.planId,
            planName: checkout.planName,
            amount: checkout.amount,
            currency: checkout.currency,
            reference: checkout.reference,
            paidAt,
            validUntil: validUntil.getTime()
        };
        req.session.lastPayment = payment;
        req.session.checkout = null;
        req.session.save((error) => {
            if (error) {
                console.error("Unable to save verified payment to session:", error);
                return res.status(500).json({
                    message: "Payment was received, but your confirmation could not be saved. Contact support with your payment reference."
                });
            }
            return res.json({
                status: "successful",
                planName: payment.planName,
                validUntil: new Date(payment.validUntil).toISOString(),
                reference: payment.reference
            });
        });
    } catch (error) {
        console.error("Paystack payment verification failed:", error);
        return res.status(502).json({
            message: "Unable to verify this payment yet. Please try again."
        });
    }
});
/*
|--------------------------------------------------------------------------
| HOME
|--------------------------------------------------------------------------
*/

app.get("/", (req, res) => {
    if (req.session.user) return res.redirect("/chat");
    res.sendFile(
        path.join(PUBLIC_DIR, "index.html")
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
        if (error?.type === "entity.too.large") {
            return res.status(413).json({
                message: "Request body is too large."
            });
        }
        if (
            error?.code ===
            "LIMIT_FILE_SIZE"
        ) {
            return res.status(400).json({
                reply:
                    "File is too large. Maximum supported size is 20 MB."
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
                    "You can attach up to 3 supported files."
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

export default app;

if (!process.env.VERCEL) {
    app.listen(PORT, () => {
        console.log(
            `NEXORA AI running at http://localhost:${PORT}`
        );
    });
}
