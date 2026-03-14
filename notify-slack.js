// notify-slack.js
// 前日の店舗別売上をSlackメッセージとして生成する
// ────────────────────────────────────────────────────────────
// 使い方:
//   node notify-slack.js                   → 前日の売上メッセージを生成
//   node notify-slack.js --date=3月7日     → 指定日の売上メッセージを生成

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');

// ── CLI引数 ──
const args = process.argv.slice(2);
function getArg(name) {
  const arg = args.find(a => a.startsWith(`--${name}=`));
  return arg ? arg.split('=')[1] : null;
}
const TARGET_DATE_LABEL = getArg('date');

// ── 前日の日付ラベルを生成 ──
function getYesterdayLabel() {
  if (TARGET_DATE_LABEL) return TARGET_DATE_LABEL;
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
  now.setDate(now.getDate() - 1);
  return `${now.getMonth() + 1}月${now.getDate()}日`;
}

// ── 当月のJSONを読み込み ──
function loadCurrentMonthData() {
  if (!fs.existsSync(DATA_DIR)) {
    console.error('❌ data/ フォルダがありません');
    process.exit(1);
  }

  const jsonFiles = fs.readdirSync(DATA_DIR)
    .filter(f => f.endsWith('.json'))
    .sort()
    .reverse();

  if (jsonFiles.length === 0) {
    console.error('❌ JSONファイルがありません');
    process.exit(1);
  }

  const latestFile = jsonFiles[0];
  console.log(`📂 読み込み: data/${latestFile}`);
  return JSON.parse(fs.readFileSync(path.join(DATA_DIR, latestFile), 'utf-8'));
}

// ── 前日の売上データを抽出 ──
function extractDailyData(allData, targetLabel) {
  const results = {};

  for (const [slug, store] of Object.entries(allData.stores)) {
    const daily = store.data?.daily || [];
    const record = daily.find(d => d.label.includes(targetLabel));
    if (record) {
      results[slug] = {
        name: store.name,
        ...record,
      };
    }
  }

  return results;
}

// ── 金額フォーマット ──
function formatYen(amount) {
  if (amount === 0) return '¥0';
  return '¥' + amount.toLocaleString('ja-JP');
}

// ── 棒グラフ（10マス）を生成 ──
function buildBar(value, maxValue) {
  if (maxValue <= 0) return '░░░░░░░░░░';
  const filled = Math.round((value / maxValue) * 10);
  return '█'.repeat(filled) + '░'.repeat(10 - filled);
}

// ── 曜日を取得 ──
function getDayOfWeek(label, year) {
  const match = label.match(/(\d+)月(\d+)日/);
  if (!match) return '';
  const m = parseInt(match[1], 10) - 1;
  const d = parseInt(match[2], 10);
  const date = new Date(year, m, d);
  const days = ['日', '月', '火', '水', '木', '金', '土'];
  return `（${days[date.getDay()]}）`;
}

// ── Slackメッセージを組み立て ──
function buildSlackMessage(targetLabel, dailyData, allData) {
  const year = allData.year;
  const dayOfWeek = getDayOfWeek(targetLabel, year);

  let message = `:bar_chart: _${year}年${targetLabel}${dayOfWeek} 売上レポート_\n\n`;

  // 全店舗合計
  const allStore = dailyData['all'];
  if (allStore) {
    message += `_*【全店舗合計】*_\n`;
    message += `純売上: _${formatYen(allStore.netSales)}_\u3000|\u3000件数: _${allStore.transactions}件_\u3000|\u3000単価: _${formatYen(allStore.avgPrice)}_\n\n`;
  }

  // 店舗別（全店舗以外）を売上降順でソート
  const storeEntries = Object.entries(dailyData)
    .filter(([slug]) => slug !== 'all')
    .sort((a, b) => b[1].netSales - a[1].netSales);

  const maxSales = storeEntries.length > 0 ? storeEntries[0][1].netSales : 0;

  message += `_*【店舗別実績】*_\n`;
  const zeroStores = [];

  for (const [slug, data] of storeEntries) {
    const bar = buildBar(data.netSales, maxSales);
    message += `_${data.name}_\n`;
    message += `${bar} ${formatYen(data.netSales)}\u3000(${data.transactions}件 / 単価${formatYen(data.avgPrice)})\n`;

    if (data.netSales === 0) {
      zeroStores.push(data.name);
    }
  }

  if (zeroStores.length > 0) {
    message += `\n_※ ${zeroStores.join('、')} は売上なし_\n`;
  }

  // Google Spreadsheet URL を追記
  const urlPath = path.join(__dirname, 'spreadsheet_url.txt');
  if (fs.existsSync(urlPath)) {
    const url = fs.readFileSync(urlPath, 'utf-8').trim();
    message += `\n:link: <${url}|Google Spreadsheet>`;
  }

  return message;
}

// ── メイン処理 ──
function main() {
  const targetLabel = getYesterdayLabel();
  console.log(`🔍 対象日: ${targetLabel}`);

  const allData = loadCurrentMonthData();
  const dailyData = extractDailyData(allData, targetLabel);

  const storeCount = Object.keys(dailyData).length;
  if (storeCount === 0) {
    console.error(`❌ ${targetLabel} のデータが見つかりません`);
    console.log('  ヒント: まず node fetch-stores-data.js でデータを取得してください');
    process.exit(1);
  }

  console.log(`✅ ${storeCount} 店舗のデータを検出`);

  const message = buildSlackMessage(targetLabel, dailyData, allData);

  console.log('\n── Slackメッセージプレビュー ──');
  console.log(message);
  console.log('── プレビュー終了 ──\n');

  // メッセージをファイルに保存
  const outputPath = path.join(__dirname, 'slack_message.txt');
  fs.writeFileSync(outputPath, message, 'utf-8');
  console.log(`💾 メッセージ保存: ${outputPath}`);
}

main();
