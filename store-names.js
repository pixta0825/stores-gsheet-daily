// store-names.js
// 店舗の「正式表記」への切替（REQ-0722・恩田決定 2026-10-20）
//
// 正式12店（スペースなし）: YY名古屋／YY東京／YY新宿／YY原宿／YY渋谷／YY京都／
//   LAB名古屋／LAB東京／LAB大阪／LAB代官山／2525／吉祥寺
//
// 切替ルール（OFFICIAL_NAME_FROM = 2026-11-01）
//   ① 月別スプレッドシート（ファイル・タブ・列見出し）は「データの月」で判定。
//      2026年11月以降の月ファイルは正式表記。10月以前は従来表記のまま（書き換えない）。
//      → 11/1朝の実行は10/31分＝10月ファイルを処理するので、旧表記のまま。
//   ② Slack本文は「投稿日（JST）」で判定。2026-11-01以降に投稿するものから正式表記。
//
// 店舗の同一性は名前でなく salesChannelId で追う（改称・使い回しがあるため）。
// stores_master.json の `name` は従来表記（10月以前の表記）のまま残し、
// 正式表記は `officialName` に別持ちする（商品別週次など外部の読み手は officialName を使う）。

const OFFICIAL_NAME_FROM = process.env.OFFICIAL_NAME_FROM || '2026-11-01';

// salesChannelId → 正式表記
const OFFICIAL_NAME_BY_CHANNEL_ID = {
  '681b02b1b7ac330049f2abcc': 'YY名古屋',
  '6940c8274683791b9ae0058a': 'YY東京',
  '6940c855e0c48f1a99481d83': 'LAB大阪',
  '6940c871bd17481c37c99de9': 'LAB名古屋',
  '6940c888bd17481c37c99dea': '2525',
  '6960aeb4e7c5ab0aaa10f966': 'YY京都',
  '69ae3f7326307605f0833d2f': '吉祥寺',     // Coppice吉祥寺（旧YY新宿のチャネル・営業終了）
  '69e03136d9e28df3f61314ba': 'LAB東京',
  '69f43c0d248f8c08e31ba380': 'YY渋谷',
  '69f43d5cfc56600a9d3552c2': 'YY原宿',
  '6a4f4ad412d0390a4fe48186': 'LAB代官山',
};

function officialNameOf(store) {
  if (!store) return null;
  if (store.slug === 'all') return store.name;
  return (store.salesChannelId && OFFICIAL_NAME_BY_CHANNEL_ID[store.salesChannelId]) || store.officialName || null;
}

// 'YYYY-MM-DD'（JST暦日）が正式表記の期間か
function isOfficialYmd(ymd) { return String(ymd) >= OFFICIAL_NAME_FROM; }

// 'YYYYMM' の月ファイルが正式表記か（月初日で判定）
function isOfficialMonth(yyyymm) {
  const s = String(yyyymm);
  return isOfficialYmd(`${s.slice(0, 4)}-${s.slice(4, 6)}-01`);
}

// 今日のJST暦日。FORCE_TODAY=YYYY-MM-DD は検証用の差し替え。
function todayJstYmd() {
  if (process.env.FORCE_TODAY) return process.env.FORCE_TODAY;
  const j = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
  return `${j.getFullYear()}-${String(j.getMonth() + 1).padStart(2, '0')}-${String(j.getDate()).padStart(2, '0')}`;
}

// 月ファイル用の店舗リスト。正式月なら name=正式表記、prevName=従来表記
// （旧名タブが残っていた場合に upload-gsheet の自動改名で拾う）。
function storesForMonth(stores, yyyymm) {
  if (!isOfficialMonth(yyyymm)) return stores;
  return stores.map((s) => {
    const off = officialNameOf(s);
    if (!off || off === s.name) return s;
    return { ...s, name: off, prevName: s.name };
  });
}

// Slack表示名（投稿日で判定）。legacyName は従来表記。
function slackName(store, legacyName) {
  const off = officialNameOf(store);
  if (isOfficialYmd(todayJstYmd()) && off) return off;
  return legacyName || (store && store.name);
}

// 従来・正式どちらの見出しでも同じ店舗とみなすための別名表 → 正式表記
function aliasToOfficial(masterStores) {
  const m = {};
  for (const s of masterStores) {
    const off = officialNameOf(s);
    if (!off) continue;
    for (const n of [s.name, s.rawName, s.prevName, off]) if (n) m[n] = off;
  }
  return m;
}

module.exports = {
  OFFICIAL_NAME_FROM, OFFICIAL_NAME_BY_CHANNEL_ID,
  officialNameOf, isOfficialYmd, isOfficialMonth, todayJstYmd,
  storesForMonth, slackName, aliasToOfficial,
};
