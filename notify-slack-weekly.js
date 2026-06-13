// notify-slack-weekly.js
// 前週（月〜日）の店舗別売上をSpreadsheetから読み取りSlackメッセージとして生成する
// ────────────────────────────────────────────────────────────
// 使い方:
//   node notify-slack-weekly.js              → 前週の週次売上メッセージを生成
//   node notify-slack-weekly.js --dry-run    → プレビューのみ（ファイル保存しない）

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const { withRetry } = require('./gapi-retry');

const FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID || '1ZiZE3bkB25aeeawQIPyiLazm_iabQJmj';

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');

// 店舗名マッピング（短縮名 → フル名）
const SHORT_TO_FULL = {
  'YY名古屋': 'YY HANDS名古屋',
  'YY東京': 'YYHANDS東京',
  'YY大阪': 'YYHANDS大阪',
  'LAB': 'YASUMI LAB名古屋',
  '2525': '2525ジュエリー名古屋',
  'BONSAI': 'HELLO BONSAI CLUB',
  'YY新宿': 'YYHANDS新宿',
};

// ── Google API 認証 ──
function getAuth() {
  const credentialsJson = process.env.GOOGLE_CREDENTIALS;
  if (!credentialsJson) {
    throw new Error('❌ GOOGLE_CREDENTIALS が設定されていません');
  }
  const credentials = JSON.parse(credentialsJson);
  return new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly', 'https://www.googleapis.com/auth/drive.readonly'],
  });
}

// ── 前週の月曜〜日曜の日付範囲を取得（JST） ──
function getLastWeekRange() {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  // 前週日曜 = 今日 - 今日の曜日（0=日, 1=月, ...）
  // 前週月曜 = 前週日曜 - 6
  const lastSunday = new Date(today);
  lastSunday.setDate(today.getDate() - today.getDay());
  const lastMonday = new Date(lastSunday);
  lastMonday.setDate(lastSunday.getDate() - 6);

  // 日ごとのDateオブジェクト配列（月〜日 7日間）
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(lastMonday);
    d.setDate(lastMonday.getDate() + i);
    days.push(d);
  }

  return { monday: lastMonday, sunday: lastSunday, days };
}

// ── DriveフォルダからSpreadsheetを検索 ──
async function findSpreadsheet(drive, monthStr) {
  const title = `STORES_売上_${monthStr}`;
  const res = await withRetry('drive.files.list(週次スプシ検索)', () => drive.files.list({
    q: `name='${title}' and '${FOLDER_ID}' in parents and mimeType='application/vnd.google-apps.spreadsheet' and trashed=false`,
    fields: 'files(id,name)',
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  }));
  return res.data.files?.[0] || null;
}

// ── サマリーシートからデータ読み取り ──
async function readSheetData(sheets, spreadsheetId, sheetTitle) {
  const res = await withRetry('spreadsheets.values.get(売上データ読込)', () => sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${sheetTitle}'!A:Z`,
  }));
  return res.data.values || [];
}

// ── 前週データを集計 ──
async function aggregateWeeklyData(sheets, drive, weekDays) {
  // 月ごとにグループ化（月またぎ対応）
  const monthGroups = {};
  for (const d of weekDays) {
    const monthStr = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`;
    if (!monthGroups[monthStr]) monthGroups[monthStr] = [];
    monthGroups[monthStr].push(d.getDate());
  }

  // 店舗別の集計結果
  const storeData = {}; // { storeName: { netSales, transactions } }
  const monthFiles = {}; // { monthStr: { id, name } } リンク生成用
  let header = null;

  for (const [monthStr, dayNumbers] of Object.entries(monthGroups)) {
    const file = await findSpreadsheet(drive, monthStr);
    if (!file) {
      console.error(`⚠️ Spreadsheet not found: STORES_売上_${monthStr}`);
      continue;
    }
    monthFiles[monthStr] = file;
    console.log(`📂 読み込み: ${file.name} (${file.id})`);

    // 純売上シートを読み取り
    const salesRows = await readSheetData(sheets, file.id, '純売上');
    // 客数シートを読み取り
    const countRows = await readSheetData(sheets, file.id, '客数');

    if (salesRows.length === 0) continue;

    // ヘッダーから店舗名を取得（最初のSpreadsheetから）
    if (!header) {
      header = salesRows[0]; // ['日付', 'YY名古屋', 'YY東京', ..., '合計']
    }

    // 該当日のデータを合算
    for (const dayNum of dayNumbers) {
      const dayLabel = `${dayNum}日`;

      // 純売上の該当行を検索
      const salesRow = salesRows.find(r => r[0] === dayLabel);
      const countRow = countRows.find(r => r[0] === dayLabel);

      if (!salesRow) continue;

      // 各店舗（B列〜G列、index 1〜header.length-2）を集計
      for (let i = 1; i < header.length - 1; i++) {
        const shortName = header[i];
        if (!storeData[shortName]) {
          storeData[shortName] = { netSales: 0, transactions: 0 };
        }
        const sales = parseInt(String(salesRow[i]).replace(/,/g, ''), 10) || 0;
        const count = countRow ? (parseInt(String(countRow[i]).replace(/,/g, ''), 10) || 0) : 0;
        storeData[shortName].netSales += sales;
        storeData[shortName].transactions += count;
      }
    }
  }

  return { storeData, header, monthFiles };
}

// ── 金額フォーマット ──
function formatYen(amount) {
  if (amount === 0) return '¥0';
  return '¥' + amount.toLocaleString('ja-JP');
}

// ── 棒グラフ（10マス） ──
function buildBar(value, maxValue) {
  if (maxValue <= 0) return '░░░░░░░░░░';
  const filled = Math.round((value / maxValue) * 10);
  return '█'.repeat(filled) + '░'.repeat(10 - filled);
}

// ── 曜日を取得 ──
function getDayOfWeek(date) {
  const days = ['日', '月', '火', '水', '木', '金', '土'];
  return `（${days[date.getDay()]}）`;
}

// ── Slackメッセージを組み立て ──
function buildWeeklyMessage(monday, sunday, storeData, monthFiles = {}) {
  const monYear = monday.getFullYear();
  const monLabel = `${monday.getMonth() + 1}月${monday.getDate()}日${getDayOfWeek(monday)}`;
  const sunLabel = `${sunday.getMonth() + 1}月${sunday.getDate()}日${getDayOfWeek(sunday)}`;

  const prefix = (process.env.WEEKLY_PREFIX || '').trim();
  let message = prefix ? `${prefix}\n\n` : '';
  message += `:bar_chart: _${monYear}年${monLabel}〜${sunLabel} 週次売上レポート_\n\n`;

  // 全店舗合計
  let totalSales = 0;
  let totalCount = 0;
  for (const data of Object.values(storeData)) {
    totalSales += data.netSales;
    totalCount += data.transactions;
  }
  const totalAvg = totalCount > 0 ? Math.round(totalSales / totalCount) : 0;

  message += `_*【全店舗合計】*_\n`;
  message += `純売上: _${formatYen(totalSales)}_\u3000|\u3000件数: _${totalCount}件_\u3000|\u3000単価: _${formatYen(totalAvg)}_\n\n`;

  // 店舗別（売上降順ソート）
  const entries = Object.entries(storeData)
    .map(([shortName, data]) => ({
      name: SHORT_TO_FULL[shortName] || shortName,
      netSales: data.netSales,
      transactions: data.transactions,
      avgPrice: data.transactions > 0 ? Math.round(data.netSales / data.transactions) : 0,
    }))
    .sort((a, b) => b.netSales - a.netSales);

  const maxSales = entries.length > 0 ? entries[0].netSales : 0;

  message += `_*【店舗別実績】*_\n`;
  const zeroStores = [];

  for (const store of entries) {
    const bar = buildBar(store.netSales, maxSales);
    message += `_${store.name}_\n`;
    message += `${bar} ${formatYen(store.netSales)}\u3000(${store.transactions}件 / 単価${formatYen(store.avgPrice)})\n`;
    if (store.netSales === 0) zeroStores.push(store.name);
  }

  if (zeroStores.length > 0) {
    message += `\n_※ ${zeroStores.join('、')} は売上なし_\n`;
  }

  // Google Spreadsheet URL（集計対象月のシートを指す。月またぎ週は両方並べる）
  const months = Object.keys(monthFiles).sort();
  if (months.length > 0) {
    const links = months.map(m => {
      const url = `https://docs.google.com/spreadsheets/d/${monthFiles[m].id}/edit`;
      const label = months.length > 1 ? `${m.slice(0, 4)}/${m.slice(4)}シート` : 'Google Spreadsheet';
      return `<${url}|${label}>`;
    });
    message += `\n:link: ${links.join('　')}`;
  }

  return message;
}

// ── メイン処理 ──
async function main() {
  const { monday, sunday, days } = getLastWeekRange();
  const monStr = `${monday.getMonth() + 1}/${monday.getDate()}`;
  const sunStr = `${sunday.getMonth() + 1}/${sunday.getDate()}`;
  console.log(`📅 対象期間: ${monStr}（月）〜 ${sunStr}（日）`);

  const auth = getAuth();
  const sheets = google.sheets({ version: 'v4', auth });
  const drive = google.drive({ version: 'v3', auth });

  const { storeData, monthFiles } = await aggregateWeeklyData(sheets, drive, days);

  const storeCount = Object.keys(storeData).length;
  if (storeCount === 0) {
    console.error('❌ 週次データが取得できませんでした');
    process.exit(1);
  }
  console.log(`✅ ${storeCount} 店舗のデータを集計`);

  const message = buildWeeklyMessage(monday, sunday, storeData, monthFiles);

  console.log('\n── 週次Slackメッセージプレビュー ──');
  console.log(message);
  console.log('── プレビュー終了 ──\n');

  if (!DRY_RUN) {
    const outputPath = path.join(__dirname, 'slack_message.txt');
    fs.writeFileSync(outputPath, message, 'utf-8');
    console.log(`💾 メッセージ保存: ${outputPath}`);
  } else {
    console.log('🔍 [DRY_RUN] ファイル保存をスキップ');
  }
}

main().catch(err => {
  console.error('❌ エラー:', err.message);
  process.exit(1);
});
