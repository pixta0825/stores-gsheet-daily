// fetch-stores-api.js
// STORES 公式 retail API から注文を取得し、日別×店舗別に集計して
// 既存 fetch-stores-data.js と「完全に同一構造」の中間JSON data/YYYYMM.json を出力する。
// スクレイピング版のドロップイン代替（CLI引数 --date / --month 互換）。
//
// 集計定義（検証スパイクで既存スクレイピング値と完全一致を確認済み・2026-06-16）:
//   純売上(税込)   netSales       = sales_amount - cancel_amount
//   消費税         tax            = sales_tax - cancel_tax
//   純売上(税抜)   netSalesExTax  = netSales - tax
//   総売上         grossSales     = sales_amount + sales_discount
//   値引き         discount       = sales_discount
//   返金額         refund         = cancel_amount
//   販売点数       itemsSold      = Σ 明細quantity（未キャンセル配送）
//   返品点数       itemsReturned  = Σ 明細quantity（キャンセル済み配送）  ※返品実データで要再検証
//   件数           transactions   = 注文数
//   単価           avgPrice       = round(netSales / transactions)
// 日付の帰属は注文の ordered_at（JST）の暦日。
// ────────────────────────────────────────────────────────────

const path = require('path');
const fs = require('fs');

// .env 読み込み: dotenv があれば使い、無ければ手動で .env / ../.env を読む
try {
  require('dotenv').config();
} catch (_) {
  for (const p of [path.join(__dirname, '.env'), path.join(__dirname, '..', '.env')]) {
    try {
      for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
        const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
      }
    } catch (_) { /* noop */ }
  }
}

const { STORES: STORES_FALLBACK } = require('./config');
const { fetchOrders } = require('./stores-api-client');

const MASTER_PATH = path.join(__dirname, 'data', 'stores_master.json');
const DATA_DIR = path.join(__dirname, 'data');
const DRY_RUN = process.env.DRY_RUN === 'true';

// ── CLI引数 ──
const args = process.argv.slice(2);
const getArg = (name) => {
  const a = args.find((x) => x.startsWith(`--${name}=`));
  return a ? a.split('=')[1] : null;
};
const CLI_DATE_PARAM = getArg('date') || 'this_month';
const CLI_MONTH = getArg('month');

function log(msg) {
  const ts = new Date().toLocaleTimeString('ja-JP');
  console.log(`[${ts}] ${msg}`);
}

// ── 店舗マスタ解決（scraperと同一ロジック）──
function loadStores() {
  try {
    if (fs.existsSync(MASTER_PATH)) {
      const m = JSON.parse(fs.readFileSync(MASTER_PATH, 'utf-8'));
      if (Array.isArray(m.stores) && m.stores.length >= 2) {
        return m.stores.map((s) => ({ name: s.name, slug: s.slug, salesChannelId: s.salesChannelId }));
      }
    }
  } catch (e) {
    console.warn(`⚠️ stores_master.json 読み込み失敗: ${e.message}. config.js にフォールバック`);
  }
  return STORES_FALLBACK.map((s) => {
    const m = s.url.match(/salesChannelId=([^&]+)/);
    return { name: s.name, slug: s.slug, salesChannelId: m ? m[1] : null };
  });
}

// ── 日付ユーティリティ（JST）──
const getJSTDate = () => new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));

function getTargetYearMonth() {
  if (CLI_MONTH && CLI_MONTH.length === 6) {
    return { year: parseInt(CLI_MONTH.slice(0, 4), 10), month: parseInt(CLI_MONTH.slice(4, 6), 10) };
  }
  const d = getJSTDate();
  return { year: d.getFullYear(), month: d.getMonth() + 1 };
}

// 対象月の日付範囲 [1日, 終端日] を返す。
// 当月なら終端=今日、過去月（last_month/backfill）なら終端=月末日。
function getDateRange(year, month) {
  const now = getJSTDate();
  const isCurrent = year === now.getFullYear() && month === now.getMonth() + 1;
  const endDay = isCurrent ? now.getDate() : new Date(year, month, 0).getDate();
  return { startDay: 1, endDay };
}

const pad = (n) => String(n).padStart(2, '0');

// ISO文字列 → JSTの 'YYYY-MM-DD'
function jstYMD(iso) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(iso));
}

// 曜日（JST短縮: 日月火水木金土）
function jstWeekday(year, month, day) {
  return new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', weekday: 'short' })
    .format(new Date(`${year}-${pad(month)}-${pad(day)}T12:00:00+09:00`));
}

const emptyAgg = () => ({ net: 0, tax: 0, gross: 0, disc: 0, refund: 0, sold: 0, returned: 0, cnt: 0 });

function addOrderTo(g, o) {
  g.net += (o.sales_amount || 0) - (o.cancel_amount || 0);
  g.tax += (o.sales_tax || 0) - (o.cancel_tax || 0);
  g.gross += (o.sales_amount || 0) + (o.sales_discount || 0);
  g.disc += (o.sales_discount || 0);
  g.refund += (o.cancel_amount || 0);
  // 件数: STORESの「件数」は「全額キャンセルされた注文」だけを除外する。
  //  - 全額キャンセル（cancel_amount>0 かつ 純売上<=0）→ 数えない
  //  - ¥0注文（cancel無し）や一部キャンセル（純売上>0）→ 数える
  // 金額・点数・返金には全注文を反映するが、件数のみこの条件。検証で全日一致を確認。
  const netAmt = (o.sales_amount || 0) - (o.cancel_amount || 0);
  const cancelOnly = (o.cancel_amount || 0) > 0 && netAmt <= 0;
  if (!cancelOnly) g.cnt += 1;
  for (const d of o.deliveries || []) {
    const canceled = !!d.canceled_at;
    for (const it of d.items || []) {
      if (canceled) g.returned += it.quantity || 0;
      else g.sold += it.quantity || 0;
    }
  }
}

function aggToRecord(label, g) {
  const net = g.net, tax = g.tax;
  return {
    label,
    netSales: net,
    netSalesExTax: net - tax,
    tax,
    grossSales: g.gross,
    discount: g.disc,
    refund: g.refund,
    itemsSold: g.sold,
    itemsReturned: g.returned,
    transactions: g.cnt,
    avgPrice: g.cnt ? Math.round(net / g.cnt) : 0,
  };
}

const recordToRow = (r) => [
  r.label, r.netSales, r.netSalesExTax, r.tax, r.grossSales,
  r.discount, r.refund, r.itemsSold, r.itemsReturned, r.transactions, r.avgPrice,
];

async function main() {
  const STORES = loadStores();
  const { year, month } = getTargetYearMonth();
  const monthStr = `${year}${pad(month)}`;
  const { startDay, endDay } = getDateRange(year, month);
  const from = `${year}-${pad(month)}-${pad(startDay)}T00:00:00+09:00`;
  const to = `${year}-${pad(month)}-${pad(endDay)}T23:59:59+09:00`;

  log('═══════════════════════════════════════════');
  log(' STORES POS 売上データ取得（公式API）');
  log(` 対象月: ${year}年${month}月 (${monthStr}) / 日付範囲 ${startDay}〜${endDay}日`);
  log(` 対象: ${STORES.length}店舗（全店舗含む）`);
  log('═══════════════════════════════════════════');

  // 全注文を一括取得（全チャネル）
  const orders = await fetchOrders({ from, to });
  log(`取得注文数: ${orders.length} 件（${from} 〜 ${to}）`);

  // チャネル別×日別に集計（'__all__' は全チャネル合算）
  const byChannel = {}; // channelId -> { day -> agg }
  const all = {}; // day -> agg
  const ensure = (obj, day) => (obj[day] || (obj[day] = emptyAgg()));

  for (const o of orders) {
    const ymd = jstYMD(o.ordered_at);
    if (ymd.slice(0, 7) !== `${year}-${pad(month)}`) continue; // 念のため対象月外を除外
    const day = parseInt(ymd.slice(8, 10), 10);
    const ch = o.sales_channel_id || '__none__';
    if (!byChannel[ch]) byChannel[ch] = {};
    addOrderTo(ensure(byChannel[ch], day), o);
    addOrderTo(ensure(all, day), o);
  }

  // 各店舗の中間データを構築
  const allData = { date: monthStr, year, month, fetchedAt: new Date().toISOString(), stores: {} };

  for (const store of STORES) {
    const dayMap = store.salesChannelId ? (byChannel[store.salesChannelId] || {}) : all;

    // 期間合計
    const total = emptyAgg();
    const dailyRecords = [];
    for (let day = startDay; day <= endDay; day++) {
      const g = dayMap[day] || emptyAgg();
      const label = `${month}月${day}日（${jstWeekday(year, month, day)}）`;
      dailyRecords.push(aggToRecord(label, g));
      // 合計加算
      total.net += g.net; total.tax += g.tax; total.gross += g.gross;
      total.disc += g.disc; total.refund += g.refund;
      total.sold += g.sold; total.returned += g.returned; total.cnt += g.cnt;
    }
    const summaryRecord = aggToRecord('期間合計', total);

    const records = [summaryRecord, ...dailyRecords];
    allData.stores[store.slug] = {
      name: store.name,
      raw: records.map(recordToRow),
      data: { summary: summaryRecord, daily: dailyRecords },
    };
  }

  // 保存
  if (!DRY_RUN) {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const jsonPath = path.join(DATA_DIR, `${monthStr}.json`);
    fs.writeFileSync(jsonPath, JSON.stringify(allData, null, 2), 'utf-8');
    log(`💾 中間データ保存: ${jsonPath}`);
  } else {
    log('[DRY_RUN] JSON保存スキップ');
  }

  // サマリー
  log('═══════════════════════════════════════════');
  for (const [slug, s] of Object.entries(allData.stores)) {
    const t = s.data.summary;
    log(`  ✅ ${s.name}: 期間合計 ¥${(t.netSales || 0).toLocaleString()} / ${t.transactions}件`);
  }
  log('═══════════════════════════════════════════');

  return allData;
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}

module.exports = { main };
