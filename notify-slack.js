// notify-slack.js
// 前日の店舗別売上をSlackメッセージとして生成する
// ────────────────────────────────────────────────────────────
// 使い方:
//   node notify-slack.js                   → 前日の売上メッセージを生成
//   node notify-slack.js --date=3月7日     → 指定日の売上メッセージを生成

const fs = require('fs');
const path = require('path');
const { verifyGate, buildWarningBanner } = require('./verify-gate');

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

// ── 対象日が属する YYYYMM を推定 ──
// 月初（1日）は前日が前月に属するため、当月ではなく前月ファイルを読む必要がある。
// この関数で「対象日の月」を求め、loadCurrentMonthData がその月のファイルを選ぶ。
function getTargetYyyymm() {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
  if (TARGET_DATE_LABEL) {
    // 手動指定（--date=6月30日 等）: ラベルの月を採用。
    // 指定月が現在月より後（例: 1月に12月を指定）なら前年扱い。
    const md = parseMonthDay(TARGET_DATE_LABEL);
    if (md) {
      const curMonth = now.getMonth() + 1;
      const year = md.month > curMonth ? now.getFullYear() - 1 : now.getFullYear();
      return `${year}${String(md.month).padStart(2, '0')}`;
    }
  }
  // 自動（前日基準）: 前日の実日付から YYYYMM を導く。月初は前月になる。
  now.setDate(now.getDate() - 1);
  return `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
}

// ── 対象日が属する月のJSONを読み込み ──
// 月次データファイル（YYYYMM.json）のみを対象とする。
// stores_master.json などの設定ファイルは除外する。
// 月初は「前日=前月」となるため、常に最新月ではなく対象日の月ファイルを選ぶ。
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

  // 対象日が属する月のファイルを優先。無ければ最新月にフォールバック（従来動作）。
  const wanted = `${getTargetYyyymm()}.json`;
  const chosenFile = jsonFiles.includes(wanted) ? wanted : jsonFiles[0];
  if (chosenFile !== wanted) {
    console.log(`📂 読み込み: data/${chosenFile}（対象月 ${wanted} が無いため最新月にフォールバック）`);
  } else {
    console.log(`📂 読み込み: data/${chosenFile}`);
  }
  return JSON.parse(fs.readFileSync(path.join(DATA_DIR, chosenFile), 'utf-8'));
}

// ── マスタ店舗一覧（master.json優先、config.jsフォールバック）──
// 当回スクレイプで丸ごと欠落した店舗（取得失敗）を検知するための基準リスト。
function loadMasterStores() {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'stores_master.json'), 'utf-8'));
    if (Array.isArray(m.stores) && m.stores.length >= 2) {
      return m.stores.map(s => ({ name: s.name, slug: s.slug }));
    }
  } catch (e) { /* フォールバックへ */ }
  const { STORES } = require('./config');
  return STORES.map(s => ({ name: s.name, slug: s.slug }));
}

// 当回データに丸ごと存在しない（=取得失敗の疑い）店舗名を返す。'all'は除外。
function detectMissingStores(allData) {
  const present = new Set(Object.keys(allData.stores || {}));
  return loadMasterStores()
    .filter(s => s.slug !== 'all' && !present.has(s.slug))
    .map(s => s.name);
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

// ── 指定ラベルの個別店舗合計を算出（'all'除外）──
function computeTotalForLabel(allData, label) {
  const d = extractDailyData(allData, label);
  const individual = Object.entries(d).filter(([slug]) => slug !== 'all');
  return {
    netSales: individual.reduce((s, [, x]) => s + (x.netSales || 0), 0),
    transactions: individual.reduce((s, [, x]) => s + (x.transactions || 0), 0),
    storeCount: individual.length,
  };
}

// ── 対象日より前で売上のある最新ラベルを返す（前日比の基準）──
function findPreviousLabelWithData(allData, currentLabel) {
  const cur = parseMonthDay(currentLabel);
  if (!cur) return null;
  let best = null;
  for (const store of Object.values(allData.stores)) {
    for (const rec of (store.data?.daily || [])) {
      if (!rec || (rec.netSales || 0) <= 0) continue;
      const md = parseMonthDay(rec.label);
      if (!md) continue;
      const isBefore = md.month < cur.month || (md.month === cur.month && md.day < cur.day);
      if (!isBefore) continue;
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
  // 当回スクレイプで丸ごと欠落した店舗（取得失敗の疑い）を明示警告。
  // ※シート側は既存タブから復旧されるが、当日分は未反映の可能性があるため要確認。
  if (options.missingStores && options.missingStores.length > 0) {
    message += `:rotating_light: _STORES取得失敗の疑い: ${options.missingStores.join('、')}（当日分が未反映の可能性。シートは前回値で復旧表示）_\n\n`;
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

  const missingStores = detectMissingStores(allData);
  if (missingStores.length > 0) {
    console.log(`🚨 当回データに欠落した店舗（取得失敗の疑い）: ${missingStores.join('、')}`);
  }

  const message = buildSlackMessage(effectiveLabel, dailyData, allData, { fallbackNoticeFor, missingStores });

  console.log('\n── Slackメッセージプレビュー ──');
  console.log(message);
  console.log('── プレビュー終了 ──\n');

  // ── 証拠ゲート（Loop Engineering）: 投稿前に当日数値を前日比などで検証 ──
  // fail-open: 検証ロジックで例外が出ても配信は止めない（ゲートは補助）
  let finalMessage = message;
  try {
    const curTotal = computeTotalForLabel(allData, effectiveLabel);
    const prevLabel = findPreviousLabelWithData(allData, effectiveLabel);
    const prevTotal = prevLabel ? computeTotalForLabel(allData, prevLabel) : null;
    const masterCount = loadMasterStores().filter(s => s.slug !== 'all').length;

    const gate = verifyGate({
      label: 'STORES日次',
      metrics: { netSales: curTotal.netSales, transactions: curTotal.transactions, storeCount: curTotal.storeCount },
      prev: prevTotal ? { netSales: prevTotal.netSales, transactions: prevTotal.transactions } : null,
      expect: {
        counts: {
          netSales: { min: 1, name: '純売上合計' },
          storeCount: { min: Math.ceil(masterCount * 0.5), name: '取得店舗数' },
        },
        anomaly: {
          keys: {
            netSales: { name: '純売上合計', threshold: 0.5 },
            transactions: { name: '件数合計', threshold: 0.5 },
          },
          defaultThreshold: 0.5,
        },
      },
    });
    const warnings = [...gate.warnings];
    if (prevLabel) {
      console.log(`[Gate] 前日比基準: ${prevLabel}（純売上 ¥${prevTotal.netSales.toLocaleString()} → ${effectiveLabel} ¥${curTotal.netSales.toLocaleString()}）`);
    } else {
      console.log('[Gate] 前日データなし → 前日比はスキップ（sanityのみ）');
    }
    // 全店舗合計の不一致（従来はログのみ）を⚠️に昇格
    const scrapedAll = extractDailyData(allData, effectiveLabel)['all'];
    if (scrapedAll && scrapedAll.netSales !== curTotal.netSales) {
      warnings.push(`全店舗合計の不一致（スクレイプ値¥${scrapedAll.netSales.toLocaleString()} ≠ 個別合計¥${curTotal.netSales.toLocaleString()}）`);
    }

    if (warnings.length) {
      finalMessage = buildWarningBanner(warnings, 'STORES日次') + message;
      console.warn(`[Gate] ⚠️ 異常検知: ${warnings.join(' / ')}`);
    } else {
      console.log('[Gate] ✓ 検証通過');
    }
  } catch (e) {
    console.error(`[Gate] 検証中にエラー（配信は継続）: ${e.message}`);
  }

  // メッセージをファイルに保存
  const outputPath = path.join(__dirname, 'slack_message.txt');
  fs.writeFileSync(outputPath, finalMessage, 'utf-8');
  console.log(`💾 メッセージ保存: ${outputPath}`);
}

if (require.main === module) {
  main();
}

module.exports = { buildSlackMessage, detectMissingStores, loadMasterStores, computeTotalForLabel, findPreviousLabelWithData };
