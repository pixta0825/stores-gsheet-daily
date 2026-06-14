// verify-gate.js — 証拠ゲート（Loop Engineering の「証拠で検証」ステップ）
//
// 定期レポートの Slack 配信"前"に当日数値を検証し、警告配列を返す共通モジュール。
// 設計方針:
//   - flag-only: 配信はブロックしない。チームに数値は届けつつ異常を目立たせる。
//   - 3段の階層チェック: (1)件数sanity (2)鮮度freshness (3)前回比anomaly
//   - 自己完結: 外部依存なし。各リポにこのファイルを複製して require する。
//
// 正本: Documents/claude/scripts/verify-gate.js
// 複製先: kot-attendance/src/, stores-gsheet-daily/, stores-weekly-item-sales/src/
//
// 使い方:
//   const { verifyGate, buildWarningBanner } = require('./verify-gate');
//   const r = verifyGate({ label:'KOT勤怠', metrics, prev, expect });
//   if (!r.ok) message = buildWarningBanner(r.warnings, 'KOT勤怠') + message;

'use strict';

/**
 * @param {object} o
 * @param {string} [o.label]   表示名（ログ用）
 * @param {object} o.metrics   今回の指標 { key: number, ... }
 * @param {object} [o.prev]    前期の指標 { key: number, ... }（前回比に使用。無ければ前回比スキップ）
 * @param {object} o.expect    検証条件
 *   expect.counts   = { key: {min:Number, name:String} }            // sanity
 *   expect.freshness= { actual:String, expected:String, label:String } // freshness
 *   expect.anomaly  = { keys:{key:{name,threshold}}, defaultThreshold:0.4 } // 前回比
 * @returns {{ok:boolean, warnings:string[]}}
 */
function verifyGate({ label, metrics, prev, expect } = {}) {
  const warnings = [];
  metrics = metrics || {};
  expect = expect || {};

  // (1) sanity: 主要カウントが取得できているか / 極端に少なくないか
  if (expect.counts) {
    for (const [key, cfg] of Object.entries(expect.counts)) {
      const name = (cfg && cfg.name) || key;
      const v = Number(metrics[key]);
      if (!Number.isFinite(v)) {
        warnings.push(`${name}が取得できていません（値=${metrics[key]}）`);
      } else if (cfg && cfg.min != null && v < cfg.min) {
        warnings.push(`${name}が想定より少ない（${v} < 最低${cfg.min}）— 取得欠損の可能性`);
      }
    }
  }

  // (2) freshness: データ対象日が想定日付か
  if (expect.freshness && expect.freshness.expected) {
    const { actual, expected, label: fl } = expect.freshness;
    const fname = fl || 'データ';
    if (!actual) {
      warnings.push(`${fname}の対象日が不明（鮮度チェック不可）`);
    } else if (String(actual) !== String(expected)) {
      warnings.push(`${fname}の対象日が想定とズレ（実=${actual} / 想定=${expected}）— 古いデータの可能性`);
    }
  }

  // (3) 前回比: 主要合計が前期比で閾値超え（prev があるときだけ）
  if (prev && expect.anomaly && expect.anomaly.keys) {
    const dft = expect.anomaly.defaultThreshold != null ? expect.anomaly.defaultThreshold : 0.4;
    for (const [key, cfg] of Object.entries(expect.anomaly.keys)) {
      const name = (cfg && cfg.name) || key;
      const th = (cfg && cfg.threshold != null) ? cfg.threshold : dft;
      const cur = Number(metrics[key]);
      const pv = Number(prev[key]);
      if (!Number.isFinite(cur) || !Number.isFinite(pv) || pv === 0) continue;
      const delta = (cur - pv) / Math.abs(pv);
      if (Math.abs(delta) > th) {
        const pct = Math.round(delta * 100);
        const sign = pct > 0 ? '+' : '';
        warnings.push(
          `${name}が前回比${sign}${pct}%（今回${cur} / 前回${pv}）— 閾値±${Math.round(th * 100)}%超`
        );
      }
    }
  }

  return { ok: warnings.length === 0, warnings };
}

/** 警告から Slack 用の⚠️バナー文字列を作る。警告ゼロなら空文字。 */
function buildWarningBanner(warnings, label) {
  if (!warnings || !warnings.length) return '';
  const head = `⚠️ 要確認${label ? `（${label}）` : ''}：自動検証で異常を検知しました`;
  const body = warnings.map((w) => `• ${w}`).join('\n');
  return `${head}\n${body}\n────────────\n`;
}

module.exports = { verifyGate, buildWarningBanner };
