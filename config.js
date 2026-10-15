// config.js
// YASUMI WORKS 店舗設定
// ─────────────────────────────────────────────

const BASE_URL = 'https://dashboard.stores.jp/pos/sales_analysis/term/';
const COMMON_PARAMS = 'date=this_month&sortColumn=primary&sortDirection=ascending&groupBy=daily';

const STORES = [
  {
    name: '全店舗',
    slug: 'all',
    url: `${BASE_URL}?${COMMON_PARAMS}`,
  },
  {
    name: 'YY HANDS名古屋',
    slug: 'yyhands_nagoya',
    url: `${BASE_URL}?${COMMON_PARAMS}&salesChannelId=681b02b1b7ac330049f2abcc`,
  },
  {
    name: 'YYHANDS東京',
    slug: 'yyhands_tokyo',
    url: `${BASE_URL}?${COMMON_PARAMS}&salesChannelId=6940c8274683791b9ae0058a`,
  },
  {
    name: 'YYHANDS大阪',
    slug: 'yyhands_osaka',
    url: `${BASE_URL}?${COMMON_PARAMS}&salesChannelId=6940c855e0c48f1a99481d83`,
  },
  {
    name: 'YASUMI LAB名古屋',
    slug: 'yasumilab_nagoya',
    url: `${BASE_URL}?${COMMON_PARAMS}&salesChannelId=6940c871bd17481c37c99de9`,
  },
  {
    name: '2525ジュエリー名古屋',
    slug: '2525jewelry_nagoya',
    url: `${BASE_URL}?${COMMON_PARAMS}&salesChannelId=6940c888bd17481c37c99dea`,
  },
  {
    name: 'HELLO BONSAI CLUB',
    slug: 'hello_bonsai',
    url: `${BASE_URL}?${COMMON_PARAMS}&salesChannelId=6960aeb4e7c5ab0aaa10f966`,
  },
  {
    name: 'YYHANDS新宿',
    slug: 'yyhands_shinjuku',
    url: `${BASE_URL}?${COMMON_PARAMS}&salesChannelId=69ae3f7326307605f0833d2f`,
  },
  {
    name: 'YASUMI LAB TOKYO',
    slug: 'yasumilab_tokyo',
    url: `${BASE_URL}?${COMMON_PARAMS}&salesChannelId=69e03136d9e28df3f61314ba`,
  },
  {
    name: 'YYHANDS渋谷',
    slug: 'yyhands_shibuya',
    url: `${BASE_URL}?${COMMON_PARAMS}&salesChannelId=69f43c0d248f8c08e31ba380`,
  },
  {
    name: 'YYHANDS原宿',
    slug: 'yyhands_harajuku',
    url: `${BASE_URL}?${COMMON_PARAMS}&salesChannelId=69f43d5cfc56600a9d3552c2`,
  },
];

// xlsxのカラム定義（STORES管理画面のテーブルヘッダーと一致）
const COLUMNS = [
  '日付',
  '純売上',
  '純売上（税抜）',
  '消費税',
  '総売上',
  '値引き',
  '返金額',
  '販売点数',
  '返品点数',
  '件数',
  '単価',
];

// ── 消費税の課税事業者化（YASUMI WORKS: 2026-11-01〜）──
// この日以降の「純売上」「単価」は税抜ベースで報告する。それ以前は従来どおり税込。
// 環境変数 TAX_EXCLUSIVE_FROM は検証用の前倒し（'YYYY-MM-DD'）。
const TAX_EXCLUSIVE_FROM = process.env.TAX_EXCLUSIVE_FROM || '2026-11-01';

// 'YYYY-MM-DD' が切替日以降なら true（文字列比較でJST暦日をそのまま判定）
function isTaxExclusive(ymd) {
  return String(ymd) >= TAX_EXCLUSIVE_FROM;
}

// 'YYYYMM' の月全体が切替日以降なら true（月初日で判定。切替日が月初なら月と1対1）
function isTaxExclusiveMonth(yyyymm) {
  const s = String(yyyymm);
  return isTaxExclusive(`${s.slice(0, 4)}-${s.slice(4, 6)}-01`);
}

// 'YYYYMM' の月に切替日以降の日が1日でも含まれるなら true（メモ付与の判定用）
function hasTaxExclusiveDays(yyyymm) {
  const s = String(yyyymm);
  const y = parseInt(s.slice(0, 4), 10), m = parseInt(s.slice(4, 6), 10);
  const last = new Date(y, m, 0).getDate();
  return isTaxExclusive(`${s.slice(0, 4)}-${s.slice(4, 6)}-${String(last).padStart(2, '0')}`);
}

module.exports = {
  STORES, COLUMNS, BASE_URL, COMMON_PARAMS,
  TAX_EXCLUSIVE_FROM, isTaxExclusive, isTaxExclusiveMonth, hasTaxExclusiveDays,
};
