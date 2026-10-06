// tests/env.js — runs before every test file (jest setupFiles).
// NODE_ENV=test → development-style cookies (SameSite=Lax, not Secure).
// TRUST_PROXY=1 → tests can give each simulated user its own client IP via
// X-Forwarded-For, so the per-IP auth rate limiter (10 / 15 min) applies per
// user exactly as in production instead of to the whole test file.
process.env.NODE_ENV = 'test';
process.env.TRUST_PROXY = '1';
process.env.JWT_SECRET ||= 'test_jwt_secret_at_least_32_characters_long';
process.env.FRONTEND_URL ||= 'http://localhost:3000';
process.env.ANALYST_INVITE_CODE = 'test-invite-code'; // L-11: ANALYST registration needs this code
