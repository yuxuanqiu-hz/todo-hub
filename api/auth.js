'use strict';

const {
  clearSessionCookie,
  createToken,
  hasValidSession,
  isConfigured,
  setNoStore,
  setSessionCookie,
  verifyPassword,
} = require('../lib/session');

module.exports = async function handler(req, res) {
  setNoStore(res);

  if (req.method === 'GET') {
    if (!isConfigured()) {
      res.status(503).json({
        error: 'unconfigured',
        message: '站点未配置 SITE_PASSWORD，拒绝访问',
      });
      return;
    }
    if (!hasValidSession(req)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    res.status(200).json({ ok: true });
    return;
  }

  if (req.method === 'POST') {
    if (!isConfigured()) {
      res.status(503).json({
        error: 'unconfigured',
        message: '站点未配置 SITE_PASSWORD，拒绝访问',
      });
      return;
    }
    const password = req.body && req.body.password;
    if (!verifyPassword(password)) {
      res.status(401).json({ error: 'invalid password' });
      return;
    }
    setSessionCookie(res, createToken());
    res.status(200).json({ ok: true });
    return;
  }

  if (req.method === 'DELETE') {
    clearSessionCookie(res);
    res.status(200).json({ ok: true });
    return;
  }

  res.status(405).json({ error: 'method not allowed' });
};
