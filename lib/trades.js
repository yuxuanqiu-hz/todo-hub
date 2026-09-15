'use strict';

const MARKETS = {
  A: { label: 'A股', currency: 'CNY', currencyLabel: '人民币' },
  HK: { label: '港股', currency: 'HKD', currencyLabel: '港币' },
  US: { label: '美股', currency: 'USD', currencyLabel: '美元' },
};

const QTY_EPS = 1e-8;

function toNumber(value, fallback = 0) {
  if (value === '' || value == null) return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function roundQty(n) {
  return Math.round((Number(n) || 0) * 1e8) / 1e8;
}

function roundMoney(n) {
  return Math.round((Number(n) || 0) * 1e8) / 1e8;
}

function isZeroQty(n) {
  return Math.abs(Number(n) || 0) < QTY_EPS;
}

function normalizeSymbol(market, symbol) {
  const raw = String(symbol || '').trim().toUpperCase();
  if (!raw) return '';
  if (market === 'A') {
    const digits = raw.replace(/\D/g, '');
    return digits ? digits.padStart(6, '0').slice(-6) : raw;
  }
  if (market === 'HK') {
    const digits = raw.replace(/\D/g, '');
    return digits ? digits.padStart(5, '0').slice(-5) : raw;
  }
  return raw;
}

function positionKey(market, symbol) {
  return `${market}:${normalizeSymbol(market, symbol)}`;
}

function sortTrades(trades) {
  return (trades || []).slice().sort((a, b) => {
    const ta = a.tradedAt || 0;
    const tb = b.tradedAt || 0;
    if (ta !== tb) return ta - tb;
    const ca = a.createdAt || 0;
    const cb = b.createdAt || 0;
    if (ca !== cb) return ca - cb;
    return String(a.id || '').localeCompare(String(b.id || ''));
  });
}

function sanitizeTrade(input, now = Date.now()) {
  if (!input || typeof input !== 'object') {
    return { error: '缺少交易记录' };
  }
  const market = String(input.market || '').toUpperCase();
  if (!MARKETS[market]) {
    return { error: '市场必须是 A股、港股或美股' };
  }
  const symbol = normalizeSymbol(market, input.symbol);
  if (!symbol) {
    return { error: '请填写股票代码' };
  }
  const side = String(input.side || '').toLowerCase();
  if (side !== 'buy' && side !== 'sell') {
    return { error: '方向必须是买入或卖出' };
  }
  const price = toNumber(input.price, NaN);
  if (!Number.isFinite(price) || price <= 0) {
    return { error: '成交价必须大于 0' };
  }
  const qty = toNumber(input.qty, NaN);
  if (!Number.isFinite(qty) || qty <= 0) {
    return { error: '数量必须大于 0' };
  }
  const fee = toNumber(input.fee, 0);
  const tax = toNumber(input.tax, 0);
  if (fee < 0) return { error: '手续费不能为负数' };
  if (tax < 0) return { error: '税费不能为负数' };

  let tradedAt = input.tradedAt;
  if (typeof tradedAt === 'string' && tradedAt.trim()) {
    const parsed = Date.parse(tradedAt);
    tradedAt = Number.isFinite(parsed) ? parsed : Number(tradedAt);
  } else {
    tradedAt = toNumber(tradedAt, NaN);
  }
  if (!Number.isFinite(tradedAt) || tradedAt <= 0) {
    return { error: '请填写成交时间' };
  }

  const id = String(input.id || '').trim();
  if (!id) return { error: 'missing id' };

  return {
    trade: {
      id,
      market,
      symbol,
      name: String(input.name || '').trim(),
      side,
      price,
      qty: roundQty(qty),
      tradedAt,
      fee,
      tax,
      note: String(input.note || '').trim(),
      createdAt: toNumber(input.createdAt, now),
      updatedAt: now,
    },
  };
}

function sanitizeMarks(input) {
  const marks = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) return marks;
  for (const [key, value] of Object.entries(input)) {
    if (!/^(A|HK|US):.+$/.test(key)) continue;
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) marks[key] = n;
  }
  return marks;
}

function computePositions(trades, marks = {}) {
  const byKey = {};
  const errors = [];

  for (const t of sortTrades(trades)) {
    const market = String(t.market || '').toUpperCase();
    if (!MARKETS[market]) continue;
    const symbol = normalizeSymbol(market, t.symbol);
    if (!symbol) continue;
    const key = `${market}:${symbol}`;
    if (!byKey[key]) {
      byKey[key] = {
        key,
        market,
        symbol,
        name: '',
        qty: 0,
        avgCost: 0,
        totalCost: 0,
        realizedPnl: 0,
        buyNotional: 0,
        buyQty: 0,
        sellQty: 0,
      };
    }
    const pos = byKey[key];
    if (t.name) pos.name = String(t.name).trim();
    const qty = roundQty(t.qty);
    const price = toNumber(t.price);
    const fees = toNumber(t.fee) + toNumber(t.tax);
    const side = String(t.side || '').toLowerCase();

    if (side === 'buy') {
      const costAdd = roundMoney(qty * price + fees);
      const newQty = pos.qty + qty;
      pos.totalCost = roundMoney(pos.totalCost + costAdd);
      pos.qty = newQty;
      pos.avgCost = newQty > 0 ? pos.totalCost / newQty : 0;
      pos.buyNotional = roundMoney(pos.buyNotional + costAdd);
      pos.buyQty += qty;
      continue;
    }

    if (side !== 'sell') continue;

    if (qty - pos.qty > QTY_EPS) {
      errors.push({
        tradeId: t.id,
        key,
        error: `卖出数量超过持仓：${symbol} 拟卖出 ${formatQty(qty)}，当时持仓仅 ${formatQty(pos.qty)}`,
      });
      continue;
    }

    const sellCost = roundMoney(pos.avgCost * qty);
    pos.realizedPnl = roundMoney(pos.realizedPnl + qty * price - sellCost - fees);
    pos.qty = roundQty(pos.qty - qty);
    pos.sellQty += qty;
    if (isZeroQty(pos.qty)) {
      pos.qty = 0;
      pos.totalCost = 0;
    } else {
      pos.totalCost = roundMoney(pos.qty * pos.avgCost);
    }
  }

  const positions = Object.values(byKey).map((pos) => {
    const mark = toNumber(marks[pos.key], NaN);
    const hasMark = Number.isFinite(mark) && mark > 0 && pos.qty > 0;
    const unrealizedPnl = hasMark ? (mark - pos.avgCost) * pos.qty : null;
    return {
      ...pos,
      currency: MARKETS[pos.market].currency,
      marketLabel: MARKETS[pos.market].label,
      markPrice: hasMark ? mark : null,
      unrealizedPnl: unrealizedPnl == null ? null : roundMoney(unrealizedPnl),
      holdingReturn: unrealizedPnl != null && pos.totalCost > 0 ? unrealizedPnl / pos.totalCost : null,
    };
  });

  positions.sort((a, b) => {
    if ((b.qty > 0) !== (a.qty > 0)) return b.qty > 0 ? 1 : -1;
    if (a.currency !== b.currency) return a.currency.localeCompare(b.currency);
    return b.totalCost - a.totalCost || a.symbol.localeCompare(b.symbol);
  });

  return { positions, errors };
}

function validateHoldings(trades) {
  const { errors } = computePositions(trades);
  if (errors.length) return { ok: false, error: errors[0].error };
  return { ok: true };
}

function upsertAndValidate(trades, incoming, now = Date.now()) {
  const sanitized = sanitizeTrade(incoming, now);
  if (sanitized.error) return { ok: false, error: sanitized.error };
  const next = (trades || []).filter((t) => t.id !== sanitized.trade.id).concat(sanitized.trade);
  const check = validateHoldings(next);
  if (!check.ok) return check;
  return { ok: true, trade: sanitized.trade, trades: next };
}

function deleteAndValidate(trades, id) {
  const next = (trades || []).filter((t) => t.id !== id);
  const check = validateHoldings(next);
  if (!check.ok) {
    return {
      ok: false,
      error: `删除后持仓将变为负数（${check.error}）。请先删除或修改相关卖出记录。`,
    };
  }
  return { ok: true, trades: next };
}

function emptyCurrencySummary() {
  return {
    openCost: 0,
    realizedPnl: 0,
    unrealizedPnl: 0,
    hasUnrealized: false,
    missingMarks: false,
    openCount: 0,
    closedCount: 0,
  };
}

function summarizeByCurrency(positions) {
  const groups = {
    CNY: emptyCurrencySummary(),
    HKD: emptyCurrencySummary(),
    USD: emptyCurrencySummary(),
  };
  for (const pos of positions || []) {
    const g = groups[pos.currency] || (groups[pos.currency] = emptyCurrencySummary());
    if (pos.qty > 0) {
      g.openCost += pos.totalCost;
      g.openCount += 1;
      if (pos.unrealizedPnl != null) {
        g.unrealizedPnl += pos.unrealizedPnl;
        g.hasUnrealized = true;
      } else {
        g.missingMarks = true;
      }
    } else {
      g.closedCount += 1;
    }
    g.realizedPnl += pos.realizedPnl;
  }
  return groups;
}

function formatQty(n) {
  if (isZeroQty(n)) return '0';
  if (Math.abs(n - Math.round(n)) < QTY_EPS) return String(Math.round(n));
  const s = roundQty(n).toFixed(8).replace(/\.?0+$/, '');
  return s;
}

module.exports = {
  MARKETS,
  computePositions,
  deleteAndValidate,
  formatQty,
  isZeroQty,
  normalizeSymbol,
  positionKey,
  roundQty,
  sanitizeMarks,
  sanitizeTrade,
  sortTrades,
  summarizeByCurrency,
  upsertAndValidate,
  validateHoldings,
};
