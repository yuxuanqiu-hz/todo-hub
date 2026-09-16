// Vercel Serverless Function
// 依赖：项目里挂一个 "KV" / "Upstash for Redis" 存储，
// Vercel 会自动注入 KV_REST_API_URL 和 KV_REST_API_TOKEN 这两个环境变量。
// 如果你连接后变量名不一样，去 Vercel 项目 Settings -> Environment Variables 里核对，
// 改成下面这两个名字，或者把下面两行改成实际的变量名。

const { requireSession } = require('../lib/session');
const {
  fetchQuotes,
  mergeQuoteMarks,
  openHoldingRequests,
  parseQuoteKeys,
} = require('../lib/quotes');
const {
  deleteAndValidate,
  sanitizeMarks,
  upsertAndValidate,
} = require('../lib/trades');

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

// 文件以 base64 存在 KV 里。Vercel Hobby 请求体约 4.5MB，
// 这里限制原始文件 1.5MB（base64 约 2MB），避免同步接口被撑爆。
const MAX_FILE_BYTES = 1.5 * 1024 * 1024;
const MAX_FILEDATA_CHARS = Math.ceil(MAX_FILE_BYTES * 4 / 3) + 64;

function parseStored(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch { return null; }
}

function normalizeEntity(entity) {
  return entity === '个人' ? '家庭' : entity;
}

async function kv(cmd) {
  // SET 走 POST JSON，避免大文件走 URL path 被截断。
  // 其余命令仍可用同一 POST 接口，和 Upstash REST 兼容。
  const usePost = cmd[0] === 'set' || (typeof cmd[cmd.length - 1] === 'string' && cmd[cmd.length - 1].length > 1800);
  if (usePost) {
    const res = await fetch(KV_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${KV_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(cmd),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`KV error ${res.status}: ${text}`);
    }
    const data = await res.json();
    return data.result;
  }

  const path = cmd.map((c) => encodeURIComponent(c)).join('/');
  const res = await fetch(`${KV_URL}/${path}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`KV error ${res.status}: ${text}`);
  }
  const data = await res.json();
  return data.result;
}

async function handleTodos(req, res) {
  if (req.method === 'GET') {
    const ids = (await kv(['smembers', 'todo:ids'])) || [];
    if (ids.length === 0) {
      res.status(200).json([]);
      return;
    }
    const values = await Promise.all(ids.map((id) => kv(['get', `todo:${id}`])));
    const todos = [];
    for (const v of values) {
      const t = parseStored(v);
      if (!t) continue;
      if (t.entity === '个人') {
        t.entity = '家庭';
        await kv(['set', `todo:${t.id}`, JSON.stringify(t)]);
      }
      todos.push(t);
    }
    res.status(200).json(todos);
    return;
  }

  if (req.method === 'POST') {
    const todo = req.body;
    if (!todo || !todo.id) {
      res.status(400).json({ error: 'missing id' });
      return;
    }
    todo.entity = normalizeEntity(todo.entity);
    await kv(['set', `todo:${todo.id}`, JSON.stringify(todo)]);
    await kv(['sadd', 'todo:ids', todo.id]);
    res.status(200).json({ ok: true });
    return;
  }

  if (req.method === 'DELETE') {
    const id = req.query.id;
    if (!id) {
      res.status(400).json({ error: 'missing id' });
      return;
    }
    await kv(['del', `todo:${id}`]);
    await kv(['srem', 'todo:ids', id]);
    res.status(200).json({ ok: true });
    return;
  }

  res.status(405).json({ error: 'method not allowed' });
}

async function handleKb(req, res) {
  if (req.method === 'GET') {
    const ids = (await kv(['smembers', 'kb:ids'])) || [];
    if (ids.length === 0) {
      res.status(200).json([]);
      return;
    }
    const values = await Promise.all(ids.map((id) => kv(['get', `kb:${id}`])));
    const items = values.map(parseStored).filter(Boolean).map((item) => {
      const { fileData, ...meta } = item;
      return { ...meta, hasFile: !!(item.hasFile || fileData) };
    });
    res.status(200).json(items);
    return;
  }

  if (req.method === 'POST') {
    const item = req.body;
    if (!item || !item.id) {
      res.status(400).json({ error: 'missing id' });
      return;
    }
    const { fileData, ...rest } = item;
    if (fileData != null && String(fileData).length > MAX_FILEDATA_CHARS) {
      res.status(413).json({ error: 'file too large', maxBytes: MAX_FILE_BYTES });
      return;
    }
    if (fileData) {
      await kv(['set', `kb:file:${item.id}`, JSON.stringify({
        fileData,
        fileName: item.fileName || '',
        fileMime: item.fileMime || 'application/octet-stream',
        fileSize: item.fileSize || 0,
      })]);
    }
    const meta = {
      ...rest,
      hasFile: item.category === 'file' && !!(fileData || rest.hasFile),
    };
    delete meta.fileData;
    await kv(['set', `kb:${item.id}`, JSON.stringify(meta)]);
    await kv(['sadd', 'kb:ids', item.id]);
    res.status(200).json({ ok: true });
    return;
  }

  if (req.method === 'DELETE') {
    const id = req.query.id;
    if (!id) {
      res.status(400).json({ error: 'missing id' });
      return;
    }
    await kv(['del', `kb:${id}`]);
    await kv(['del', `kb:file:${id}`]);
    await kv(['srem', 'kb:ids', id]);
    res.status(200).json({ ok: true });
    return;
  }

  res.status(405).json({ error: 'method not allowed' });
}

async function handleKbFile(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'method not allowed' });
    return;
  }
  const id = req.query.id;
  if (!id) {
    res.status(400).json({ error: 'missing id' });
    return;
  }
  const stored = parseStored(await kv(['get', `kb:file:${id}`]));
  if (!stored || !stored.fileData) {
    res.status(404).json({ error: 'file not found' });
    return;
  }
  res.status(200).json(stored);
}

async function loadAllTrades() {
  const ids = (await kv(['smembers', 'trade:ids'])) || [];
  if (ids.length === 0) return [];
  const values = await Promise.all(ids.map((id) => kv(['get', `trade:${id}`])));
  return values.map(parseStored).filter(Boolean);
}

async function handleTrades(req, res) {
  if (req.method === 'GET') {
    res.status(200).json(await loadAllTrades());
    return;
  }

  if (req.method === 'POST') {
    const existing = await loadAllTrades();
    const result = upsertAndValidate(existing, req.body);
    if (!result.ok) {
      res.status(400).json({ error: result.error });
      return;
    }
    await kv(['set', `trade:${result.trade.id}`, JSON.stringify(result.trade)]);
    await kv(['sadd', 'trade:ids', result.trade.id]);
    res.status(200).json({ ok: true, trade: result.trade });
    return;
  }

  if (req.method === 'DELETE') {
    const id = req.query.id;
    if (!id) {
      res.status(400).json({ error: 'missing id' });
      return;
    }
    const existing = await loadAllTrades();
    const result = deleteAndValidate(existing, id);
    if (!result.ok) {
      res.status(400).json({ error: result.error });
      return;
    }
    await kv(['del', `trade:${id}`]);
    await kv(['srem', 'trade:ids', id]);
    res.status(200).json({ ok: true });
    return;
  }

  res.status(405).json({ error: 'method not allowed' });
}

async function handleTradeMarks(req, res) {
  if (req.method === 'GET') {
    const marks = parseStored(await kv(['get', 'trade:marks'])) || {};
    res.status(200).json(sanitizeMarks(marks));
    return;
  }

  if (req.method === 'POST') {
    const marks = sanitizeMarks(req.body);
    await kv(['set', 'trade:marks', JSON.stringify(marks)]);
    res.status(200).json({ ok: true, marks });
    return;
  }

  res.status(405).json({ error: 'method not allowed' });
}

function readQuoteInput(req) {
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  const keys = [];
  if (req.query && req.query.keys) keys.push(req.query.keys);
  if (Array.isArray(body.keys)) keys.push(...body.keys);
  else if (typeof body.keys === 'string') keys.push(body.keys);
  return { keys, items: body.items };
}

async function handleQuotes(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.status(405).json({ error: 'method not allowed' });
    return;
  }

  let requests = parseQuoteKeys(readQuoteInput(req));
  if (!requests.length && KV_URL && KV_TOKEN) {
    requests = openHoldingRequests(await loadAllTrades());
  }

  if (!requests.length) {
    res.status(200).json({
      quotes: {},
      failed: [],
      updatedAt: null,
      skipped: 'no-open-positions',
      marks: null,
    });
    return;
  }

  const result = await fetchQuotes(requests);
  let marks = null;
  if (KV_URL && KV_TOKEN && Object.keys(result.quotes).length) {
    const existing = sanitizeMarks(parseStored(await kv(['get', 'trade:marks'])) || {});
    marks = mergeQuoteMarks(existing, result.quotes);
    await kv(['set', 'trade:marks', JSON.stringify(marks)]);
  }

  res.status(200).json({
    quotes: result.quotes,
    failed: result.failed,
    updatedAt: result.updatedAt,
    marks,
  });
}

module.exports = async function handler(req, res) {
  if (!requireSession(req, res)) return;

  try {
    const resource = req.query.resource || 'todos';
    if (resource === 'quotes') {
      await handleQuotes(req, res);
      return;
    }

    if (!KV_URL || !KV_TOKEN) {
      res.status(500).json({
        error: '缺少 KV_REST_API_URL / KV_REST_API_TOKEN 环境变量，先在 Vercel 项目里连接一个 KV 存储',
      });
      return;
    }

    if (resource === 'kb') {
      await handleKb(req, res);
      return;
    }
    if (resource === 'kb-file') {
      await handleKbFile(req, res);
      return;
    }
    if (resource === 'trades') {
      await handleTrades(req, res);
      return;
    }
    if (resource === 'trade-marks') {
      await handleTradeMarks(req, res);
      return;
    }
    await handleTodos(req, res);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
