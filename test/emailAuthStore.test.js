import assert from "node:assert/strict";
import test from "node:test";
import { newDb } from "pg-mem";
import { createPostgresEmailAuthStore } from "../src/services/emailAuthStore.js";

test("PostgreSQL email auth store persists accounts, challenges, cooldowns and one-time consumption", async () => {
    const database = newDb({ noAstCoverageCheck: true });
    const Pool = database.adapters.createPg().Pool;
    const poolA = new Pool();
    const poolB = new Pool();
    const storeA = createPostgresEmailAuthStore(poolA);
    const storeB = createPostgresEmailAuthStore(poolB);
    await storeA.initialize();
    await storeB.initialize();

    const account = {
        email: "stored-user@example.com",
        name: "Stored User",
        age: 24,
        passwordHash: "salt:password-hash"
    };
    assert.equal(await storeA.createAccount(account), true);
    assert.equal(await storeB.createAccount(account), false);
    assert.deepEqual(await storeB.getAccount(account.email), account);

    const now = Date.now();
    const challenge = {
        email: account.email,
        purpose: "signup",
        codeHash: "first-code-hash",
        payload: { name: account.name, passwordHash: account.passwordHash },
        createdAt: now,
        expiresAt: now + 600000,
        attemptsRemaining: 5,
        resendAfter: now + 60000
    };
    assert.equal(await storeA.claimChallenge(challenge), true);
    assert.equal(await storeB.markChallengeDelivered(account.email, "signup", challenge.codeHash), true);
    assert.deepEqual(await storeB.getChallenge(account.email, "signup"), {
        codeHash: challenge.codeHash,
        payload: challenge.payload,
        createdAt: challenge.createdAt,
        expiresAt: challenge.expiresAt,
        attemptsRemaining: 5
    });

    assert.equal(await storeA.decrementChallengeAttempts(account.email, "signup", challenge.codeHash), 4);
    assert.deepEqual(
        await storeB.consumeChallenge(account.email, "signup", challenge.codeHash),
        challenge.payload
    );
    assert.equal(await storeA.consumeChallenge(account.email, "signup", challenge.codeHash), null);

    assert.equal(await storeB.updatePasswordHash(account.email, "new-salt:new-hash"), true);
    assert.equal((await storeA.getAccount(account.email)).passwordHash, "new-salt:new-hash");

    await poolA.end();
    await poolB.end();
});

test("PostgreSQL challenge removal is conditional on the code hash", async () => {
    const database = newDb({ noAstCoverageCheck: true });
    const Pool = database.adapters.createPg().Pool;
    const pool = new Pool();
    const store = createPostgresEmailAuthStore(pool);
    await store.initialize();

    const now = Date.now();
    const challenge = {
        email: "conditional@example.com",
        purpose: "reset",
        codeHash: "active-hash",
        payload: {},
        createdAt: now,
        expiresAt: now + 600000,
        attemptsRemaining: 5,
        resendAfter: now + 60000
    };
    await store.claimChallenge(challenge);
    await store.markChallengeDelivered(challenge.email, challenge.purpose, challenge.codeHash);
    await store.deleteChallenge(challenge.email, challenge.purpose, "stale-hash");
    assert.equal((await store.getChallenge(challenge.email, challenge.purpose)).codeHash, "active-hash");
    await store.deleteChallenge(challenge.email, challenge.purpose, "active-hash");
    assert.equal(await store.getChallenge(challenge.email, challenge.purpose), null);

    await pool.end();
});
