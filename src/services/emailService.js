import crypto from "node:crypto";
import { Resend } from "resend";

const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_CODE_ATTEMPTS = 5;

export class EmailServiceError extends Error {
    constructor(message, code) {
        super(message);
        this.name = "EmailServiceError";
        this.code = code;
    }
}

function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (character) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#039;"
    })[character]);
}

function isValidEmail(email) {
    return typeof email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function renderEmail({ title, greeting, message, code, expiresInMinutes }) {
    const safeTitle = escapeHtml(title);
    const safeGreeting = escapeHtml(greeting);
    const safeMessage = escapeHtml(message);
    const codeBlock = code
        ? `<tr><td style="padding:20px 0;text-align:center"><div style="display:inline-block;padding:16px 24px;border:1px solid #dbe3f0;border-radius:12px;background:#f8fafc;color:#111827;font-size:32px;font-weight:700;letter-spacing:8px">${escapeHtml(code)}</div><p style="margin:12px 0 0;color:#64748b;font-size:13px">This code expires in ${expiresInMinutes} minutes.</p></td></tr>`
        : "";

    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${safeTitle}</title></head><body style="margin:0;padding:24px 12px;background:#f1f5f9;font-family:Arial,Helvetica,sans-serif;color:#0f172a"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;margin:0 auto;border:1px solid #e2e8f0;border-radius:16px;background:#fff"><tr><td style="padding:28px 28px 12px;text-align:center"><div style="font-size:13px;font-weight:700;letter-spacing:3px;color:#2563eb">NEXORA AI</div></td></tr><tr><td style="padding:12px 28px 28px"><h1 style="margin:0 0 14px;font-size:23px;line-height:1.35">${safeTitle}</h1><p style="margin:0 0 12px;font-size:15px;line-height:1.65">${safeGreeting}</p><p style="margin:0;font-size:15px;line-height:1.65;color:#334155">${safeMessage}</p><table role="presentation" width="100%" cellspacing="0" cellpadding="0">${codeBlock}</table><p style="margin:16px 0 0;color:#64748b;font-size:13px;line-height:1.6">If you did not request this, you can safely ignore this email.</p></td></tr><tr><td style="padding:18px 28px;border-top:1px solid #e2e8f0;color:#64748b;font-size:12px;line-height:1.6;text-align:center">Nexora AI<br>Building the Digital Future · Nexora Tech</td></tr></table></body></html>`;
}

export function generateVerificationCode() {
    return crypto.randomInt(100000, 1000000).toString();
}

export function createVerificationChallenge({
    secret,
    payload = {},
    now = Date.now(),
    ttlMs = CODE_TTL_MS,
    maxAttempts = MAX_CODE_ATTEMPTS
}) {
    if (typeof secret !== "string" || Buffer.byteLength(secret) < 32) {
        throw new EmailServiceError("A strong OTP hashing secret is required.", "OTP_SECRET_REQUIRED");
    }
    const code = generateVerificationCode();
    const codeHash = crypto.createHmac("sha256", secret).update(code).digest("hex");
    return {
        code,
        challenge: {
            ...payload,
            codeHash,
            createdAt: now,
            expiresAt: now + ttlMs,
            attemptsRemaining: maxAttempts
        }
    };
}

export function verifyVerificationCode(challenge, code, {
    secret,
    now = Date.now()
} = {}) {
    if (!challenge || challenge.expiresAt <= now) return { valid: false, reason: "expired" };
    if (challenge.attemptsRemaining <= 0) return { valid: false, reason: "attempts" };
    if (typeof secret !== "string" || Buffer.byteLength(secret) < 32) {
        throw new EmailServiceError("A strong OTP hashing secret is required.", "OTP_SECRET_REQUIRED");
    }

    const enteredCode = String(code || "");
    const enteredHash = crypto.createHmac("sha256", secret).update(enteredCode).digest();
    const expectedHash = Buffer.from(challenge.codeHash, "hex");
    if (!/^\d{6}$/.test(enteredCode) || expectedHash.length !== enteredHash.length ||
        !crypto.timingSafeEqual(expectedHash, enteredHash)) {
        challenge.attemptsRemaining -= 1;
        return {
            valid: false,
            reason: challenge.attemptsRemaining > 0 ? "invalid" : "attempts",
            attemptsRemaining: challenge.attemptsRemaining
        };
    }

    return { valid: true };
}

export function createEmailService({
    getEnv = (name) => process.env[name],
    createClient = (apiKey) => new Resend(apiKey)
} = {}) {
    let client;
    let clientApiKey;

    function getConfiguration() {
        const apiKey = getEnv("RESEND_API_KEY")?.trim();
        const from = getEnv("EMAIL_FROM")?.trim();
        if (!apiKey || !from) {
            throw new EmailServiceError("Email sending is not configured.", "EMAIL_NOT_CONFIGURED");
        }
        return { apiKey, from };
    }

    async function send({ to, subject, title, greeting, message, code, expiresInMinutes }) {
        if (!isValidEmail(to)) {
            throw new EmailServiceError("Enter a valid email address.", "INVALID_EMAIL");
        }
        if (code !== undefined && !/^\d{6}$/.test(String(code))) {
            throw new EmailServiceError("A six-digit verification code is required.", "INVALID_EMAIL_CONTENT");
        }
        if (code !== undefined && (!Number.isInteger(expiresInMinutes) || expiresInMinutes < 1 || expiresInMinutes > 60)) {
            throw new EmailServiceError("A valid code expiration is required.", "INVALID_EMAIL_CONTENT");
        }
        const { apiKey, from } = getConfiguration();
        if (!client || clientApiKey !== apiKey) {
            client = createClient(apiKey);
            clientApiKey = apiKey;
        }
        const safeSubject = String(subject).replace(/[\r\n]+/g, " ").slice(0, 120);

        const text = [
            title,
            "",
            greeting,
            message,
            ...(code ? ["", `Verification code: ${code}`, `This code expires in ${expiresInMinutes} minutes.`] : []),
            "",
            "If you did not request this, you can safely ignore this email.",
            "Nexora AI · Nexora Tech"
        ].join("\n");

        let result;
        try {
            result = await client.emails.send({
                from,
                to: [to],
                subject: safeSubject,
                html: renderEmail({ title, greeting, message, code, expiresInMinutes }),
                text
            });
        } catch {
            throw new EmailServiceError("Resend could not accept the email.", "EMAIL_PROVIDER_ERROR");
        }

        if (result?.error || !result?.data?.id) {
            throw new EmailServiceError("Resend did not confirm the email request.", "EMAIL_PROVIDER_ERROR");
        }
        return { id: result.data.id };
    }

    return {
        isConfigured() {
            try {
                getConfiguration();
                return true;
            } catch (error) {
                if (error.code === "EMAIL_NOT_CONFIGURED") return false;
                throw error;
            }
        },
        sendVerificationCode(to, code, expiresInMinutes = 10) {
            return send({
                to,
                code,
                expiresInMinutes,
                subject: "Your Nexora AI verification code",
                title: "Verify your email",
                greeting: "Use this code to continue signing in to Nexora AI.",
                message: "Enter the verification code below in the app."
            });
        },
        sendPasswordResetCode(to, code, expiresInMinutes = 10) {
            return send({
                to,
                code,
                expiresInMinutes,
                subject: "Reset your Nexora AI password",
                title: "Reset your password",
                greeting: "We received a request to reset your Nexora AI password.",
                message: "Enter this code in the app to choose a new password."
            });
        },
        sendWelcomeEmail(to, name = "") {
            const greeting = name ? `Welcome to Nexora AI, ${name}.` : "Welcome to Nexora AI.";
            return send({
                to,
                subject: "Welcome to Nexora AI",
                title: "Welcome to Nexora AI",
                greeting,
                message: "Your account is ready. Sign in to continue."
            });
        },
        sendSecurityNotification(to, { title = "Security notification", message }) {
            if (typeof message !== "string" || !message.trim()) {
                throw new EmailServiceError("A security notification message is required.", "INVALID_EMAIL_CONTENT");
            }
            return send({
                to,
                subject: `Nexora AI: ${title}`,
                title,
                greeting: "There was an update related to the security of your Nexora AI account.",
                message
            });
        }
    };
}

const emailService = createEmailService();

export const isEmailServiceConfigured = () => emailService.isConfigured();
export const sendVerificationCode = (...args) => emailService.sendVerificationCode(...args);
export const sendPasswordResetCode = (...args) => emailService.sendPasswordResetCode(...args);
export const sendWelcomeEmail = (...args) => emailService.sendWelcomeEmail(...args);
export const sendSecurityNotification = (...args) => emailService.sendSecurityNotification(...args);
