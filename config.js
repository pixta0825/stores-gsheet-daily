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

module.exports = { STORES, COLUMNS, BASE_URL, COMMON_PARAMS };
