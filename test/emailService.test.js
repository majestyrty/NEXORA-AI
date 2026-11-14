import assert from "node:assert/strict";
import test from "node:test";
import {
    createEmailService,
    createVerificationChallenge,
    verifyVerificationCode
} from "../src/services/emailService.js";

const secret = "test-only-otp-secret-with-more-than-32-bytes";

test("verification challenge creates six-digit codes and validates only before expiry", () => {
    const now = 1_000_000;
    const { code, challenge } = createVerificationChallenge({ secret, now });

    assert.match(code, /^\d{6}$/);
    assert.equal(challenge.expiresAt, now + 10 * 60 * 1000);
    assert.notEqual(challenge.codeHash, code);
    assert.equal(verifyVerificationCode(challenge, code, { secret, now }).valid, true);
    assert.equal(verifyVerificationCode(challenge, code, { secret, now: challenge.expiresAt }).reason, "expired");
});

test("verification challenge rejects wrong codes and enforces the attempt limit", () => {
    const { challenge } = createVerificationChallenge({ secret, now: 50, maxAttempts: 2 });

    assert.equal(verifyVerificationCode(challenge, "000000", { secret, now: 51 }).reason, "invalid");
    assert.equal(challenge.attemptsRemaining, 1);
    assert.equal(verifyVerificationCode(challenge, "000000", { secret, now: 52 }).reason, "attempts");
    assert.equal(challenge.attemptsRemaining, 0);
    assert.equal(verifyVerificationCode(challenge, "123456", { secret, now: 53 }).reason, "attempts");
});

test("email service uses Resend and sends branded verification content", async () => {
    let captured;
    let createdWithKey;
    const service = createEmailService({
        getEnv: (name) => ({
            RESEND_API_KEY: "test-api-key",
            EMAIL_FROM: "Nexora AI <onboarding@resend.dev>"
        })[name],
        createClient(apiKey) {
            createdWithKey = apiKey;
            return {
                emails: {
                    async send(payload) {
                        captured = payload;
                        return { data: { id: "email_test_id" }, error: null };
                    }
                }
            };
        }
    });

    const result = await service.sendVerificationCode("user@example.com", "123456");
    assert.equal(result.id, "email_test_id");
    assert.equal(createdWithKey, "test-api-key");
    assert.equal(captured.from, "Nexora AI <onboarding@resend.dev>");
    assert.deepEqual(captured.to, ["user@example.com"]);
    assert.match(captured.html, /NEXORA AI/);
    assert.match(captured.html, /123456/);
    assert.match(captured.text, /expires in 10 minutes/);
});

test("email service rejects provider failures without reporting success", async () => {
    const service = createEmailService({
        getEnv: (name) => ({
            RESEND_API_KEY: "test-api-key",
            EMAIL_FROM: "Nexora AI <onboarding@resend.dev>"
        })[name],
        createClient: () => ({
            emails: {
                async send() {
                    return { data: null, error: { message: "provider failure" } };
                }
            }
        })
    });

    await assert.rejects(
        service.sendVerificationCode("user@example.com", "123456"),
        { code: "EMAIL_PROVIDER_ERROR" }
    );
});

test("email service rejects invalid recipients and malformed verification codes", async () => {
    let sendCount = 0;
    const service = createEmailService({
        getEnv: (name) => ({
            RESEND_API_KEY: "test-api-key",
            EMAIL_FROM: "Nexora AI <onboarding@resend.dev>"
        })[name],
        createClient: () => ({
            emails: {
                async send() {
                    sendCount += 1;
                    return { data: { id: "email_test_id" }, error: null };
                }
            }
        })
    });

    await assert.rejects(service.sendVerificationCode("not-an-email", "123456"), { code: "INVALID_EMAIL" });
    await assert.rejects(service.sendVerificationCode("user@example.com", "not-a-code"), { code: "INVALID_EMAIL_CONTENT" });
    assert.equal(sendCount, 0);
});

test("email service renders password reset, welcome, and security messages", async () => {
    const subjects = [];
    let welcomeHtml = "";
    const service = createEmailService({
        getEnv: (name) => ({
            RESEND_API_KEY: "test-api-key",
            EMAIL_FROM: "Nexora AI <onboarding@resend.dev>"
        })[name],
        createClient: () => ({
            emails: {
                async send(payload) {
                    subjects.push(payload.subject);
                    if (payload.subject === "Welcome to Nexora AI") welcomeHtml = payload.html;
                    return { data: { id: `email_${subjects.length}` }, error: null };
                }
            }
        })
    });

    await service.sendPasswordResetCode("user@example.com", "987654");
    await service.sendWelcomeEmail("user@example.com", "<New user>");
    await service.sendSecurityNotification("user@example.com", {
        title: "Password changed",
        message: "Your password was changed."
    });

    assert.deepEqual(subjects, [
        "Reset your Nexora AI password",
        "Welcome to Nexora AI",
        "Nexora AI: Password changed"
    ]);
    assert(welcomeHtml.includes("&lt;New user&gt;"));
    assert(!welcomeHtml.includes("<New user>"));
});
