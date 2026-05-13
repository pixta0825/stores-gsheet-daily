// update-stores-master.js
// STORES POS分析画面のプルダウンから店舗一覧を動的取得し、data/stores_master.json を更新する。
// 週1回 GitHub Actions で実行。
// ─────────────────────────────────────────────────────────────

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const { STORES } = require('./config');

const HEADLESS = process.env.HEADLESS !== 'false';
const SCREENSHOT_DIR = path.join(__dirname, 'screenshots');
const DATA_DIR = path.join(__dirname, 'data');
const MASTER_PATH = path.join(DATA_DIR, 'stores_master.json');

const POS_ANALYSIS_REDIRECT =
  'https://dashboard.stores.jp/dashboard/api/pos/platform/redirect?app_id=pos_analysis&organization_id=84edf1a5-88c3-4a9f-97cc-e2e5c10ee4fa&u=46d85a523981c1ea29b4910962ac6e5854b0de97f83cf44fa340bf67c7985d4e';

const EXCLUDE_BUTTON_LABELS = ['日別', '週別', '月別', '年別', 'カスタム', '期間', 'フィルター', 'フィルタ', 'グラフ', 'CSV', 'ダウンロード', '出力', '設定', 'ログアウト', 'メニュー', '日次', '月次', '時間別', '比較', '絞り込み', '今月', '先月', '今週', '先週'];

function log(msg) {
  console.log(`[${new Date().toLocaleTimeString('ja-JP')}] ${msg}`);
}

function ensureDirs() {
  for (const d of [SCREENSHOT_DIR, DATA_DIR]) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  }
}

async function login(page) {
  log('🔐 STORESログイン...');
  await page.goto('https://dashboard.stores.app/', { waitUntil: 'networkidle', timeout: 30000 });
  const email = await page.$('input[type="email"], input[name="email"], input#email');
  if (!email) throw new Error('メール入力欄なし');
  await email.fill(process.env.STORES_EMAIL);
  const pw = await page.$('input[type="password"], input[name="password"], input#current-password');
  if (!pw) throw new Error('パスワード入力欄なし');
  await pw.fill(process.env.STORES_PASSWORD);
  const btn = await page.$('button[type="submit"], input[type="submit"], button:has-text("ログイン")');
  if (!btn) throw new Error('ログインボタンなし');
  await btn.click();
  await page.waitForNavigation({ waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(3000);
  if (page.url().includes('/login') || page.url().includes('id.stores.jp')) {
    throw new Error('ログイン失敗。STORES_EMAIL/STORES_PASSWORD を確認');
  }
  log(`  ✅ ログイン成功`);
  await page.goto(POS_ANALYSIS_REDIRECT, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(5000);
  log(`  ✅ POS分析セッション確立`);
}

// 店舗切替ボタン（カスタム dropdown）を発見
async function findStoreSwitcherButton(page) {
  // 1店舗を開いてヘッダーに店舗名ボタンを出す
  const firstStore = STORES.find(s => s.slug !== 'all');
  if (firstStore) {
    await page.goto(firstStore.url, { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(3000);
  }
  const handle = await page.evaluateHandle((excl) => {
    const buttons = Array.from(document.querySelectorAll('button[data-testid="button"]'));
    const cand = buttons.filter(b => {
      const t = b.textContent.trim();
      if (!t || t.length > 30) return false;
      if (excl.some(w => t.includes(w))) return false;
      if (!b.offsetParent) return false;
      return true;
    });
    if (cand.length === 0) return null;
    cand.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
    return cand[0];
  }, EXCLUDE_BUTTON_LABELS);
  const el = handle.asElement();
  return el;
}

// 展開→店舗名一覧取得
async function expandAndList(page, switchBtn) {
  await switchBtn.click();
  await page.waitForTimeout(1500);
  return await page.evaluate(() => {
    const cand = Array.from(document.querySelectorAll('[role="option"]'));
    return cand
      .filter(e => e.offsetParent !== null)
      .map(e => e.textContent.trim())
      .filter(t => t.length > 0 && t.length < 80 && t !== '全店舗');
  });
}

// 店舗をクリック→遷移後URLからsalesChannelIdを取得
async function clickAndCaptureId(page, name) {
  const clicked = await page.evaluate((n) => {
    const cand = Array.from(document.querySelectorAll('[role="option"]'));
    for (const e of cand) {
      if (e.textContent.trim() === n && e.offsetParent !== null) {
        e.click();
        return true;
      }
    }
    return false;
  }, name);
  if (!clicked) return null;
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(2000);
  const u = page.url();
  const m = u.match(/salesChannelId=([a-f0-9]{24})/);
  return m ? m[1] : null;
}

function slugify(name) {
  // 既知店舗名→slug マッピング（config.jsに合わせる）
  const map = {
    'Y! Y! hands名古屋': 'yyhands_nagoya',
    'Y! Y! hands東京': 'yyhands_tokyo',
    'Y! Y! hands大阪': 'yyhands_osaka',
    'Y! Y! hands新宿': 'yyhands_shinjuku',
    'Y! Y! hands渋谷': 'yyhands_shibuya',
    'Y! Y! hands原宿': 'yyhands_harajuku',
    'YASUMI LAB NAGOYA': 'yasumilab_nagoya',
    'YASUMI LAB TOKYO': 'yasumilab_tokyo',
    '2525ジュエリー名古屋': '2525jewelry_nagoya',
    'HELLO BONSAI CLUB': 'hello_bonsai',
  };
  if (map[name]) return map[name];
  // 未知店舗：英数字小文字化＋特殊文字除去
  return name
    .toLowerCase()
    .replace(/[!\s]/g, '_')
    .replace(/[^\w]/g, '')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
}

// fetch-stores-data.js が期待する形式に正規化した店舗名（既存名）に変換
function normalizeName(rawName) {
  // POSプルダウンの実際の表示 → fetch側の表示用名前
  const map = {
    'Y! Y! hands名古屋': 'YY HANDS名古屋',
    'Y! Y! hands東京': 'YYHANDS東京',
    'Y! Y! hands大阪': 'YYHANDS大阪',
    'Y! Y! hands新宿': 'YYHANDS新宿',
    'Y! Y! hands渋谷': 'YYHANDS渋谷',
    'Y! Y! hands原宿': 'YYHANDS原宿',
    'YASUMI LAB NAGOYA': 'YASUMI LAB名古屋',
    'YASUMI LAB TOKYO': 'YASUMI LAB TOKYO',
    '2525ジュエリー名古屋': '2525ジュエリー名古屋',
    'HELLO BONSAI CLUB': 'HELLO BONSAI CLUB',
  };
  return map[rawName] || rawName;
}

(async () => {
  ensureDirs();
  const browser = await chromium.launch({ headless: HEADLESS, slowMo: HEADLESS ? 0 : 200 });
  const ctx = await browser.newContext({ locale: 'ja-JP', viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();
  page.setDefaultTimeout(15000);

  let exitCode = 0;
  try {
    await login(page);
    log('🔎 店舗切替UI探索...');
    const switchBtn = await findStoreSwitcherButton(page);
    if (!switchBtn) throw new Error('店舗切替ボタンが見つからない（UI変更の可能性）');
    log(`  ✅ ${await switchBtn.evaluate(e => e.textContent.trim())}`);
    const names = await expandAndList(page, switchBtn);
    log(`  📋 ${names.length} 店舗を検出: ${names.join(', ')}`);

    const stores = [{ rawName: '全店舗', name: '全店舗', slug: 'all', salesChannelId: null }];
    for (const rawName of names) {
      const reBtn = await findStoreSwitcherButton(page);
      if (!reBtn) break;
      await reBtn.click();
      await page.waitForTimeout(1200);
      const id = await clickAndCaptureId(page, rawName);
      if (id) {
        stores.push({
          rawName,
          name: normalizeName(rawName),
          slug: slugify(rawName),
          salesChannelId: id,
        });
        log(`  ✅ ${rawName} → ${id}`);
      } else {
        log(`  ⚠️ ${rawName}: ID取得失敗`);
      }
    }

    if (stores.length < 2) throw new Error('取得店舗0件。マスタを更新せず終了');

    // 既存マスタとの差分検出
    let prev = null;
    if (fs.existsSync(MASTER_PATH)) {
      try { prev = JSON.parse(fs.readFileSync(MASTER_PATH, 'utf-8')); } catch {}
    }
    const prevSlugs = prev ? new Set(prev.stores.map(s => s.slug)) : new Set();
    const curSlugs = new Set(stores.map(s => s.slug));
    const added = stores.filter(s => !prevSlugs.has(s.slug));
    const removed = prev ? prev.stores.filter(s => !curSlugs.has(s.slug)) : [];

    const master = {
      generatedAt: new Date().toISOString(),
      source: 'POS分析画面プルダウン (button[data-testid="button"] + role=option)',
      storeCount: stores.length,
      stores,
    };
    fs.writeFileSync(MASTER_PATH, JSON.stringify(master, null, 2), 'utf-8');
    log(`💾 保存: ${MASTER_PATH} (${stores.length} 店舗)`);

    if (added.length > 0) log(`🆕 新規追加: ${added.map(s => s.name).join(', ')}`);
    if (removed.length > 0) log(`🗑  削除: ${removed.map(s => s.name).join(', ')}`);
    if (added.length === 0 && removed.length === 0) log('  差分なし（既存と同じ店舗構成）');
  } catch (err) {
    log(`❌ エラー: ${err.message}`);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'update_master_error.png'), fullPage: true });
    exitCode = 1;
  } finally {
    await browser.close();
  }
  process.exit(exitCode);
})();
