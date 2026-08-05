// sync-stores-master.js
// STORES 公式 retail API の販売チャネル一覧を正本として data/stores_master.json を更新する。
//
// 【なぜ作ったか】
// 店舗マスタは従来 update-stores-master.js（POS分析画面のプルダウンをPlaywrightで走査）
// が週1回だけ更新していた。そのため
//   ・新店が開いても最大7日間レポートに出ない
//   ・店舗名の改称に追随できない（2026-08-05: 販売チャネル 69ae3f73… は公式API上
//     すでに「Coppice吉祥寺」なのにマスタは「YYHANDS新宿」のままで、吉祥寺の売上が
//     4日間ずっと新宿として報告されていた）
// という取りこぼしが起きた。公式APIなら店舗一覧は1リクエストで取れて名前も正本なので、
// 日次ジョブの先頭でこれを回し、新店追加・改称を自動で取り込む。
//
// 【設計上の約束】
//  1. 同一性は salesChannelId で判定する。名前ではなく ID で追跡するので改称に強い。
//  2. slug は一度決めたら変えない。slug は data/YYYYMM.json のキー・SHORT_NAMES の
//     参照キーなので、変えると過去データとの対応が壊れる。
//  3. APIに出てこない既知店舗は消さない（absentFromApi 印だけ付ける）。APIが一時的に
//     部分応答を返したときにマスタが縮んで売上が丸ごと欠ける事故を防ぐ。
//  4. 変化（新店・改称・API不在）は data/stores_master_changes.json に書き出し、
//     日次Slack通知が拾って可視化する。黙って変わらせない。
// ────────────────────────────────────────────────────────────

const path = require('path');
const fs = require('fs');

// .env 読み込み: dotenv があれば使い、無ければ手動で .env / ../.env を読む
try {
  require('dotenv').config();
} catch (_) {
  for (const p of [path.join(__dirname, '.env'), path.join(__dirname, '..', '.env')]) {
    try {
      for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
        const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
      }
    } catch (_) { /* noop */ }
  }
}

const { fetchSalesChannels } = require('./stores-api-client');

const DATA_DIR = path.join(__dirname, 'data');
const MASTER_PATH = path.join(DATA_DIR, 'stores_master.json');
const CHANGES_PATH = path.join(DATA_DIR, 'stores_master_changes.json');

// ── 表示名の上書き（既存のシートタブ名・Slack表記を維持するための対応表）──
// APIの生名（rawName）→ レポートで使う表示名。
// ここに無い名前は「APIの生名をそのまま表示名にする」。つまり新店・改称店は
// 何も足さなくても正しい名前で出る。既知店舗だけ従来表記を保って無用なタブ改名を防ぐ。
const DISPLAY_NAME_OVERRIDES = {
  'Y! Y! hands名古屋': 'YY HANDS名古屋',
  'Y! Y! hands東京': 'YYHANDS東京',
  'Y! Y! hands大阪': 'YYHANDS大阪',
  'Y! Y! hands新宿': 'YYHANDS新宿',
  'Y! Y! hands渋谷': 'YYHANDS渋谷',
  'Y! Y! hands原宿': 'YYHANDS原宿',
  'YASUMI LAB NAGOYA': 'YASUMI LAB名古屋',
};

function log(msg) {
  console.log(`[${new Date().toLocaleTimeString('ja-JP')}] ${msg}`);
}

function displayName(rawName) {
  return DISPLAY_NAME_OVERRIDES[rawName] || rawName;
}

// 新規店舗用の slug を作る。
// 旧 slugify は /[^\w]/ で日本語を丸ごと落としていたため
// 「Y! Y! hands京都」→ y_y_hands、「YASUMI LAB 代官山」→ yasumi_lab のように
// 地名が消え、同ブランドの2店目が必ず衝突していた。ローマ字部分が同じでも
// 衝突しないよう、日本語が落ちて曖昧になる場合はチャネルIDの末尾を付けて一意化する。
function makeSlug(rawName, salesChannelId, used) {
  const ascii = rawName
    .toLowerCase()
    .replace(/[!\s]+/g, '_')
    .replace(/[^\w]/g, '')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
  const hadNonAscii = /[^\x00-\x7F]/.test(rawName);
  // 日本語（店名の識別部分）が落ちている、または空・重複するならIDで一意化する
  let slug = ascii || 'store';
  if (!ascii || hadNonAscii || used.has(slug)) {
    slug = `${slug}_${String(salesChannelId).slice(-6)}`;
  }
  while (used.has(slug)) slug = `${slug}x`;
  return slug;
}

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch (_) {
    return null;
  }
}

async function main() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  const prev = readJson(MASTER_PATH);
  const prevStores = (prev && Array.isArray(prev.stores)) ? prev.stores : [];
  const prevById = new Map(prevStores.filter(s => s.salesChannelId).map(s => [s.salesChannelId, s]));

  log('🔎 STORES 公式APIから販売チャネル一覧を取得...');
  const channels = await fetchSalesChannels();
  if (!Array.isArray(channels) || channels.length === 0) {
    throw new Error('販売チャネル0件。マスタを更新せず終了（既存マスタを保持）');
  }
  log(`  📋 ${channels.length} 店舗を検出`);

  // 既存の並び順（=レポートの列順）を保つため、まず既知店舗を旧マスタの順で並べ、
  // 新店は末尾に足す。列順が毎日入れ替わるとレポートが読みにくくなるため。
  const used = new Set(prevStores.map(s => s.slug));
  const byId = new Map(channels.map(c => [c.id, c]));

  const stores = [{ rawName: '全店舗', name: '全店舗', slug: 'all', salesChannelId: null }];
  const added = [];
  const renamed = [];
  const absent = [];

  // 1) 旧マスタの順序を維持しつつ、APIの最新名で更新する
  for (const p of prevStores) {
    if (p.slug === 'all') continue;
    const ch = p.salesChannelId ? byId.get(p.salesChannelId) : null;
    if (!ch) {
      // APIに出てこない既知店舗 → 消さずに残す（部分応答による欠損事故の防止）
      absent.push(p.name);
      stores.push({ ...p, absentFromApi: true });
      continue;
    }
    const name = displayName(ch.name);
    const entry = {
      rawName: ch.name,
      name,
      slug: p.slug,                 // slug は不変（過去データとの対応を壊さない）
      salesChannelId: ch.id,
    };
    if (p.name !== name) {
      renamed.push({ slug: p.slug, from: p.name, to: name });
      entry.prevName = p.name;      // upload-gsheet がタブ改名に使う
    }
    stores.push(entry);
  }

  // 2) 旧マスタに無いチャネル = 新店。末尾に追加する
  for (const ch of channels) {
    if (prevById.has(ch.id)) continue;
    const slug = makeSlug(ch.name, ch.id, used);
    used.add(slug);
    const name = displayName(ch.name);
    stores.push({ rawName: ch.name, name, slug, salesChannelId: ch.id });
    added.push(name);
  }

  const master = {
    generatedAt: new Date().toISOString(),
    source: 'STORES 公式 retail API /sales_channels（sync-stores-master.js）',
    storeCount: stores.length,
    stores,
  };
  fs.writeFileSync(MASTER_PATH, JSON.stringify(master, null, 2), 'utf-8');
  log(`💾 保存: ${MASTER_PATH} (${stores.length} 店舗 / 全店舗含む)`);

  const changes = {
    checkedAt: master.generatedAt,
    added,
    renamed,
    absentFromApi: absent,
    hasChanges: added.length > 0 || renamed.length > 0 || absent.length > 0,
  };
  fs.writeFileSync(CHANGES_PATH, JSON.stringify(changes, null, 2), 'utf-8');

  if (added.length) log(`🆕 新規店舗: ${added.join(', ')}`);
  for (const r of renamed) log(`✏️  改称: ${r.from} → ${r.to}`);
  if (absent.length) log(`⚠️ APIに存在しない既知店舗（マスタ保持）: ${absent.join(', ')}`);
  if (!changes.hasChanges) log('  差分なし（既存と同じ店舗構成）');
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      // フェイルオープン: 同期に失敗しても既存マスタで日次処理を続けられるよう
      // 呼び出し側（index.js）が判断できる終了コードにする。
      console.error(`❌ 店舗マスタ同期エラー: ${err.message}`);
      process.exit(1);
    });
}

module.exports = { main, makeSlug, displayName, DISPLAY_NAME_OVERRIDES };
