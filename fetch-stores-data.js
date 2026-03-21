// fetch-stores-data.js
// STORES POS管理画面からテーブルデータを取得し、JSONに保存する
// ────────────────────────────────────────────────────────────

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const { STORES, BASE_URL } = require('./config');

// ── CLI引数解析 ──
const args = process.argv.slice(2);
function getArg(name) {
  const arg = args.find(a => a.startsWith(`--${name}=`));
  return arg ? arg.split('=')[1] : null;
}

const CLI_DATE_PARAM = getArg('date') || 'this_month';
const CLI_MONTH = getArg('month');

// ── 設定 ──
const HEADLESS = process.env.HEADLESS !== 'false';
const DRY_RUN = process.env.DRY_RUN === 'true';
const DATA_DIR = path.join(__dirname, 'data');
const SCREENSHOT_DIR = path.join(__dirname, 'screenshots');
const SLOW_MO = HEADLESS ? 0 : 500;

// POS分析画面へのリダイレクトURL（ログイン後セッション確立に必要）
const POS_ANALYSIS_REDIRECT =
  'https://dashboard.stores.jp/dashboard/api/pos/platform/redirect?app_id=pos_analysis&organization_id=84edf1a5-88c3-4a9f-97cc-e2e5c10ee4fa&u=46d85a523981c1ea29b4910962ac6e5854b0de97f83cf44fa340bf67c7985d4e';

// JST基準の現在日時を取得
function getJSTDate() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
}

function getMonthString() {
  if (CLI_MONTH) return CLI_MONTH;
  const d = getJSTDate();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function getYearMonth() {
  if (CLI_MONTH && CLI_MONTH.length === 6) {
    return { year: parseInt(CLI_MONTH.substring(0, 4), 10), month: parseInt(CLI_MONTH.substring(4, 6), 10) };
  }
  const d = getJSTDate();
  return { year: d.getFullYear(), month: d.getMonth() + 1 };
}

/**
 * 明示的な日付範囲パラメータを構築する
 * date=this_month はSTORESがUTC基準で解釈する可能性があるため、
 * JST基準の明示的な startDate/endDate を使用する。
 *
 * @param {string} dateParam - CLI引数の date パラメータ ('this_month', 'last_month', etc.)
 * @returns {string} URLクエリパラメータ文字列
 */
function buildDateParams(dateParam) {
  const d = getJSTDate();
  const year = d.getFullYear();
  const month = d.getMonth() + 1;

  if (dateParam === 'this_month') {
    // 今月1日〜今日
    const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
    const today = `${year}-${String(month).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return `date=custom&startDate=${startDate}&endDate=${today}`;
  }

  if (dateParam === 'last_month') {
    // 前月1日〜前月末日
    const lastMonth = month === 1 ? 12 : month - 1;
    const lastMonthYear = month === 1 ? year - 1 : year;
    const lastDay = new Date(lastMonthYear, lastMonth, 0).getDate();
    const startDate = `${lastMonthYear}-${String(lastMonth).padStart(2, '0')}-01`;
    const endDate = `${lastMonthYear}-${String(lastMonth).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
    return `date=custom&startDate=${startDate}&endDate=${endDate}`;
  }

  // それ以外はそのまま使用
  return `date=${dateParam}`;
}

function buildStoreUrl(store) {
  const dateParams = buildDateParams(CLI_DATE_PARAM);
  const params = `${dateParams}&sortColumn=primary&sortDirection=ascending&groupBy=daily`;
  const salesChannelParam = store.slug !== 'all'
    ? `&salesChannelId=${STORES.find(s => s.slug === store.slug)?.url?.match(/salesChannelId=([^&]+)/)?.[1] || ''}`
    : '';
  return `${BASE_URL}?${params}${salesChannelParam}`;
}

function log(msg) {
  const ts = new Date().toLocaleTimeString('ja-JP');
  console.log(`[${ts}] ${msg}`);
}

function ensureDirs() {
  for (const dir of [DATA_DIR, SCREENSHOT_DIR]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
}

// ── テキストから数値を抽出 ──
function parseNumber(text) {
  if (!text || text.trim() === '' || text.trim() === '-' || text.trim() === '¥-') return 0;
  const cleaned = text.replace(/[¥￥,、\s件点]/g, '');
  const num = parseInt(cleaned, 10);
  return isNaN(num) ? 0 : num;
}

// ── ログイン＋POS分析セッション確立 ──
async function login(page) {
  log('🔐 STORES管理画面にログイン中...');

  await page.goto('https://dashboard.stores.app/', {
    waitUntil: 'networkidle',
    timeout: 30000,
  });

  await page.screenshot({ path: path.join(SCREENSHOT_DIR, '01_login_page.png') });

  // メール入力
  const emailSelectors = [
    'input[type="email"]',
    'input[name="email"]',
    'input#email',
    'input[placeholder*="メール"]',
    'input[autocomplete="email"]',
    'input[id*="email"]',
  ];

  let emailInput = null;
  for (const sel of emailSelectors) {
    emailInput = await page.$(sel);
    if (emailInput) break;
  }

  if (!emailInput) {
    const html = await page.content();
    fs.writeFileSync(path.join(SCREENSHOT_DIR, 'debug_login.html'), html);
    throw new Error(
      'メール入力欄が見つかりません。\n' +
      '→ screenshots/debug_login.html を確認してセレクタを修正してください'
    );
  }
  await emailInput.fill(process.env.STORES_EMAIL);

  // パスワード入力
  const passwordInput = await page.$(
    'input[type="password"], input[name="password"], input#current-password'
  );
  if (!passwordInput) throw new Error('パスワード入力欄が見つかりません');
  await passwordInput.fill(process.env.STORES_PASSWORD);

  await page.screenshot({ path: path.join(SCREENSHOT_DIR, '02_login_filled.png') });

  // ログインボタンクリック
  const submitBtn = await page.$(
    'button[type="submit"], input[type="submit"], button:has-text("ログイン")'
  );
  if (!submitBtn) throw new Error('ログインボタンが見つかりません');
  await submitBtn.click();

  await page.waitForNavigation({ waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(3000);
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, '03_after_login.png') });

  // ログイン成功確認
  const currentUrl = page.url();
  if (currentUrl.includes('/login') || currentUrl.includes('id.stores.jp')) {
    throw new Error('ログイン失敗。.env のメール・パスワードを確認してください');
  }
  log('  ✅ ログイン成功: ' + currentUrl);

  // POS分析画面のリダイレクトURLに移動してdashboard.stores.jpのセッションを確立
  log('🔗 POS分析画面のセッションを確立中...');
  await page.goto(POS_ANALYSIS_REDIRECT, {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });
  await page.waitForTimeout(5000);

  const posUrl = page.url();
  log('  ✅ POS分析セッション確立: ' + posUrl);
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, '04_pos_session.png') });
}

// ── ページテキストからテーブルデータを抽出 ──
async function scrapeStore(page, store) {
  log(`📊 ${store.name} のデータを取得中...`);

  const targetUrl = buildStoreUrl(store);
  log(`  🔗 URL: ${targetUrl}`);
  await page.goto(targetUrl, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(5000);

  await page.screenshot({
    path: path.join(SCREENSHOT_DIR, `store_${store.slug}.png`),
    fullPage: true,
  });

  if (DRY_RUN) {
    log(`  🔍 [DRY_RUN] ${store.name} のページを表示。データ取得はスキップ`);
    return null;
  }

  // ARIA role属性ベースで試行
  const ariaData = await page.evaluate(() => {
    const rows = document.querySelectorAll('[role="row"]');
    if (rows.length === 0) return null;
    const data = [];
    for (const row of rows) {
      const cells = row.querySelectorAll('[role="cell"], [role="columnheader"], [role="rowheader"]');
      if (cells.length === 0) continue;
      const cellTexts = [];
      for (const c of cells) cellTexts.push(c.innerText.trim());
      if (cellTexts.length > 0) data.push(cellTexts);
    }
    return data.length > 0 ? data : null;
  }).catch(() => null);

  if (ariaData && ariaData.length > 2) {
    log(`  ✅ ARIA role方式: ${ariaData.length}行検出`);
    return ariaData;
  }

  // フォールバック: ページ全体のテキストからパース
  log('  ℹ️  ARIA roleが見つからないため、テキスト解析モードで取得');
  const bodyText = await page.$eval('body', el => el.innerText).catch(() => '');

  if (!bodyText || bodyText.length < 100) {
    const html = await page.content();
    fs.writeFileSync(path.join(SCREENSHOT_DIR, `debug_${store.slug}.html`), html);
    log(`  ⚠️  ページテキストが取得できません`);
    return null;
  }

  const tableData = parseTableFromText(bodyText);
  if (tableData && tableData.length > 0) {
    log(`  ✅ テキスト解析方式: ${tableData.length}行検出`);
  } else {
    const html = await page.content();
    fs.writeFileSync(path.join(SCREENSHOT_DIR, `debug_${store.slug}.html`), html);
    log(`  ⚠️  テーブルデータを解析できませんでした`);
  }
  return tableData;
}

// ── テキストからテーブル構造を復元 ──
function parseTableFromText(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(l => l);

  const datePattern = /^\d+月\d+日（.）$/;

  const dateIndices = [];
  for (let i = 0; i < lines.length; i++) {
    if (datePattern.test(lines[i])) {
      dateIndices.push(i);
    }
  }

  if (dateIndices.length === 0) {
    log('  ⚠️  日付パターンが見つかりません');
    return null;
  }

  const lastDateLineIdx = dateIndices[dateIndices.length - 1];
  const numValues = dateIndices.length + 1;
  log(`  📋 日付行数: ${numValues} (合計1 + 日別${dateIndices.length})`);

  const headerNames = ['純売上', '純売上（税抜）', '消費税', '総売上', '値引き', '返金額', '販売点数', '返品点数', '件数', '単価'];

  const columns = {};
  for (const h of headerNames) {
    let headerLineIdx = -1;
    for (let i = lastDateLineIdx + 1; i < lines.length; i++) {
      if (lines[i] === h) {
        headerLineIdx = i;
        break;
      }
    }

    if (headerLineIdx === -1) {
      columns[h] = new Array(numValues).fill(0);
      continue;
    }

    const values = [];
    for (let i = headerLineIdx + 1; values.length < numValues && i < lines.length; i++) {
      const line = lines[i];
      if (headerNames.includes(line)) break;
      values.push(parseNumber(line));
    }
    while (values.length < numValues) values.push(0);
    columns[h] = values;
  }

  const dateLabels = ['期間合計'];
  for (const idx of dateIndices) {
    dateLabels.push(lines[idx]);
  }

  const result = [];
  for (let i = 0; i < numValues; i++) {
    const row = [dateLabels[i] || `Day${i}`];
    for (const h of headerNames) {
      row.push(columns[h][i] !== undefined ? columns[h][i] : 0);
    }
    result.push(row);
  }

  return result;
}

// ── テーブルデータを構造化 ──
function structureData(rawTable) {
  if (!rawTable || rawTable.length === 0) return null;

  const result = { summary: null, daily: [] };

  for (const row of rawTable) {
    const label = String(row[0]);
    const values = row.slice(1).map(v => typeof v === 'number' ? v : parseNumber(String(v)));

    const record = {
      label: label,
      netSales: values[0] || 0,
      netSalesExTax: values[1] || 0,
      tax: values[2] || 0,
      grossSales: values[3] || 0,
      discount: values[4] || 0,
      refund: values[5] || 0,
      itemsSold: values[6] || 0,
      itemsReturned: values[7] || 0,
      transactions: values[8] || 0,
      avgPrice: values[9] || 0,
    };

    if (label.includes('合計') || label.includes('期間')) {
      result.summary = record;
    } else {
      result.daily.push(record);
    }
  }

  return result;
}

// ── メイン処理 ──
async function main() {
  const monthStr = getMonthString();
  const { year, month } = getYearMonth();

  log('═══════════════════════════════════════════');
  log(' STORES POS 売上データ自動取得');
  log(` 対象月: ${year}年${month}月 (${monthStr})`);
  log(` STORESパラメータ: date=${CLI_DATE_PARAM}`);
  log(` 対象: ${STORES.length}店舗（全店舗含む）`);
  log(` モード: ${HEADLESS ? 'ヘッドレス' : '画面表示'} / ${DRY_RUN ? 'テスト' : '本番'}`);
  log('═══════════════════════════════════════════');

  if (!process.env.STORES_EMAIL || !process.env.STORES_PASSWORD) {
    console.error('❌ .env に STORES_EMAIL と STORES_PASSWORD を設定してください');
    process.exit(1);
  }

  ensureDirs();

  const browser = await chromium.launch({
    headless: HEADLESS,
    slowMo: SLOW_MO,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const context = await browser.newContext({
    acceptDownloads: true,
    locale: 'ja-JP',
    viewport: { width: 1280, height: 900 },
  });

  const page = await context.newPage();
  page.setDefaultTimeout(15000);

  const allData = {
    date: monthStr,
    year,
    month,
    fetchedAt: new Date().toISOString(),
    stores: {},
  };

  try {
    await login(page);

    for (const store of STORES) {
      const MAX_RETRIES = 3;
      let success = false;
      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
          const rawTable = await scrapeStore(page, store);
          if (rawTable) {
            const structured = structureData(rawTable);
            allData.stores[store.slug] = {
              name: store.name,
              raw: rawTable,
              data: structured,
            };
            success = true;
            break;
          }
        } catch (err) {
          log(`  ❌ ${store.name} (試行 ${attempt}/${MAX_RETRIES}): ${err.message}`);
          await page.screenshot({
            path: path.join(SCREENSHOT_DIR, `error_${store.slug}_attempt${attempt}.png`),
          });
          if (attempt < MAX_RETRIES) {
            log(`  🔄 ${5}秒後にリトライ...`);
            await page.waitForTimeout(5000);
          }
        }
      }
      if (!success) {
        log(`  ⚠️ ${store.name}: ${MAX_RETRIES}回試行後も取得失敗`);
      }
      await page.waitForTimeout(2000);
    }
  } catch (err) {
    log(`❌ 致命的エラー: ${err.message}`);
  } finally {
    await browser.close();
  }

  // ── 月データ検証 ──
  // 取得したデータの日付ラベルが期待月と一致するか検証する
  const firstStoreData = Object.values(allData.stores)[0];
  if (firstStoreData && firstStoreData.data && firstStoreData.data.daily && firstStoreData.data.daily.length > 0) {
    const firstLabel = firstStoreData.data.daily[0].label; // e.g. "3月1日（土）"
    const labelMatch = firstLabel.match(/(\d+)月/);
    if (labelMatch) {
      const dataMonth = parseInt(labelMatch[1], 10);
      if (dataMonth !== month) {
        log(`⚠️ 月不一致検出: 期待=${month}月, STORESデータ=${dataMonth}月`);
        log(`   明示的日付パラメータ使用中にこのエラーが出る場合、STORESの仕様変更の可能性があります`);
      } else {
        log(`✅ 月データ検証OK: ${month}月`);
      }
    }
  }

  // JSON保存
  if (!DRY_RUN) {
    const jsonPath = path.join(DATA_DIR, `${monthStr}.json`);
    fs.writeFileSync(jsonPath, JSON.stringify(allData, null, 2), 'utf-8');
    log(`💾 中間データ保存: ${jsonPath}`);
  }

  // サマリー
  const successCount = Object.keys(allData.stores).length;
  log('');
  log('═══════════════════════════════════════════');
  log(` 取得結果: ${successCount} / ${STORES.length} 店舗`);
  for (const [slug, store] of Object.entries(allData.stores)) {
    const daily = store.data?.daily?.length || 0;
    const total = store.data?.summary?.netSales || 0;
    log(`  ✅ ${store.name}: ${daily}日分, 期間合計 ¥${total.toLocaleString()}`);
  }
  log('═══════════════════════════════════════════');
}

// モジュールとしてもCLIとしても使用可能
if (require.main === module) {
  main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}

module.exports = { main, getMonthString, getYearMonth };
