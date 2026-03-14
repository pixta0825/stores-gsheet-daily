// upload-gsheet.js
// JSON データを Google Spreadsheet に書き込む
// ────────────────────────────────────────────────────────────
// 使い方:
//   node upload-gsheet.js                    → 当月データをアップロード
//   node upload-gsheet.js --month=202603     → 指定月
//   node upload-gsheet.js --dry-run          → プレビューのみ

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

const { STORES, COLUMNS } = require('./config');

// ── CLI引数 ──
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
function getArg(name) {
  const arg = args.find(a => a.startsWith(`--${name}=`));
  return arg ? arg.split('=')[1] : null;
}

const DATA_DIR = path.join(__dirname, 'data');
const FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID || '1ZiZE3bkB25aeeawQIPyiLazm_iabQJmj';

// ── 対象月 ──
function getTargetMonth() {
  const monthArg = getArg('month');
  if (monthArg) return monthArg;
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
  return `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
}

// ── Google API 認証 ──
function getAuth() {
  const credentialsJson = process.env.GOOGLE_CREDENTIALS;
  if (!credentialsJson) {
    throw new Error('❌ GOOGLE_CREDENTIALS が設定されていません');
  }

  const credentials = JSON.parse(credentialsJson);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: [
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/drive',
    ],
  });
  return auth;
}

// ── フォルダのアクセス確認 ──
async function verifyFolderAccess(drive) {
  try {
    const res = await drive.files.get({
      fileId: FOLDER_ID,
      fields: 'id, name',
      supportsAllDrives: true,
    });
    console.log(`📁 フォルダ確認OK: ${res.data.name} (${res.data.id})`);
    return true;
  } catch (err) {
    console.error(`❌ フォルダにアクセスできません (${FOLDER_ID})`);
    console.error(`  エラー: ${err.message}`);
    console.error('  → Google Drive フォルダをサービスアカウントと共有してください');
    console.error(`  → 共有先: stores-gsheet@stores-gsheet-daily.iam.gserviceaccount.com`);
    throw err;
  }
}

// ── フォルダ内の既存スプレッドシートを検索 ──
async function findExistingSpreadsheet(drive, title) {
  const res = await drive.files.list({
    q: `name='${title}' and '${FOLDER_ID}' in parents and mimeType='application/vnd.google-apps.spreadsheet' and trashed=false`,
    fields: 'files(id, name)',
    spaces: 'drive',
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  return res.data.files && res.data.files.length > 0 ? res.data.files[0] : null;
}

// ── スプレッドシート新規作成 ──
async function createSpreadsheet(sheets, drive, title, storeNames) {
  console.log(`📝 スプレッドシート新規作成: ${title}`);

  // Drive API でフォルダ内に直接作成
  const fileRes = await drive.files.create({
    resource: {
      name: title,
      mimeType: 'application/vnd.google-apps.spreadsheet',
      parents: [FOLDER_ID],
    },
    fields: 'id',
    supportsAllDrives: true,
  });
  const spreadsheetId = fileRes.data.id;
  console.log(`  ✅ ファイル作成完了: ${spreadsheetId}`);

  // デフォルトの Sheet1 を削除して店舗シートを追加
  const requests = [];

  // 店舗シートを追加
  for (let idx = 0; idx < storeNames.length; idx++) {
    requests.push({
      addSheet: {
        properties: {
          sheetId: idx + 1,
          title: storeNames[idx],
          index: idx,
        },
      },
    });
  }

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    resource: { requests },
  });

  // デフォルトのSheet1を削除
  const ssInfo = await sheets.spreadsheets.get({ spreadsheetId });
  const defaultSheet = ssInfo.data.sheets.find(s => s.properties.title === 'Sheet1');
  if (defaultSheet) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      resource: {
        requests: [{ deleteSheet: { sheetId: defaultSheet.properties.sheetId } }],
      },
    });
  }

  console.log(`  ✅ シート構成完了 (${storeNames.length}シート)`);
  return spreadsheetId;
}

// ── シートにデータを書き込み ──
async function writeSheetData(sheets, spreadsheetId, sheetTitle, rawData) {
  if (!rawData || rawData.length === 0) {
    console.log(`  ⚠️  ${sheetTitle}: データなし、スキップ`);
    return;
  }

  // ヘッダー行 + データ行を構築
  const rows = [COLUMNS]; // ヘッダー

  for (const row of rawData) {
    const label = String(row[0]);
    const values = row.slice(1).map(v => typeof v === 'number' ? v : 0);
    rows.push([label, ...values]);
  }

  // シート全体をクリアしてから書き込み
  const range = `'${sheetTitle}'!A1`;

  await sheets.spreadsheets.values.clear({
    spreadsheetId,
    range: `'${sheetTitle}'!A:K`,
  });

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range,
    valueInputOption: 'RAW',
    resource: { values: rows },
  });

  console.log(`  ✅ ${sheetTitle}: ${rows.length - 1}行書き込み`);
}

// ── 書式設定 ──
async function formatSheet(sheets, spreadsheetId, sheetId, sheetTitle, dataRowCount) {
  const requests = [
    // ヘッダー行: 白文字・紺背景・太字
    {
      repeatCell: {
        range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
        cell: {
          userEnteredFormat: {
            backgroundColor: { red: 0.16, green: 0.22, blue: 0.38 },
            textFormat: {
              foregroundColor: { red: 1, green: 1, blue: 1 },
              bold: true,
              fontFamily: 'Arial',
              fontSize: 10,
            },
            horizontalAlignment: 'CENTER',
          },
        },
        fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment)',
      },
    },
    // 期間合計行（2行目）: 太字・薄緑背景
    {
      repeatCell: {
        range: { sheetId, startRowIndex: 1, endRowIndex: 2 },
        cell: {
          userEnteredFormat: {
            backgroundColor: { red: 0.85, green: 0.95, blue: 0.85 },
            textFormat: { bold: true },
          },
        },
        fields: 'userEnteredFormat(backgroundColor,textFormat)',
      },
    },
    // 金額列（B〜H列）に数値フォーマット
    {
      repeatCell: {
        range: { sheetId, startRowIndex: 1, endRowIndex: dataRowCount + 1, startColumnIndex: 1, endColumnIndex: 7 },
        cell: {
          userEnteredFormat: {
            numberFormat: { type: 'NUMBER', pattern: '#,##0' },
          },
        },
        fields: 'userEnteredFormat.numberFormat',
      },
    },
    // 件数・点数列（G〜J列）に数値フォーマット
    {
      repeatCell: {
        range: { sheetId, startRowIndex: 1, endRowIndex: dataRowCount + 1, startColumnIndex: 7, endColumnIndex: 10 },
        cell: {
          userEnteredFormat: {
            numberFormat: { type: 'NUMBER', pattern: '#,##0' },
          },
        },
        fields: 'userEnteredFormat.numberFormat',
      },
    },
    // 単価列（K列）に数値フォーマット
    {
      repeatCell: {
        range: { sheetId, startRowIndex: 1, endRowIndex: dataRowCount + 1, startColumnIndex: 10, endColumnIndex: 11 },
        cell: {
          userEnteredFormat: {
            numberFormat: { type: 'NUMBER', pattern: '#,##0' },
          },
        },
        fields: 'userEnteredFormat.numberFormat',
      },
    },
    // 列幅の自動調整
    {
      autoResizeDimensions: {
        dimensions: { sheetId, dimension: 'COLUMNS', startIndex: 0, endIndex: 11 },
      },
    },
    // フィルタ設定
    {
      setBasicFilter: {
        filter: {
          range: { sheetId, startRowIndex: 0, endRowIndex: dataRowCount + 1, startColumnIndex: 0, endColumnIndex: 11 },
        },
      },
    },
  ];

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    resource: { requests },
  });

  // 自動調整後、A列の幅を取得して全列をA列幅に統一
  const ssDetail = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: 'sheets(properties.sheetId,data.columnMetadata.pixelSize)',
    ranges: [`'${sheetTitle}'`],
  });
  const targetSheet = ssDetail.data.sheets.find(s => s.properties.sheetId === sheetId);
  if (targetSheet && targetSheet.data && targetSheet.data[0] && targetSheet.data[0].columnMetadata) {
    const colAWidth = targetSheet.data[0].columnMetadata[0].pixelSize;
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      resource: {
        requests: [{
          updateDimensionProperties: {
            range: { sheetId, dimension: 'COLUMNS', startIndex: 0, endIndex: 11 },
            properties: { pixelSize: Math.round(colAWidth * 1.5) },
            fields: 'pixelSize',
          },
        }],
      },
    });
  }
}

// ── サマリーシート定義 ──
// 短縮店舗名マッピング
const SHORT_NAMES = {
  yyhands_nagoya: 'YY名古屋',
  yyhands_tokyo: 'YY東京',
  yyhands_osaka: 'YY大阪',
  yasumilab_nagoya: 'LAB',
  '2525jewelry_nagoya': '2525',
  hello_bonsai: 'BONSAI',
};

const SUMMARY_SHEETS = [
  { title: '純売上', colIndex: 1, format: 'NUMBER', pattern: '#,##0', chartTitle: '店舗別売上',     stacked: 'STACKED', lastColLabel: '合計' },
  { title: '客数',   colIndex: 9, format: 'NUMBER', pattern: '#,##0', chartTitle: '店舗別客数',     stacked: 'STACKED', lastColLabel: '合計' },
  { title: '単価',   colIndex: 10, format: 'NUMBER', pattern: '#,##0', chartTitle: '店舗別売上単価', stacked: null,      lastColLabel: '平均' },
];

// ── サマリーシート作成（店舗横並び + グラフ）──
async function createSummarySheets(sheets, spreadsheetId, allData, monthStr, colWidth) {
  // 個別店舗のみ（全店舗を除外）
  const individualStores = STORES.filter(s => s.slug !== 'all' && allData.stores[s.slug]);

  const allStoreData = allData.stores['all'];
  if (!allStoreData || !allStoreData.raw) return;

  // 月の日数を計算（月全日分のデータを生成）
  const year = parseInt(monthStr.substring(0, 4), 10);
  const mon = parseInt(monthStr.substring(4, 6), 10);
  const daysInMonth = new Date(year, mon, 0).getDate();

  // 店舗ごとの日別データを day番号 でルックアップ
  const storeDataByDay = {};
  for (const store of individualStores) {
    const sd = allData.stores[store.slug];
    storeDataByDay[store.slug] = {};
    if (sd && sd.raw) {
      for (const r of sd.raw) {
        const dayMatch = String(r[0]).match(/(\d+)日/);
        if (dayMatch && !String(r[0]).includes('期間合計')) {
          storeDataByDay[store.slug][parseInt(dayMatch[1], 10)] = r;
        }
      }
    }
  }
  // 全店舗データのルックアップ（単価の平均用）
  const allStoreByDay = {};
  for (const r of (allStoreData.raw || [])) {
    const dayMatch = String(r[0]).match(/(\d+)日/);
    if (dayMatch && !String(r[0]).includes('期間合計')) {
      allStoreByDay[parseInt(dayMatch[1], 10)] = r;
    }
  }

  const summarySheetIds = [];

  for (const summary of SUMMARY_SHEETS) {
    const sheetTitle = summary.title;

    // 現在のシート情報を取得
    let ssInfo = await sheets.spreadsheets.get({ spreadsheetId });
    const existingTitles = ssInfo.data.sheets.map(s => s.properties.title);

    // シートが無ければ作成
    if (!existingTitles.includes(sheetTitle)) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        resource: {
          requests: [{ addSheet: { properties: { title: sheetTitle } } }],
        },
      });
      ssInfo = await sheets.spreadsheets.get({ spreadsheetId });
    }

    const sheetObj = ssInfo.data.sheets.find(s => s.properties.title === sheetTitle);
    const sheetId = sheetObj.properties.sheetId;
    summarySheetIds.push(sheetId);

    // ヘッダー行: 日付 | 店舗1(短縮) | ... | 合計/平均
    const shortNames = individualStores.map(s => SHORT_NAMES[s.slug] || s.name);
    const header = ['日付', ...shortNames, summary.lastColLabel];

    // 月全日分のデータ行（数値で書き込み、0はフォーマットで"-"表示）
    const rows = [header];
    for (let day = 1; day <= daysInMonth; day++) {
      const dateLabel = `${day}日`;
      const storeValues = individualStores.map(s => {
        const row = storeDataByDay[s.slug][day];
        return row ? (row[summary.colIndex] || 0) : 0;
      });

      let lastCol;
      if (summary.lastColLabel === '平均') {
        const allRow = allStoreByDay[day];
        lastCol = allRow ? (allRow[summary.colIndex] || 0) : 0;
      } else {
        lastCol = storeValues.reduce((a, b) => a + b, 0);
      }

      rows.push([dateLabel, ...storeValues, lastCol]);
    }

    // シートクリア＆書き込み
    await sheets.spreadsheets.values.clear({
      spreadsheetId,
      range: `'${sheetTitle}'!A:Z`,
    });
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `'${sheetTitle}'!A1`,
      valueInputOption: 'RAW',
      resource: { values: rows },
    });

    const numCols = header.length;
    const numDataRows = rows.length - 1;

    // 既存グラフ・フィルタを削除
    const deleteRequests = [];
    if (sheetObj.charts) {
      for (const chart of sheetObj.charts) {
        deleteRequests.push({ deleteEmbeddedObject: { objectId: chart.chartId } });
      }
    }
    if (sheetObj.basicFilter) {
      deleteRequests.push({ clearBasicFilter: { sheetId } });
    }
    if (deleteRequests.length > 0) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        resource: { requests: deleteRequests },
      });
    }

    // 数値フォーマットパターン（ゼロを "-" 表示）
    const zeroFormat = `${summary.pattern};-${summary.pattern};"-"`;

    // 書式設定
    const formatRequests = [
      // ヘッダー行: 紺背景・白太字
      {
        repeatCell: {
          range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: numCols },
          cell: {
            userEnteredFormat: {
              backgroundColor: { red: 0.16, green: 0.22, blue: 0.38 },
              textFormat: { foregroundColor: { red: 1, green: 1, blue: 1 }, bold: true, fontFamily: 'Arial', fontSize: 10 },
              horizontalAlignment: 'CENTER',
            },
          },
          fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment)',
        },
      },
      // データ行の配置（右揃え）
      {
        repeatCell: {
          range: { sheetId, startRowIndex: 1, endRowIndex: numDataRows + 1, startColumnIndex: 1, endColumnIndex: numCols },
          cell: {
            userEnteredFormat: { horizontalAlignment: 'RIGHT' },
          },
          fields: 'userEnteredFormat.horizontalAlignment',
        },
      },
      // 数値フォーマット（ゼロを "-" 表示）
      {
        repeatCell: {
          range: { sheetId, startRowIndex: 1, endRowIndex: numDataRows + 1, startColumnIndex: 1, endColumnIndex: numCols },
          cell: {
            userEnteredFormat: {
              numberFormat: { type: summary.format, pattern: zeroFormat },
            },
          },
          fields: 'userEnteredFormat.numberFormat',
        },
      },
      // 合計/平均列を太字
      {
        repeatCell: {
          range: { sheetId, startRowIndex: 0, endRowIndex: numDataRows + 1, startColumnIndex: numCols - 1, endColumnIndex: numCols },
          cell: { userEnteredFormat: { textFormat: { bold: true } } },
          fields: 'userEnteredFormat.textFormat',
        },
      },
      // 列幅自動調整
      {
        autoResizeDimensions: {
          dimensions: { sheetId, dimension: 'COLUMNS', startIndex: 0, endIndex: numCols },
        },
      },
      // フィルタ
      {
        setBasicFilter: {
          filter: {
            range: { sheetId, startRowIndex: 0, endRowIndex: numDataRows + 1, startColumnIndex: 0, endColumnIndex: numCols },
          },
        },
      },
    ];

    // グラフ追加（リファレンスのスペックに準拠）
    const chartWidth = summary.stacked === null ? 1405 : 1080;
    const offsetX = summary.stacked === null ? 6 : 34;
    formatRequests.push({
      addChart: {
        chart: {
          position: {
            overlayPosition: {
              anchorCell: { sheetId, rowIndex: numDataRows + 3, columnIndex: 0 },
              widthPixels: chartWidth,
              heightPixels: 667,
              offsetXPixels: offsetX,
              offsetYPixels: 11,
            },
          },
          spec: {
            title: summary.chartTitle,
            fontName: 'Roboto',
            basicChart: {
              chartType: 'COLUMN',
              legendPosition: 'BOTTOM_LEGEND',
              stackedType: summary.stacked || 'NOT_STACKED',
              headerCount: 1,
              axis: [
                { position: 'BOTTOM_AXIS', title: '日付' },
                { position: 'LEFT_AXIS', title: '' },
              ],
              domains: [{
                domain: { sourceRange: { sources: [{ sheetId, startRowIndex: 0, endRowIndex: numDataRows + 1, startColumnIndex: 0, endColumnIndex: 1 }] } },
              }],
              // 個別店舗のみ（合計/平均列はグラフに含めない）
              series: shortNames.map((_, idx) => ({
                series: { sourceRange: { sources: [{ sheetId, startRowIndex: 0, endRowIndex: numDataRows + 1, startColumnIndex: idx + 1, endColumnIndex: idx + 2 }] } },
                targetAxis: 'LEFT_AXIS',
              })),
            },
          },
        },
      },
    });

    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      resource: { requests: formatRequests },
    });

    // 店舗シートと同じ列幅に統一
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      resource: {
        requests: [{
          updateDimensionProperties: {
            range: { sheetId, dimension: 'COLUMNS', startIndex: 0, endIndex: numCols },
            properties: { pixelSize: colWidth },
            fields: 'pixelSize',
          },
        }],
      },
    });

    console.log(`  📊 ${sheetTitle}: ${numDataRows}行 + グラフ作成`);
  }

  // サマリーシートをシートの先頭に移動（純売上→0, 客数→1, 単価→2）
  const reorderRequests = summarySheetIds.map((sheetId, idx) => ({
    updateSheetProperties: {
      properties: { sheetId, index: idx },
      fields: 'index',
    },
  }));
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    resource: { requests: reorderRequests },
  });
  console.log('  ✅ サマリーシートを先頭に移動');
}

// ── メイン処理 ──
async function main() {
  const monthStr = getTargetMonth();
  const year = parseInt(monthStr.substring(0, 4), 10);
  const month = parseInt(monthStr.substring(4, 6), 10);
  const title = `STORES_売上_${monthStr}`;

  console.log('═══════════════════════════════════════════');
  console.log(' Google Spreadsheet アップロード');
  console.log(` 対象月: ${year}年${month}月`);
  console.log(` スプレッドシート名: ${title}`);
  console.log(` フォルダ ID: ${FOLDER_ID}`);
  console.log(` モード: ${DRY_RUN ? 'DRY_RUN' : '本番'}`);
  console.log('═══════════════════════════════════════════\n');

  // JSONデータ読み込み
  const jsonPath = path.join(DATA_DIR, `${monthStr}.json`);
  if (!fs.existsSync(jsonPath)) {
    console.error(`❌ データファイルがありません: ${jsonPath}`);
    console.log('  ヒント: まず node fetch-stores-data.js でデータを取得してください');
    process.exit(1);
  }

  const allData = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
  const storeCount = Object.keys(allData.stores).length;
  console.log(`📂 データ読み込み: ${jsonPath} (${storeCount}店舗)`);

  if (DRY_RUN) {
    console.log('🔍 [DRY_RUN] アップロードをスキップ');
    return null;
  }

  // Google API 認証
  const auth = getAuth();
  const sheets = google.sheets({ version: 'v4', auth });
  const drive = google.drive({ version: 'v3', auth });

  // フォルダアクセス確認
  await verifyFolderAccess(drive);

  // 店舗名リスト（データに存在する店舗のみ）
  const storeNames = STORES
    .filter(s => allData.stores[s.slug])
    .map(s => s.name);

  // 既存スプレッドシートを検索
  let spreadsheetId;
  const existing = await findExistingSpreadsheet(drive, title);

  if (existing) {
    console.log(`📄 既存スプレッドシート発見: ${existing.name} (${existing.id})`);
    spreadsheetId = existing.id;

    // 既存シートの確認と不足分の追加
    const ssInfo = await sheets.spreadsheets.get({ spreadsheetId });
    const existingSheetTitles = ssInfo.data.sheets.map(s => s.properties.title);

    for (const name of storeNames) {
      if (!existingSheetTitles.includes(name)) {
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId,
          resource: {
            requests: [{ addSheet: { properties: { title: name } } }],
          },
        });
        console.log(`  📋 シート追加: ${name}`);
      }
    }
  } else {
    spreadsheetId = await createSpreadsheet(sheets, drive, title, storeNames);
  }

  // 各店舗のデータを書き込み
  const ssInfo = await sheets.spreadsheets.get({ spreadsheetId });
  const sheetMap = {};
  for (const s of ssInfo.data.sheets) {
    sheetMap[s.properties.title] = s.properties.sheetId;
  }

  for (const store of STORES) {
    const storeData = allData.stores[store.slug];
    if (!storeData) continue;

    await writeSheetData(sheets, spreadsheetId, store.name, storeData.raw);

    // 書式設定
    const sheetId = sheetMap[store.name];
    if (sheetId !== undefined && storeData.raw) {
      await formatSheet(sheets, spreadsheetId, sheetId, store.name, storeData.raw.length);
    }
  }

  // 店舗シートの列幅を取得（サマリーシートにも同じ幅を適用）
  const firstStoreName = STORES.find(s => allData.stores[s.slug])?.name;
  let storeColWidth = 100;
  if (firstStoreName && sheetMap[firstStoreName] !== undefined) {
    const ssDetailW = await sheets.spreadsheets.get({
      spreadsheetId,
      fields: 'sheets(properties.sheetId,data.columnMetadata.pixelSize)',
      ranges: [`'${firstStoreName}'`],
    });
    const ws = ssDetailW.data.sheets.find(s => s.properties.sheetId === sheetMap[firstStoreName]);
    if (ws?.data?.[0]?.columnMetadata?.[0]) {
      storeColWidth = ws.data[0].columnMetadata[0].pixelSize;
    }
  }

  // サマリーシート作成（純売上・客数・単価）
  console.log('\n📊 サマリーシート作成...');
  await createSummarySheets(sheets, spreadsheetId, allData, monthStr, storeColWidth);

  const url = `https://docs.google.com/spreadsheets/d/${spreadsheetId}`;
  console.log(`\n✅ 完了: ${url}`);

  // URLをファイルに保存（Slack通知で使用）
  fs.writeFileSync(path.join(__dirname, 'spreadsheet_url.txt'), url, 'utf-8');

  return url;
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}

module.exports = { main };
