// test-tax-exclusive.js
// 課税事業者化（2026-11-01〜）の「純売上・単価を税抜に切り替える」改修を検証する。
// 期待: 10/31=税込・11/1=税抜 / aggToRecord・期間合計の値 / 10月分の再取得は税込のまま /
//       週次注記は 10/26〜11/1 の週だけ / 環境変数 TAX_EXCLUSIVE_FROM の前倒しが効く。
// Slack・Google・STORES API には一切接続しない（APIはモック）。

const assert = require('assert');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MODS = ['config', 'fetch-stores-api', 'fetch-stores-data', 'upload-gsheet', 'notify-slack', 'notify-slack-weekly'];

// 環境変数を差し替えてモジュールを読み直す（config は読込時に切替日を確定するため）
function load(name, from) {
  if (from === undefined) delete process.env.TAX_EXCLUSIVE_FROM; else process.env.TAX_EXCLUSIVE_FROM = from;
  for (const m of MODS) delete require.cache[require.resolve(path.join(ROOT, m))];
  return require(path.join(ROOT, name));
}

// 税率10%: 税込110円 → 税抜100円
const g = { net: 11000, tax: 1000, gross: 11000, disc: 0, refund: 0, sold: 5, returned: 0, cnt: 4 };

// ── 1. 判定関数 ──
{
  const c = load('config');
  assert.strictEqual(c.isTaxExclusive('2026-10-31'), false, '10/31 は税込');
  assert.strictEqual(c.isTaxExclusive('2026-11-01'), true, '11/1 は税抜');
  assert.strictEqual(c.isTaxExclusiveMonth('202610'), false);
  assert.strictEqual(c.isTaxExclusiveMonth('202611'), true);
  assert.strictEqual(c.hasTaxExclusiveDays('202610'), false);
  assert.strictEqual(c.hasTaxExclusiveDays('202611'), true);
}

// ── 2. aggToRecord ──
{
  const { aggToRecord } = load('fetch-stores-api');
  const inc = aggToRecord('x', g, false);
  assert.strictEqual(inc.netSales, 11000);
  assert.strictEqual(inc.avgPrice, 2750);
  const ex = aggToRecord('x', g, true);
  assert.strictEqual(ex.netSales, 10000, '税抜日は netSales=税抜');
  assert.strictEqual(ex.avgPrice, 2500, '税抜日は単価も税抜ベース');
  assert.strictEqual(ex.netSalesExTax, 10000);
  assert.strictEqual(ex.tax, 1000);
  assert.strictEqual(ex.grossSales, 11000, '総売上は不変');
}

// ── 3. main(): 月別の実行（STORES APIはモック）──
// ※「今月」は終端が今日になるため、過去月（9月）と未来月（11月）で検証する。
//   既定の切替日での 10/31・11/1 境界は 1・2 の判定関数テストで担保。
async function runMonth(month, from) {
  const client = path.join(ROOT, 'stores-api-client.js');
  require(client);
  require.cache[require.resolve(client)].exports = {
    fetchOrders: async () => {
      const mk = (ymd, amt, tax) => ({ ordered_at: `${ymd}T12:00:00+09:00`, sales_channel_id: null, sales_amount: amt, sales_tax: tax, sales_discount: 0, cancel_amount: 0, cancel_tax: 0, deliveries: [] });
      return [mk('2026-09-29', 11000, 1000), mk('2026-09-30', 22000, 2000), mk('2026-11-01', 11000, 1000), mk('2026-11-02', 33000, 3000)];
    },
  };
  process.env.DRY_RUN = 'true';
  process.argv = process.argv.slice(0, 2).concat(`--month=${month}`);
  const { main } = load('fetch-stores-api', from);
  const data = await main();
  return data.stores['all'].data;
}

(async () => {
  const origLog = console.log; console.log = () => {};
  let oct, nov, octEarly;
  try {
    oct = await runMonth('202609');                  // 切替前の月の再取得（既定の切替日のまま）
    nov = await runMonth('202611');                  // 切替後の月
    octEarly = await runMonth('202609', '2026-09-30'); // 前倒し: 9/30から税抜
  } finally { console.log = origLog; }
  const day = (d, n) => d.daily.find(r => r.label.includes(`月${n}日`));

  // 切替前の月: 既定の切替日なら全日税込のまま
  assert.strictEqual(day(oct, 29).netSales, 11000);
  assert.strictEqual(day(oct, 30).netSales, 22000, '切替前の月末日は税込');
  assert.strictEqual(oct.summary.netSales, 33000, '切替前の月の期間合計は税込のまま');
  assert.strictEqual(oct.summary.avgPrice, 16500);
  // 11月: 全日税抜
  assert.strictEqual(day(nov, 1).netSales, 10000, '11/1 は税抜');
  assert.strictEqual(day(nov, 2).netSales, 30000);
  assert.strictEqual(nov.summary.netSales, 40000, '11月の期間合計は日別の合算');
  assert.strictEqual(nov.summary.netSalesExTax, 40000);
  // 前倒し(9/30〜): 9/29=税込, 9/30=税抜。期間合計は日別の合算と一致
  assert.strictEqual(day(octEarly, 29).netSales, 11000);
  assert.strictEqual(day(octEarly, 30).netSales, 20000, '前倒しで 9/30 が税抜');
  assert.strictEqual(octEarly.summary.netSales, 31000, '期間合計＝日別合算（基準混在でも一致）');
  assert.strictEqual(octEarly.summary.avgPrice, 15500);
  assert.strictEqual(octEarly.summary.netSales, octEarly.daily.reduce((s, r) => s + r.netSales, 0));

  // ── 4. 旧版スクレイプの置換 ──
  {
    const { applyTaxBasis } = load('fetch-stores-data');
    const row = (l, n, ex, cnt) => [l, n, ex, n - ex, n, 0, 0, 3, 0, cnt, Math.round(n / cnt)];
    const raw = [row('期間合計', 33000, 30000, 4), row('10月31日（土）', 22000, 20000, 2), row('11月1日（日）', 11000, 10000, 2)];
    const a = applyTaxBasis(raw, 2026, 11);
    assert.strictEqual(a[2][1], 10000);
    assert.strictEqual(a[2][10], 5000);
    assert.strictEqual(a[1][1], 22000, '10/31 は税込のまま');
    assert.strictEqual(a[0][1], 32000, '期間合計＝日別合算');
    const b = applyTaxBasis(raw, 2026, 10); // 11/1 を含まない月（ラベルは10月扱い）
    assert.strictEqual(raw[2][1], 11000, '元配列は破壊しない');
  }

  // ── 5. 週次メッセージ: 見出しと注記 ──
  {
    let buildWeeklyMessage = load('notify-slack-weekly').buildWeeklyMessage;
    const sd = { 'YY東京': { netSales: 10000, transactions: 2 } };
    const msg = (mon) => {
      const m = new Date(2026, mon[0] - 1, mon[1]); const s = new Date(m); s.setDate(m.getDate() + 6);
      return buildWeeklyMessage(m, s, sd, {});
    };
    const mixed = msg([10, 26]);
    assert(mixed.includes('※10/26〜10/31は税込、11/1は税抜（11月から課税事業者のため）'), mixed);
    assert(mixed.includes('純売上:') && !mixed.includes('純売上（税抜）'), '混在週の見出しは従来表記');
    const before = msg([10, 19]);
    assert(!before.includes('※') && !before.includes('税抜'), '10/19週は注記なし');
    const after = msg([11, 2]);
    assert(after.includes('純売上（税抜）:') && !after.includes('※'), '11/2週は全日税抜・注記なし');
    buildWeeklyMessage = load('notify-slack-weekly', '2026-10-28').buildWeeklyMessage; // 前倒し
    const early = msg([10, 26]);
    assert(early.includes('※10/26〜10/27は税込、10/28〜11/1は税抜（10月から課税事業者のため）'), early);
  }

  // ── 6. 日次メッセージ: 見出し ──
  {
    const { buildSlackMessage } = load('notify-slack');
    const d = { yy: { name: 'YY東京', netSales: 10000, transactions: 2, avgPrice: 5000 } };
    const all = { year: 2026 };
    assert(buildSlackMessage('10月31日', d, all).includes('純売上: _'), '10/31 は従来表記');
    assert(buildSlackMessage('11月1日', d, all).includes('純売上（税抜）: _'), '11/1 は税抜表記');
  }

  // ── 7. シートのメモ（A1 note）──
  {
    const reqs = {};
    const mock = {
      spreadsheets: {
        get: async () => ({ data: { sheets: ['純売上', '客数', '単価'].map((t, i) => ({ properties: { title: t, sheetId: i + 1 } })) } }),
        batchUpdate: async ({ resource }) => { (reqs.list = reqs.list || []).push(...resource.requests); return { data: {} }; },
        values: { get: async () => ({ data: { values: [] } }), update: async () => ({}), clear: async () => ({}) },
      },
    };
    const allData = { stores: { all: { raw: [['11月1日（日）', 1, 1, 0, 1, 0, 0, 1, 0, 1, 1]] } } };
    for (const [mon, expectN] of [['202610', 0], ['202611', 2]]) {
      reqs.list = [];
      const { createSummarySheets } = load('upload-gsheet');
      const ol = console.log; console.log = () => {};
      try { await createSummarySheets(mock, 'DUMMY', allData, mon, 100); } finally { console.log = ol; }
      const notes = reqs.list.filter(r => r.updateCells && r.updateCells.fields === 'note');
      assert.strictEqual(notes.length, expectN, `${mon} のメモ数 ${notes.length}`);
      for (const n of notes) assert(n.updateCells.rows[0].values[0].note.includes('税抜'));
    }
  }

  delete process.env.TAX_EXCLUSIVE_FROM;
  console.log('✅ PASS: 10/31=税込・11/1=税抜、期間合計=日別合算、10月再取得は税込、週次注記は10/26週のみ、前倒し有効、メモはA1のみ');
})().catch((e) => { console.error('❌ FAIL:', e.message); process.exit(1); });
