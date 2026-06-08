// test-summary-recovery.js
// createSummarySheets の「当回未取得店舗を既存タブから復旧して列を維持する」恒久対策を検証する。
// シナリオ: YY名古屋(yyhands_nagoya) が当回スクレイプに無い（403等で失敗）が、
//          シート上の個別タブには 6/1-6/3 の実績(計47,850円)が残っている状況。
// 期待:    純売上サマリーに「YY名古屋」列が残り、日次値と週合計が正しく復旧される。

const assert = require('assert');
const { createSummarySheets } = require('../upload-gsheet');

// ── モック: 既存の個別タブ「YY HANDS名古屋」（カンマ付き文字列）──
const NAGOYA_TAB_ROWS = [
  ['日付','純売上','純売上（税抜）','消費税','総売上','値引き','返金額','販売点数','返品点数','件数','単価'],
  ['期間合計','47,850','43,504','4,346','47,850','0','0','39','0','8','5,981'],
  ['6月1日（月）','16,700','15,183','1,517','16,700','0','0','5','0','2','8,350'],
  ['6月2日（火）','17,000','15,456','1,544','17,000','0','0','16','0','3','5,667'],
  ['6月3日（水）','14,150','12,865','1,285','14,150','0','0','18','0','3','4,717'],
  ['6月4日（木）','0','0','0','0','0','0','0','0','0','0'],
];

// シートに存在するタブ一覧（マスタ全店 + サマリー3枚）
const TAB_TITLES = [
  '純売上','客数','単価',
  '全店舗','YY HANDS名古屋','YYHANDS東京','YYHANDS大阪','YASUMI LAB名古屋',
  '2525ジュエリー名古屋','HELLO BONSAI CLUB','YYHANDS新宿','YASUMI LAB TOKYO',
  'YYHANDS渋谷','YYHANDS原宿',
];
function sheetsMetaList() {
  return TAB_TITLES.map((t, i) => ({ properties: { title: t, sheetId: i + 1 } }));
}

const captured = {}; // title -> rows

const sheetsMock = {
  spreadsheets: {
    get: async () => ({ data: { sheets: sheetsMetaList() } }),
    batchUpdate: async () => ({ data: {} }),
    values: {
      get: async ({ range }) => {
        if (range.includes('YY HANDS名古屋')) return { data: { values: NAGOYA_TAB_ROWS } };
        return { data: { values: [] } };
      },
      clear: async () => ({ data: {} }),
      update: async ({ range, resource }) => {
        const title = range.split('!')[0].replace(/^'|'$/g, '');
        captured[title] = resource.values;
        return { data: {} };
      },
    },
  },
};

// ── allData: YY名古屋 だけ欠落、他は当回取得済み ──
function dailyRow(day, sales, kyaku, tanka) {
  return [`6月${day}日（月）`, sales, sales, 0, sales, 0, 0, kyaku, 0, kyaku, tanka];
}
const allData = {
  stores: {
    all:               { raw: [dailyRow(1, 38950, 4, 9000)] },
    yyhands_tokyo:     { raw: [dailyRow(1, 0, 0, 0)] },
    yyhands_osaka:     { raw: [dailyRow(1, 0, 0, 0)] },
    yasumilab_nagoya:  { raw: [dailyRow(1, 5600, 1, 5600)] },
    '2525jewelry_nagoya': { raw: [dailyRow(1, 0, 0, 0)] },
    hello_bonsai:      { raw: [dailyRow(1, 0, 0, 0)] },
    yyhands_shinjuku:  { raw: [dailyRow(1, 4300, 1, 4300)] },
    yasumilab_tokyo:   { raw: [dailyRow(1, 23450, 1, 23450)] },
    yyhands_shibuya:   { raw: [dailyRow(1, 5600, 1, 5600)] },
    yyhands_harajuku:  { raw: [dailyRow(1, 0, 0, 0)] },
    // yyhands_nagoya は意図的に欠落（当回スクレイプ失敗を再現）
  },
};

(async () => {
  await createSummarySheets(sheetsMock, 'DUMMY_SHEET_ID', allData, '202606', 100);

  const sales = captured['純売上'];
  assert(sales, '純売上サマリーが書き込まれていない');

  const header = sales[0];
  const nagoyaCol = header.indexOf('YY名古屋');
  assert(nagoyaCol !== -1, `❌ YY名古屋 列がサマリーから欠落している (header=${header.join(',')})`);

  // 日次行: rows[1]=1日, rows[2]=2日, rows[3]=3日
  const d1 = sales[1][nagoyaCol];
  const d2 = sales[2][nagoyaCol];
  const d3 = sales[3][nagoyaCol];
  assert.strictEqual(d1, 16700, `6/1 名古屋売上が復旧されていない: ${d1}`);
  assert.strictEqual(d2, 17000, `6/2 名古屋売上が復旧されていない: ${d2}`);
  assert.strictEqual(d3, 14150, `6/3 名古屋売上が復旧されていない: ${d3}`);

  const weekSum = d1 + d2 + d3;
  assert.strictEqual(weekSum, 47850, `週合計(6/1-6/3)が一致しない: ${weekSum}`);

  // 合計列が名古屋を含んでいる（6/1合計 >= 名古屋16,700 + LAB東京23,450 ...）
  const totalCol = header.length - 1;
  assert(sales[1][totalCol] >= 16700, '日次合計に名古屋が反映されていない');

  // 値が数値型であること（文字列だと downstream の合計が壊れる）
  assert.strictEqual(typeof d1, 'number', '復旧値が数値型でない');

  console.log('✅ PASS: YY名古屋 列が復旧され、日次値・週合計・数値型すべて正しい');
  console.log(`   header: ${header.join(' | ')}`);
  console.log(`   名古屋 6/1-6/3 = ${d1}, ${d2}, ${d3} (計 ${weekSum})`);
})().catch((e) => { console.error('❌ FAIL:', e.message); process.exit(1); });
