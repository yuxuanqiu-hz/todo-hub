'use strict';

const crypto = require('crypto');

const COOKIE_NAME = 'th_session';
const MAX_AGE_SEC = 14 * 24 * 60 * 60;
const TOKEN_VERSION = 'v1';

function getSitePassword() {
  return String(process.env.SITE_PASSWORD || '');
}

function isConfigured() {
  return getSitePassword().length > 0;
}

/**
 * 优先使用独立的 SITE_SESSION_SECRET。
 * 未设置时从 SITE_PASSWORD 派生，便于先跑起来；
 * 改密码会换掉派生密钥，但密码一旦泄露，历史签名也可被伪造。
 */
function getSessionSecret() {
  const explicit = String(process.env.SITE_SESSION_SECRET || '');
  if (explicit) return explicit;
  const password = getSitePassword();
  if (!password) return '';
  return crypto
    .createHmac('sha256', 'todo-hub-derived-session')
    .update(password)
    .digest('hex');
}

function usesDerivedSessionSecret() {
  return isConfigured() && !String(process.env.SITE_SESSION_SECRET || '');
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest();
}

function timingSafeEqualBytes(a, b) {
  if (!Buffer.isBuffer(a) || !Buffer.isBuffer(b) || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function timingSafeEqualString(a, b) {
  return timingSafeEqualBytes(sha256(a), sha256(b));
}

function passwordStamp() {
  return sha256(getSitePassword()).subarray(0, 16).toString('hex');
}

function signPayload(payload) {
  return crypto.createHmac('sha256', getSessionSecret()).update(payload).digest('hex');
}

function createToken(now = Date.now()) {
  if (!isConfigured() || !getSessionSecret()) {
    throw new Error('session is not configured');
  }
  const payload = `${TOKEN_VERSION}.${now + MAX_AGE_SEC * 1000}.${passwordStamp()}`;
  return `${payload}.${signPayload(payload)}`;
}

function verifyToken(token, now = Date.now()) {
  if (!isConfigured() || !getSessionSecret()) return false;
  if (typeof token !== 'string' || token.length < 20 || token.length > 512) return false;
  const lastDot = token.lastIndexOf('.');
  if (lastDot <= 0) return false;
  const payload = token.slice(0, lastDot);
  const sig = token.slice(lastDot + 1);
  if (!/^[0-9a-f]+$/i.test(sig)) return false;
  const expected = signPayload(payload);
  if (!timingSafeEqualString(sig, expected)) return false;
  const parts = payload.split('.');
  if (parts.length !== 3 || parts[0] !== TOKEN_VERSION) return false;
  const exp = Number(parts[1]);
  if (!Number.isFinite(exp) || now > exp) return false;
  if (!timingSafeEqualString(parts[2], passwordStamp())) return false;
  return true;
}

function verifyPassword(password) {
  if (!isConfigured()) return false;
  if (typeof password !== 'string' || password.length === 0) return false;
  return timingSafeEqualString(password, getSitePassword());
}

function parseCookies(req) {
  const header = req.headers && (req.headers.cookie || req.headers.Cookie);
  const out = {};
  if (!header || typeof header !== 'string') return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const raw = part.slice(idx + 1).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(raw);
    } catch {
      out[key] = raw;
    }
  }
  return out;
}

function useSecureCookie() {
  return Boolean(process.env.VERCEL) || process.env.NODE_ENV === 'production';
}

function serializeCookie(value, { maxAge }) {
  const parts = [
    `${COOKIE_NAME}=${value}`,
    'Path=/',
    `Max-Age=${maxAge}`,
    'SameSite=Lax',
    'HttpOnly',
  ];
  if (useSecureCookie()) parts.push('Secure');
  return parts.join('; ');
}

function setNoStore(res) {
  res.setHeader('Cache-Control', 'no-store');
}

function setSessionCookie(res, token) {
  res.setHeader('Set-Cookie', serializeCookie(encodeURIComponent(token), { maxAge: MAX_AGE_SEC }));
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', serializeCookie('', { maxAge: 0 }));
}

function readSessionToken(req) {
  return parseCookies(req)[COOKIE_NAME] || '';
}

function hasValidSession(req) {
  return verifyToken(readSessionToken(req));
}

function requireSession(req, res) {
  setNoStore(res);
  if (!isConfigured()) {
    res.status(503).json({
      error: 'unconfigured',
      message: '站点未配置 SITE_PASSWORD，拒绝访问',
    });
    return false;
  }
  if (!hasValidSession(req)) {
    res.status(401).json({ error: 'unauthorized' });
    return false;
  }
  return true;
}

module.exports = {
  COOKIE_NAME,
  MAX_AGE_SEC,
  clearSessionCookie,
  createToken,
  getSessionSecret,
  hasValidSession,
  isConfigured,
  parseCookies,
  requireSession,
  setNoStore,
  setSessionCookie,
  usesDerivedSessionSecret,
  verifyPassword,
  verifyToken,
};
