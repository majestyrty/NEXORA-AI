const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS nexora_email_accounts (
    email text PRIMARY KEY,
    name text NOT NULL,
    age integer,
    password_hash text NOT NULL,
    created_at timestamptz NOT NULL,
    verified_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS nexora_email_challenges (
    email text NOT NULL,
    purpose text NOT NULL,
    code_hash text NOT NULL,
    payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL,
    attempts_remaining integer NOT NULL,
    resend_after timestamptz NOT NULL,
    delivered_at timestamptz,
    PRIMARY KEY (email, purpose)
);

CREATE INDEX IF NOT EXISTS nexora_email_challenges_expiry_idx
    ON nexora_email_challenges (expires_at);
`;

const toEpochMilliseconds = (date) => new Date(date).getTime();

export function createPostgresEmailAuthStore(pool) {
    let initialization;

    return {
        persistent: true,
        async initialize() {
            if (!initialization) {
                initialization = pool.query(SCHEMA_SQL).catch((error) => {
                    initialization = null;
                    throw error;
                });
            }
            await initialization;
        },
        async getAccount(email) {
            const result = await pool.query(
                `SELECT email, name, age, password_hash AS "passwordHash"
                 FROM nexora_email_accounts WHERE email = $1`,
                [email]
            );
            return result.rows[0] || null;
        },
        async createAccount(account) {
            try {
                const result = await pool.query(
                    `INSERT INTO nexora_email_accounts (email, name, age, password_hash, created_at, verified_at)
                     VALUES ($1, $2, $3, $4, now(), now())
                     RETURNING email`,
                    [account.email, account.name, account.age, account.passwordHash]
                );
                return result.rowCount === 1;
            } catch (error) {
                if (error.code === "23505") return false;
                throw error;
            }
        },
        async updatePasswordHash(email, passwordHash) {
            const result = await pool.query(
                `UPDATE nexora_email_accounts
                 SET password_hash = $2
                 WHERE email = $1
                 RETURNING email`,
                [email, passwordHash]
            );
            return result.rowCount === 1;
        },
        async claimChallenge(challenge) {
            const result = await pool.query(
                `INSERT INTO nexora_email_challenges
                    (email, purpose, code_hash, payload, created_at, expires_at,
                     attempts_remaining, resend_after, delivered_at)
                 VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, NULL)
                 ON CONFLICT (email, purpose) DO UPDATE
                 SET code_hash = EXCLUDED.code_hash,
                     payload = EXCLUDED.payload,
                     created_at = EXCLUDED.created_at,
                     expires_at = EXCLUDED.expires_at,
                     attempts_remaining = EXCLUDED.attempts_remaining,
                     resend_after = EXCLUDED.resend_after,
                     delivered_at = NULL
                 WHERE nexora_email_challenges.resend_after <= $5
                 RETURNING email`,
                [
                    challenge.email,
                    challenge.purpose,
                    challenge.codeHash,
                    JSON.stringify(challenge.payload),
                    new Date(challenge.createdAt),
                    new Date(challenge.expiresAt),
                    challenge.attemptsRemaining,
                    new Date(challenge.resendAfter)
                ]
            );
            return result.rowCount === 1;
        },
        async markChallengeDelivered(email, purpose, codeHash) {
            const result = await pool.query(
                `UPDATE nexora_email_challenges SET delivered_at = now()
                 WHERE email = $1 AND purpose = $2 AND code_hash = $3
                 RETURNING email`,
                [email, purpose, codeHash]
            );
            return result.rowCount === 1;
        },
        async deleteChallenge(email, purpose, codeHash) {
            await pool.query(
                `DELETE FROM nexora_email_challenges
                 WHERE email = $1 AND purpose = $2 AND code_hash = $3`,
                [email, purpose, codeHash]
            );
        },
        async getChallenge(email, purpose) {
            const result = await pool.query(
                `SELECT code_hash AS "codeHash", payload, created_at AS "createdAt",
                        expires_at AS "expiresAt", attempts_remaining AS "attemptsRemaining"
                 FROM nexora_email_challenges
                 WHERE email = $1 AND purpose = $2 AND delivered_at IS NOT NULL`,
                [email, purpose]
            );
            const row = result.rows[0];
            if (!row) return null;
            return {
                codeHash: row.codeHash,
                payload: typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload,
                createdAt: toEpochMilliseconds(row.createdAt),
                expiresAt: toEpochMilliseconds(row.expiresAt),
                attemptsRemaining: row.attemptsRemaining
            };
        },
        async decrementChallengeAttempts(email, purpose, codeHash) {
            const result = await pool.query(
                `UPDATE nexora_email_challenges
                 SET attempts_remaining = attempts_remaining - 1
                 WHERE email = $1 AND purpose = $2 AND code_hash = $3
                   AND attempts_remaining > 0
                 RETURNING attempts_remaining`,
                [email, purpose, codeHash]
            );
            const remaining = result.rows[0]?.attempts_remaining;
            if (remaining === 0) {
                await this.deleteChallenge(email, purpose, codeHash);
            }
            return remaining ?? 0;
        },
        async consumeChallenge(email, purpose, codeHash) {
            const result = await pool.query(
                `DELETE FROM nexora_email_challenges
                 WHERE email = $1 AND purpose = $2 AND code_hash = $3
                   AND delivered_at IS NOT NULL
                   AND expires_at > now()
                   AND attempts_remaining > 0
                 RETURNING payload`,
                [email, purpose, codeHash]
            );
            const payload = result.rows[0]?.payload;
            if (typeof payload === "string") return JSON.parse(payload);
            return payload || null;
        }
    };
}

export function createMemoryEmailAuthStore() {
    const accounts = new Map();
    const challenges = new Map();

    return {
        persistent: false,
        async initialize() {},
        async getAccount(email) {
            return accounts.get(email) || null;
        },
        async createAccount(account) {
            if (accounts.has(account.email)) return false;
            accounts.set(account.email, { ...account });
            return true;
        },
        async updatePasswordHash(email, passwordHash) {
            const account = accounts.get(email);
            if (!account) return false;
            account.passwordHash = passwordHash;
            return true;
        },
        async claimChallenge(challenge) {
            const key = `${challenge.purpose}:${challenge.email}`;
            const existing = challenges.get(key);
            if (existing && existing.resendAfter > challenge.createdAt) return false;
            challenges.set(key, { ...challenge });
            return true;
        },
        async markChallengeDelivered(email, purpose, codeHash) {
            const key = `${purpose}:${email}`;
            const challenge = challenges.get(key);
            if (!challenge || challenge.codeHash !== codeHash) return false;
            challenge.deliveredAt = Date.now();
            return true;
        },
        async deleteChallenge(email, purpose, codeHash) {
            const key = `${purpose}:${email}`;
            const challenge = challenges.get(key);
            if (challenge?.codeHash === codeHash) challenges.delete(key);
        },
        async getChallenge(email, purpose) {
            const challenge = challenges.get(`${purpose}:${email}`);
            if (!challenge?.deliveredAt) return null;
            return {
                codeHash: challenge.codeHash,
                payload: challenge.payload,
                createdAt: challenge.createdAt,
                expiresAt: challenge.expiresAt,
                attemptsRemaining: challenge.attemptsRemaining
            };
        },
        async decrementChallengeAttempts(email, purpose, codeHash) {
            const key = `${purpose}:${email}`;
            const challenge = challenges.get(key);
            if (!challenge || challenge.codeHash !== codeHash || challenge.attemptsRemaining <= 0) return 0;
            challenge.attemptsRemaining -= 1;
            const remaining = challenge.attemptsRemaining;
            if (remaining === 0) challenges.delete(key);
            return remaining;
        },
        async consumeChallenge(email, purpose, codeHash) {
            const key = `${purpose}:${email}`;
            const challenge = challenges.get(key);
            if (!challenge || challenge.codeHash !== codeHash || !challenge.deliveredAt ||
                challenge.expiresAt <= Date.now() || challenge.attemptsRemaining <= 0) return null;
            challenges.delete(key);
            return challenge.payload;
        }
    };
}
