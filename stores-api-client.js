// stores-api-client.js
// STORES 公式 retail API (202211) の軽量クライアント。
// 認証: Authorization: Bearer {STORES_RETAIL_TOKEN}（プライベートアプリのクレデンシャル）
// 注文/販売チャネルを取得する。ページ送り・429リトライ込み。
// ─────────────────────────────────────────────────────────────

const API_BASE = 'https://api.stores.dev/retail/202211';

function getToken() {
  const t = process.env.STORES_RETAIL_TOKEN;
  if (!t) {
    throw new Error('STORES_RETAIL_TOKEN が未設定です（.env を確認）');
  }
  return t;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 単発GET（429/5xxは指数バックオフでリトライ）
async function apiGet(pathAndQuery, { maxRetries = 5 } = {}) {
  const token = getToken();
  const url = `${API_BASE}${pathAndQuery}`;
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let res;
    try {
      res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    } catch (e) {
      lastErr = e;
      await sleep(Math.min(1000 * 2 ** attempt, 15000));
      continue;
    }
    if (res.status === 200) return JSON.parse(await res.text());
    if (res.status === 429 || res.status >= 500) {
      // レート制限 / 一時障害 → 待って再試行
      const wait = Math.min(1000 * 2 ** attempt, 20000);
      lastErr = new Error(`HTTP ${res.status}`);
      await sleep(wait);
      continue;
    }
    // それ以外（401/403/400等）は即エラー
    const body = (await res.text()).slice(0, 300);
    throw new Error(`STORES API ${res.status}: ${body}`);
  }
  throw new Error(`STORES API リトライ上限超過: ${lastErr && lastErr.message}`);
}

// 販売チャネル一覧
async function fetchSalesChannels() {
  const j = await apiGet('/sales_channels');
  return Array.isArray(j) ? j : (j.sales_channels || j.data || []);
}

// 注文をページ送りで全件取得する。
// from/to は ISO8601（JSTオフセット付き推奨, 例 2026-06-01T00:00:00+09:00）。
async function fetchOrders({ from, to, limit = 100, pageDelayMs = 350 }) {
  const all = [];
  let offset = 0;
  for (let page = 0; page < 1000; page++) {
    const q = `/orders?ordered_at_from=${encodeURIComponent(from)}&ordered_at_to=${encodeURIComponent(to)}&limit=${limit}&offset=${offset}`;
    const j = await apiGet(q);
    const arr = j.orders || j.data || [];
    all.push(...arr);
    if (arr.length < limit) break;
    offset += limit;
    await sleep(pageDelayMs);
  }
  return all;
}

module.exports = { apiGet, fetchSalesChannels, fetchOrders, API_BASE };
