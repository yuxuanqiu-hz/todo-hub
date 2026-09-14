'use strict';

/**
 * 本地联调：静态页 + /api/auth + /api/todos。
 * 不会打印密码。未配置 SITE_PASSWORD 时接口会拒绝访问。
 */

const fs = require('fs');
const http = require('http');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const text = fs.readFileSync(filePath, 'utf8');
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] == null) process.env[key] = value;
  }
}

loadEnvFile(path.join(ROOT, '.env.local'));
loadEnvFile(path.join(ROOT, '.env'));

const auth = require('../api/auth');
const todos = require('../api/todos');

function send(res, status, body, headers) {
  res.writeHead(status, headers);
  res.end(body);
}

function wrapRes(res) {
  return {
    setHeader(name, value) {
      res.setHeader(name, value);
    },
    status(code) {
      res.statusCode = code;
      return this;
    },
    json(payload) {
      if (!res.getHeader('Content-Type')) {
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
      }
      res.end(JSON.stringify(payload));
    },
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function adapt(handler, req, res, url) {
  req.query = Object.fromEntries(url.searchParams);
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'DELETE') {
    const raw = await readBody(req);
    if (raw) {
      try {
        req.body = JSON.parse(raw);
      } catch {
        req.body = {};
      }
    } else {
      req.body = {};
    }
  }
  await handler(req, wrapRes(res));
  if (!res.writableEnded) res.end();
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/api/auth') {
      await adapt(auth, req, res, url);
      return;
    }
    if (url.pathname === '/api/todos') {
      await adapt(todos, req, res, url);
      return;
    }
    if (url.pathname === '/' || url.pathname === '/index.html') {
      const html = fs.readFileSync(path.join(ROOT, 'index.html'));
      send(res, 200, html, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return;
    }
    send(res, 404, 'Not found', { 'Content-Type': 'text/plain; charset=utf-8' });
  } catch (err) {
    send(res, 500, JSON.stringify({ error: 'local server error' }), {
      'Content-Type': 'application/json; charset=utf-8',
    });
    console.error(err && err.message ? err.message : 'local server error');
  }
});

const port = Number(process.env.PORT || 4173);
server.listen(port, '127.0.0.1', () => {
  const configured = Boolean(process.env.SITE_PASSWORD);
  console.log(`local server http://127.0.0.1:${port}`);
  console.log(configured ? 'SITE_PASSWORD is set' : 'SITE_PASSWORD is missing; access will be denied');
});
