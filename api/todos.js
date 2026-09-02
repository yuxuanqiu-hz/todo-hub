// Vercel Serverless Function
// 依赖：项目里挂一个 "KV" / "Upstash for Redis" 存储，
// Vercel 会自动注入 KV_REST_API_URL 和 KV_REST_API_TOKEN 这两个环境变量。
// 如果你连接后变量名不一样，去 Vercel 项目 Settings -> Environment Variables 里核对，
// 改成下面这两个名字，或者把下面两行改成实际的变量名。

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

async function kv(cmd) {
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

module.exports = async function handler(req, res) {
  if (!KV_URL || !KV_TOKEN) {
    res.status(500).json({
      error: '缺少 KV_REST_API_URL / KV_REST_API_TOKEN 环境变量，先在 Vercel 项目里连接一个 KV 存储',
    });
    return;
  }

  try {
    if (req.method === 'GET') {
      const ids = (await kv(['smembers', 'todo:ids'])) || [];
      if (ids.length === 0) {
        res.status(200).json([]);
        return;
      }
      const values = await Promise.all(ids.map((id) => kv(['get', `todo:${id}`])));
      const todos = values.filter(Boolean).map((v) => JSON.parse(v));
      res.status(200).json(todos);
      return;
    }

  if (req.method === 'POST') {
    const todo = req.body;
    if (!todo || !todo.id) {
      res.status(400).json({ error: 'missing id' });
      return;
    }
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
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
