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
const TARGET_DATE_LABEL = getArg('date') || process.env.FORCE_TARGET_DATE || null;

// ── 前日の日付ラベルを生成 ──
function getYesterdayLabel() {
  if (TARGET_DATE_LABEL) return TARGET_DATE_LABEL;
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
  now.setDate(now.getDate() - 1);
  return `${now.getMonth() + 1}月${now.getDate()}日`;
}

// ── 当月のJSONを読み込み ──
// 月次データファイル（YYYYMM.json）のみを対象とする。
// stores_master.json などの設定ファイルは除外する。
function loadCurrentMonthData() {
  if (!fs.existsSync(DATA_DIR)) {
    console.error('❌ data/ フォルダがありません');
    process.exit(1);
  }

  const monthFilePattern = /^\d{6}\.json$/;
  const jsonFiles = fs.readdirSync(DATA_DIR)
    .filter(f => monthFilePattern.test(f))
    .sort()
    .reverse();

  if (jsonFiles.length === 0) {
    console.error('❌ 月次JSONファイル（YYYYMM.json）がありません');
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

// ── ラベル「M月D日（曜）」から月日を抽出 ──
function parseMonthDay(label) {
  const m = label.match(/(\d+)月(\d+)日/);
  if (!m) return null;
  return { month: parseInt(m[1], 10), day: parseInt(m[2], 10) };
}

// ── 全店舗を走査し、売上のある最新の日付ラベル（M月D日）を返す ──
// STORES側のデータ反映遅延で対象日が無い場合のフォールバック用
function findLatestAvailableLabel(allData) {
  let best = null; // { month, day, label }

  for (const store of Object.values(allData.stores)) {
    const daily = store.data?.daily || [];
    for (const rec of daily) {
      if (!rec || (rec.netSales || 0) <= 0) continue;
      const md = parseMonthDay(rec.label);
      if (!md) continue;
      if (!best || md.month > best.month || (md.month === best.month && md.day > best.day)) {
        best = { ...md, label: `${md.month}月${md.day}日` };
      }
    }
  }

  return best ? best.label : null;
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
function buildSlackMessage(targetLabel, dailyData, allData, options = {}) {
  const year = allData.year;
  const dayOfWeek = getDayOfWeek(targetLabel, year);

  let message = '';
  if (options.fallbackNoticeFor) {
    message += `:warning: _${options.fallbackNoticeFor} のデータがSTORES側にまだ反映されていないため、直近の ${targetLabel} の売上を掲載します_\n\n`;
  }
  message += `:bar_chart: _${year}年${targetLabel}${dayOfWeek} 売上レポート_\n\n`;

  // 全店舗合計: 個別店舗データから算出（スクレイピング漏れによる不一致を防止）
  const individualStores = Object.entries(dailyData)
    .filter(([slug]) => slug !== 'all');
  const computedTotal = {
    netSales: individualStores.reduce((sum, [, d]) => sum + (d.netSales || 0), 0),
    transactions: individualStores.reduce((sum, [, d]) => sum + (d.transactions || 0), 0),
  };
  computedTotal.avgPrice = computedTotal.transactions > 0
    ? Math.round(computedTotal.netSales / computedTotal.transactions) : 0;

  // スクレイピングした全店舗値と比較ログ出力
  const scrapedAll = dailyData['all'];
  if (scrapedAll && scrapedAll.netSales !== computedTotal.netSales) {
    console.log(`⚠️ 全店舗合計の不一致検出: スクレイピング値=¥${scrapedAll.netSales.toLocaleString()}, 個別合計=¥${computedTotal.netSales.toLocaleString()}`);
  }

  if (computedTotal.netSales > 0 || (scrapedAll && scrapedAll.netSales > 0)) {
    message += `_*【全店舗合計】*_\n`;
    message += `純売上: _${formatYen(computedTotal.netSales)}_\u3000|\u3000件数: _${computedTotal.transactions}件_\u3000|\u3000単価: _${formatYen(computedTotal.avgPrice)}_\n\n`;
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
  const requestedLabel = getYesterdayLabel();
  console.log(`🔍 対象日: ${requestedLabel}`);

  const allData = loadCurrentMonthData();
  let effectiveLabel = requestedLabel;
  let fallbackNoticeFor = null;
  let dailyData = extractDailyData(allData, requestedLabel);

  // フォールバック: 対象日が見つからない場合、直近の売上ありの日に切り替え
  if (Object.keys(dailyData).length === 0) {
    const fallback = findLatestAvailableLabel(allData);
    if (fallback && fallback !== requestedLabel) {
      console.log(`⚠️ ${requestedLabel} のデータが見つかりません。フォールバック日: ${fallback}（理由: 対象日のデータ未到着）`);
      effectiveLabel = fallback;
      fallbackNoticeFor = requestedLabel;
      dailyData = extractDailyData(allData, fallback);
    }
  }

  // それでも空ならデータ未到着の警告メッセージのみ生成して exit 0
  if (Object.keys(dailyData).length === 0) {
    console.log(`⚠️ ${requestedLabel} を含むデータがいずれの店舗にも見つかりません。データ未到着の警告メッセージを生成します。`);
    const urlPath = path.join(__dirname, 'spreadsheet_url.txt');
    const spreadsheetUrl = fs.existsSync(urlPath) ? fs.readFileSync(urlPath, 'utf-8').trim() : '';
    let message = `:warning: _${requestedLabel} のSTORES POS 日次データが取得できませんでした。STORES側の集計遅延の可能性があります。_\n`;
    if (spreadsheetUrl) {
      message += `\n:link: <${spreadsheetUrl}|Google Spreadsheet>（スプレッドシートは更新済みです）`;
    }
    const outputPath = path.join(__dirname, 'slack_message.txt');
    fs.writeFileSync(outputPath, message, 'utf-8');
    console.log(`💾 警告メッセージ保存: ${outputPath}`);
    return;
  }

  const storeCount = Object.keys(dailyData).length;
  console.log(`✅ ${storeCount} 店舗のデータを検出（対象日=${effectiveLabel}）`);

  const message = buildSlackMessage(effectiveLabel, dailyData, allData, { fallbackNoticeFor });

  console.log('\n── Slackメッセージプレビュー ──');
  console.log(message);
  console.log('── プレビュー終了 ──\n');

  // メッセージをファイルに保存
  const outputPath = path.join(__dirname, 'slack_message.txt');
  fs.writeFileSync(outputPath, message, 'utf-8');
  console.log(`💾 メッセージ保存: ${outputPath}`);
}

main();
