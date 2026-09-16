'use strict';

const {
  MARKETS,
  computePositions,
  normalizeSymbol,
  sanitizeMarks,
} = require('./trades');

const MAX_SYMBOLS = 40;
const YAHOO_BATCH = 20;
const FETCH_TIMEOUT_MS = 4000;
const YAHOO_SPARK = 'https://query1.finance.yahoo.com/v7/finance/spark';
const TENCENT_QT = 'https://qt.gtimg.cn/q=';
const USER_AGENT = 'Mozilla/5.0 (compatible; todo-hub-quotes/1.0)';

function toYahooSymbol(market, symbol) {
  const sym = normalizeSymbol(market, symbol);
  if (!sym) return '';
  if (market === 'A') {
    const head = sym[0];
    if (head === '0' || head === '2' || head === '3') return `${sym}.SZ`;
    if (head === '4' || head === '8') return `${sym}.BJ`;
    return `${sym}.SS`;
  }
  if (market === 'HK') {
    const digits = String(sym).replace(/\D/g, '');
    if (!digits) return `${sym}.HK`;
    const stripped = digits.replace(/^0+/, '') || '0';
    return `${stripped.padStart(4, '0')}.HK`;
  }
  return String(sym).replace(/\./g, '-');
}

function toTencentSymbol(market, symbol) {
  const sym = normalizeSymbol(market, symbol);
  if (!sym) return '';
  if (market === 'A') {
    const head = sym[0];
    if (head === '0' || head === '2' || head === '3') return `sz${sym}`;
    if (head === '4' || head === '8') return `bj${sym}`;
    return `sh${sym}`;
  }
  if (market === 'HK') return `hk${sym}`;
  return `us${String(sym).replace(/\./g, '-')}`;
}

function parseQuoteKeys(input) {
  const raw = [];
  if (!input) return [];
  if (Array.isArray(input.keys)) raw.push(...input.keys);
  else if (typeof input.keys === 'string') raw.push(...input.keys.split(/[,\s]+/));
  if (Array.isArray(input.items)) {
    for (const item of input.items) {
      if (!item) continue;
      if (item.market && item.symbol) raw.push(`${item.market}:${item.symbol}`);
    }
  }
  const seen = new Set();
  const out = [];
  for (const value of raw) {
    const text = String(value || '').trim().toUpperCase();
    const match = text.match(/^(A|HK|US):(.+)$/);
    if (!match) continue;
    const market = match[1];
    if (!MARKETS[market]) continue;
    const symbol = normalizeSymbol(market, match[2]);
    if (!symbol) continue;
    const key = `${market}:${symbol}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      key,
      market,
      symbol,
      yahoo: toYahooSymbol(market, symbol),
      tencent: toTencentSymbol(market, symbol),
    });
    if (out.length >= MAX_SYMBOLS) break;
  }
  return out;
}

function openHoldingRequests(trades) {
  const { positions } = computePositions(trades || []);
  return parseQuoteKeys({
    keys: positions.filter((p) => p.qty > 0).map((p) => p.key),
  });
}

function mergeQuoteMarks(existing, quotes) {
  const next = { ...sanitizeMarks(existing) };
  for (const [key, price] of Object.entries(quotes || {})) {
    const n = Number(price);
    if (!Number.isFinite(n) || n <= 0) continue;
    if (!/^(A|HK|US):.+$/.test(key)) continue;
    next[key] = n;
  }
  return sanitizeMarks(next);
}

function priceFromYahooMeta(meta) {
  if (!meta || typeof meta !== 'object') return null;
  for (const field of [
    'regularMarketPrice',
    'regularMarketPreviousClose',
    'previousClose',
    'chartPreviousClose',
  ]) {
    const n = Number(meta[field]);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

async function fetchWithTimeout(url, timeoutMs, fetchImpl) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetchImpl(url, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/json, text/plain;q=0.9,*/*;q=0.8',
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

function matchYahooRequest(batch, yahooSymbol) {
  const exact = batch.find((r) => r.yahoo === yahooSymbol);
  if (exact) return exact;
  const compact = String(yahooSymbol || '').replace(/^0+/, '');
  return batch.find((r) => String(r.yahoo || '').replace(/^0+/, '') === compact) || null;
}

async function fetchYahooSpark(requests, fetchImpl) {
  const quotes = {};
  for (let i = 0; i < requests.length; i += YAHOO_BATCH) {
    const batch = requests.slice(i, i + YAHOO_BATCH);
    const symbols = batch.map((r) => r.yahoo).filter(Boolean);
    if (!symbols.length) continue;
    const url = `${YAHOO_SPARK}?symbols=${encodeURIComponent(symbols.join(','))}&range=1d&interval=1d`;
    try {
      const res = await fetchWithTimeout(url, FETCH_TIMEOUT_MS, fetchImpl);
      if (!res.ok) continue;
      const data = await res.json();
      const results = (((data || {}).spark || {}).result) || [];
      for (const item of results) {
        const resp = item && Array.isArray(item.response) ? item.response[0] : null;
        const price = priceFromYahooMeta(resp && resp.meta);
        if (price == null) continue;
        const req = matchYahooRequest(batch, item.symbol);
        if (!req || quotes[req.key] != null) continue;
        quotes[req.key] = price;
      }
    } catch {
      // 整批失败时交给腾讯兜底，不清空已成功的报价
    }
  }
  return quotes;
}

function parseTencentBody(text) {
  const out = {};
  for (const part of String(text || '').split(';')) {
    const match = part.match(/v_([^=]+)="([^"]*)"/);
    if (!match) continue;
    const price = Number(match[2].split('~')[3]);
    if (Number.isFinite(price) && price > 0) out[match[1]] = price;
  }
  return out;
}

async function readResponseText(res) {
  if (typeof res.text === 'function') return res.text();
  if (typeof res.arrayBuffer === 'function') {
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.toString('latin1');
  }
  return '';
}

async function fetchTencent(requests, fetchImpl) {
  const quotes = {};
  if (!requests.length) return quotes;
  const codes = requests.map((r) => r.tencent).filter(Boolean);
  if (!codes.length) return quotes;
  const url = `${TENCENT_QT}${codes.join(',')}`;
  try {
    const res = await fetchWithTimeout(url, FETCH_TIMEOUT_MS, fetchImpl);
    if (!res.ok) return quotes;
    const parsed = parseTencentBody(await readResponseText(res));
    for (const req of requests) {
      if (parsed[req.tencent] != null) quotes[req.key] = parsed[req.tencent];
    }
  } catch {
    // 腾讯失败则该批保持 missing
  }
  return quotes;
}

async function fetchQuotes(requests, { fetchImpl, now = Date.now() } = {}) {
  const impl = fetchImpl || global.fetch;
  if (typeof impl !== 'function') {
    return {
      quotes: {},
      failed: (requests || []).map((r) => ({
        key: r.key,
        market: r.market,
        symbol: r.symbol,
        error: '当前环境无法抓取行情',
      })),
      updatedAt: now,
    };
  }

  const list = (requests || []).slice(0, MAX_SYMBOLS);
  const quotes = {};
  if (!list.length) return { quotes, failed: [], updatedAt: now };

  Object.assign(quotes, await fetchYahooSpark(list, impl));
  const missing = list.filter((r) => quotes[r.key] == null);
  if (missing.length) {
    Object.assign(quotes, await fetchTencent(missing, impl));
  }

  const failed = [];
  for (const req of list) {
    if (quotes[req.key] == null) {
      failed.push({
        key: req.key,
        market: req.market,
        symbol: req.symbol,
        error: '未找到报价',
      });
    }
  }
  return { quotes, failed, updatedAt: now };
}

module.exports = {
  FETCH_TIMEOUT_MS,
  MAX_SYMBOLS,
  fetchQuotes,
  mergeQuoteMarks,
  openHoldingRequests,
  parseQuoteKeys,
  parseTencentBody,
  priceFromYahooMeta,
  toTencentSymbol,
  toYahooSymbol,
};
