// recover-from-sheet.js
// 既存の「ソース月シート」の各店舗タブからデータを読み取り、
// data/<target>.json を再構築する（STORESへ再アクセスせずシート間で復旧する用）。
//
// 用途: 月末ロールオーバーで前月末日が翌月シートに入ってしまった等の事故復旧。
//   1) このスクリプトで data/<target>.json を作る
//   2) node upload-gsheet.js --month=<target> で対象月シートへ書き込む
//
// 使い方:
//   node recover-from-sheet.js --source=202606 --target=202605
//
// 必要な環境変数: GOOGLE_CREDENTIALS, （任意）GOOGLE_DRIVE_FOLDER_ID
// ────────────────────────────────────────────────────────────

const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
function getArg(name) {
  const a = args.find(x => x.startsWith(`--${name}=`));
  return a ? a.split('=')[1] : null;
}

const SOURCE = getArg('source'); // 例: 202606（データの実体がある月シート）
const TARGET = getArg('target'); // 例: 202605（本来入るべき月シート用のJSONを作る）
const CLEAR = getArg('clear');   // 例: 202606（このシートの全タブの値をクリアして空に戻す。構造は保持）
const FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID || '1ZiZE3bkB25aeeawQIPyiLazm_iabQJmj';
const DATA_DIR = path.join(__dirname, 'data');

// 店舗解決（master.json 優先、config.js フォールバック）
function loadStores() {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'stores_master.json'), 'utf-8'));
    if (Array.isArray(m.stores) && m.stores.length >= 2) {
      return m.stores.map(s => ({ name: s.name, slug: s.slug }));
    }
  } catch (e) { /* フォールバックへ */ }
  const { STORES } = require('./config');
  return STORES.map(s => ({ name: s.name, slug: s.slug }));
}
const STORES = loadStores();

function getAuth() {
  if (!process.env.GOOGLE_CREDENTIALS) throw new Error('❌ GOOGLE_CREDENTIALS が未設定です');
  const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
  return new google.auth.GoogleAuth({
    credentials,
    scopes: [
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/drive',
    ],
  });
}

async function findSheet(drive, title) {
  const res = await drive.files.list({
    q: `name='${title}' and '${FOLDER_ID}' in parents and mimeType='application/vnd.google-apps.spreadsheet' and trashed=false`,
    fields: 'files(id, name)',
    spaces: 'drive',
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  return res.data.files && res.data.files[0] ? res.data.files[0] : null;
}

function toNum(v) {
  if (typeof v === 'number') return v;
  if (v == null || v === '') return 0;
  const n = parseInt(String(v).replace(/[¥￥,、\s件点]/g, ''), 10);
  return isNaN(n) ? 0 : n;
}

// fetch-stores-data.js の structureData と同じ構造を再現
function structureData(raw) {
  const result = { summary: null, daily: [] };
  for (const row of raw) {
    const label = String(row[0]);
    const v = row.slice(1).map(toNum);
    const rec = {
      label,
      netSales: v[0] || 0,
      netSalesExTax: v[1] || 0,
      tax: v[2] || 0,
      grossSales: v[3] || 0,
      discount: v[4] || 0,
      refund: v[5] || 0,
      itemsSold: v[6] || 0,
      itemsReturned: v[7] || 0,
      transactions: v[8] || 0,
      avgPrice: v[9] || 0,
    };
    if (label.includes('合計') || label.includes('期間')) result.summary = rec;
    else result.daily.push(rec);
  }
  return result;
}

async function clearSheet(sheets, drive, month) {
  const title = `STORES_売上_${month}`;
  console.log(`🧹 クリア対象シートを検索: ${title}`);
  const ss = await findSheet(drive, title);
  if (!ss) {
    console.error(`❌ シートが見つかりません: ${title}`);
    process.exit(1);
  }
  const ssInfo = await sheets.spreadsheets.get({ spreadsheetId: ss.id });
  const tabs = ssInfo.data.sheets.map(s => s.properties.title);
  for (const tab of tabs) {
    await sheets.spreadsheets.values.clear({
      spreadsheetId: ss.id,
      range: `'${tab}'!A:Z`,
    });
    console.log(`  ✅ クリア: ${tab}`);
  }
  console.log(`\n💾 クリア完了: ${title}（${tabs.length}タブ・構造は保持）`);
}

async function main() {
  const auth = getAuth();
  const sheets = google.sheets({ version: 'v4', auth });
  const drive = google.drive({ version: 'v3', auth });

  if (CLEAR) {
    await clearSheet(sheets, drive, CLEAR);
    return;
  }

  if (!SOURCE || !TARGET) {
    console.error('❌ --source と --target は必須です（例: --source=202606 --target=202605）');
    process.exit(1);
  }

  const srcTitle = `STORES_売上_${SOURCE}`;
  console.log(`📄 ソースシートを検索: ${srcTitle}`);
  const src = await findSheet(drive, srcTitle);
  if (!src) {
    console.error(`❌ ソースシートが見つかりません: ${srcTitle}`);
    process.exit(1);
  }
  console.log(`  ✅ 発見: ${src.name} (${src.id})`);

  const ssInfo = await sheets.spreadsheets.get({ spreadsheetId: src.id });
  const tabTitles = ssInfo.data.sheets.map(s => s.properties.title);

  const stores = {};
  for (const store of STORES) {
    if (!tabTitles.includes(store.name)) {
      console.log(`  ⏭ タブなし: ${store.name}`);
      continue;
    }
    const r = await sheets.spreadsheets.values.get({
      spreadsheetId: src.id,
      range: `'${store.name}'!A1:K100`,
    });
    const vals = r.data.values || [];
    if (vals.length < 2) {
      console.log(`  ⚠️ データなし: ${store.name}`);
      continue;
    }
    // 1行目はヘッダー。2行目以降が [label, ...10数値]
    const raw = vals.slice(1)
      .filter(row => row && row[0])
      .map(row => {
        const label = String(row[0]);
        const nums = [];
        for (let i = 1; i <= 10; i++) nums.push(toNum(row[i]));
        return [label, ...nums];
      });
    if (raw.length === 0) {
      console.log(`  ⚠️ 有効行なし: ${store.name}`);
      continue;
    }
    stores[store.slug] = { name: store.name, raw, data: structureData(raw) };
    const total = stores[store.slug].data.summary?.netSales || 0;
    console.log(`  ✅ ${store.name}: ${raw.length}行（期間合計 ¥${total.toLocaleString()}）`);
  }

  const storeCount = Object.keys(stores).length;
  if (storeCount === 0) {
    console.error('❌ 1店舗も読み取れませんでした。ソースシートの内容を確認してください');
    process.exit(1);
  }

  const target = {
    date: TARGET,
    year: parseInt(TARGET.substring(0, 4), 10),
    month: parseInt(TARGET.substring(4, 6), 10),
    fetchedAt: new Date().toISOString(),
    recoveredFrom: srcTitle,
    stores,
  };

  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const out = path.join(DATA_DIR, `${TARGET}.json`);
  fs.writeFileSync(out, JSON.stringify(target, null, 2), 'utf-8');
  console.log(`\n💾 再構築完了: ${out} (${storeCount}店舗)`);
  console.log(`   → 次に: node upload-gsheet.js --month=${TARGET}`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
