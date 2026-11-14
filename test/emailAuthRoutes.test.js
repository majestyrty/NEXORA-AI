import assert from "node:assert/strict";
import http from "node:http";
import test, { after, before } from "node:test";

process.env.VERCEL = "1";
process.env.NODE_ENV = "development";
process.env.SESSION_SECRET = "test-session-secret-with-more-than-thirty-two-bytes";
process.env.RESEND_API_KEY = "test-resend-key";
process.env.EMAIL_FROM = "Nexora AI <onboarding@resend.dev>";
process.env.GOOGLE_CLIENT_ID = "";
process.env.DATABASE_URL = "";
process.env.POSTGRES_URL = "";
process.env.POSTGRES_PRISMA_URL = "";

const originalFetch = globalThis.fetch;
const sentEmails = [];
let failNextEmail = false;
globalThis.fetch = async (input, init) => {
    if (String(input).startsWith("https://api.resend.com/")) {
        if (failNextEmail) {
            failNextEmail = false;
            return new Response(JSON.stringify({ message: "provider unavailable" }), {
                status: 500,
                headers: { "Content-Type": "application/json" }
            });
        }
        const payload = JSON.parse(init.body);
        const code = payload.html.match(/letter-spacing:8px">(\d{6})</)?.[1];
        sentEmails.push({ subject: payload.subject, to: payload.to, code });
        return new Response(JSON.stringify({ id: `test_email_${sentEmails.length}` }), {
            status: 200,
            headers: { "Content-Type": "application/json" }
        });
    }
    return originalFetch(input, init);
};

const originalConsoleLog = console.log;
console.log = () => {};
const { default: app } = await import("../server.js?email-auth-route-tests");
console.log = originalConsoleLog;

let server;
let port;

before(async () => {
    server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    port = server.address().port;
});

after(async () => {
    if (server) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    globalThis.fetch = originalFetch;
});

function post(path, body) {
    return new Promise((resolve, reject) => {
        const data = JSON.stringify(body);
        const request = http.request({
            hostname: "127.0.0.1",
            port,
            path,
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(data)
            }
        }, (response) => {
            let text = "";
            response.setEncoding("utf8");
            response.on("data", (chunk) => { text += chunk; });
            response.on("end", () => resolve({ status: response.statusCode, body: JSON.parse(text) }));
        });
        request.setTimeout(10000, () => request.destroy(new Error("Email auth test request timed out.")));
        request.on("error", reject);
        request.end(data);
    });
}

test("signup, OTP cooldown and verification, password reset, and email login work end-to-end", async () => {
    const email = "email-auth-route-test@example.com";
    let response = await post("/auth/email/start", {
        mode: "signup",
        email,
        password: "StrongPass123",
        name: "Test User",
        age: 25
    });
    assert.equal(response.status, 202);
    const signupCode = sentEmails.find((item) => item.subject === "Your Nexora AI verification code")?.code;
    assert.match(signupCode, /^\d{6}$/);

    await post("/auth/email/start", {
        mode: "signup",
        email,
        password: "StrongPass123",
        name: "Test User",
        age: 25
    });
    assert.equal(sentEmails.filter((item) => item.subject === "Your Nexora AI verification code").length, 1);

    response = await post("/auth/email/verify", {
        mode: "signup",
        email,
        code: signupCode === "000000" ? "000001" : "000000"
    });
    assert.equal(response.status, 400);
    response = await post("/auth/email/verify", { mode: "signup", email, code: signupCode });
    assert.equal(response.status, 200);
    response = await post("/auth/email/verify", { mode: "signup", email, code: signupCode });
    assert.equal(response.status, 400, "a verified code cannot be reused");

    const sentBeforeUnknownReset = sentEmails.length;
    const unknownReset = await post("/auth/email/start", {
        mode: "reset",
        email: "unknown-reset@example.com"
    });
    response = await post("/auth/email/start", { mode: "reset", email });
    assert.equal(response.status, 202);
    assert.deepEqual(response.body, unknownReset.body, "reset response does not disclose whether the account exists");
    assert.equal(sentEmails.length, sentBeforeUnknownReset + 1, "only the eligible account receives a reset email");
    const resetCode = sentEmails.find((item) => item.subject === "Reset your Nexora AI password")?.code;
    assert.match(resetCode, /^\d{6}$/);
    response = await post("/auth/email/verify", {
        mode: "reset",
        email,
        code: resetCode,
        newPassword: "NewStrongPass456"
    });
    assert.equal(response.status, 200);

    response = await post("/auth/email/start", {
        mode: "login",
        email,
        password: "NewStrongPass456"
    });
    assert.equal(response.status, 202);
    const loginCode = sentEmails.filter((item) => item.subject === "Your Nexora AI verification code").at(-1)?.code;
    response = await post("/auth/email/verify", { mode: "login", email, code: loginCode });
    assert.equal(response.status, 200);
    assert(sentEmails.some((item) => item.subject === "Welcome to Nexora AI"));
    assert(sentEmails.some((item) => item.subject === "Nexora AI: Password changed"));
});

test("Resend failure creates no usable OTP and does not reveal account eligibility", async () => {
    failNextEmail = true;
    const email = "provider-failure-test@example.com";
    const response = await post("/auth/email/start", {
        mode: "signup",
        email,
        password: "StrongPass123",
        name: "Test User",
        age: 25
    });
    assert.equal(response.status, 202);
    assert.match(response.body.message, /If the account details are eligible/);
    const verification = await post("/auth/email/verify", { mode: "signup", email, code: "123456" });
    assert.equal(verification.status, 400);
    assert.match(verification.body.message, /invalid or expired/);
});

test("Google authentication endpoint remains mounted when Google credentials are absent", async () => {
    const response = await post("/auth/google", { credential: "unused-test-credential" });
    assert.equal(response.status, 503);
    assert.match(response.body.message, /Google sign-in is not configured/);
});
