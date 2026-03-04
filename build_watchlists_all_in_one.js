const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const YahooFinance = require('yahoo-finance2').default;
const Holidays = require('date-holidays');

const yf = new YahooFinance();
const hd = new Holidays('JP');

const JPX_LIST_PAGE = 'https://www.jpx.co.jp/markets/statistics-equities/misc/01.html';
const OUTPUT_BASENAME = 'tradingview_tse_price_le_1000';
const PRICE_THRESHOLD = 1000;
const MAX_SYMBOLS_PER_FILE = 1000;

const INCLUDE_PRIME = true;
const INCLUDE_STANDARD = true;
const INCLUDE_GROWTH = true;
const INCLUDE_FOREIGN_STOCKS = true;

const PREFIX = 'TSE';
const BATCH_SIZE = 100;
const SLEEP_MS = 1200;
const MAX_ERROR_LOGS = 30;

const NOTIFY_ONLY_ON_THIRD_BUSINESS_DAY = true;
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || '';
const DISCORD_MENTION = '<@470776296931065866>';

const MARKET_COL_CANDIDATES = ['市場・商品区分', '市場商品区分', '市場区分'];
const CODE_COL_CANDIDATES = ['コード', '銘柄コード'];
const EXCLUDE_KEYWORDS = ['ETF', 'ETN', 'REIT', 'インフラファンド', '出資証券', '優先出資証券'];

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function normalizeCode(value) { if (value === null || value === undefined) return ''; let s = String(value).trim(); if (s.endsWith('.0')) s = s.slice(0, -2); return s; }
function pickColumn(columns, candidates) { for (const c of candidates) { if (columns.includes(c)) return c; } throw new Error(`必要な列が見つかりませんでした。候補: ${candidates.join(', ')} / 実際の列: ${columns.join(', ')}`); }
function isPrimeMarket(marketValue) { return marketValue.includes('プライム'); }
function isStandardMarket(marketValue) { return marketValue.includes('スタンダード'); }
function isGrowthMarket(marketValue) { return marketValue.includes('グロース'); }
function isForeignStock(marketValue) { return marketValue.includes('外国株式'); }
function isTargetMarket(marketValue) { const prime = INCLUDE_PRIME && isPrimeMarket(marketValue); const standard = INCLUDE_STANDARD && isStandardMarket(marketValue); const growth = INCLUDE_GROWTH && isGrowthMarket(marketValue); return prime || standard || growth; }
function csvEscape(value) { const s = String(value ?? ''); if (s.includes(',') || s.includes('"') || s.includes('\n')) return `"${s.replace(/"/g, '""')}"`; return s; }
function writeCsv(file, rows) { const header = ['tv_symbol', 'yahoo_symbol', 'current_price']; const lines = [header.join(',')]; for (const row of rows) { lines.push([csvEscape(row.tv_symbol), csvEscape(row.yahoo_symbol), csvEscape(String(row.current_price))].join(',')); } fs.writeFileSync(path.resolve(file), '\uFEFF' + lines.join('\n'), 'utf8'); }
function writeTxt(file, symbols) { fs.writeFileSync(path.resolve(file), symbols.join(','), 'utf8'); }
function chunkArray(array, size) { const chunks = []; for (let i = 0; i < array.length; i += size) chunks.push(array.slice(i, i + size)); return chunks; }
function buildOutputFileName(index, totalFiles) { const seq = String(index + 1).padStart(3, '0'); if (totalFiles === 1) return `${OUTPUT_BASENAME}.txt`; return `${OUTPUT_BASENAME}_${seq}.txt`; }
function tvToYahoo(tvSymbol) { const [, code] = tvSymbol.split(':'); return { tvSymbol, yahooSymbol: `${code}.T` }; }
function toJstDate(now = new Date()) { return new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Tokyo' })); }
function formatYmd(date) { const y = date.getFullYear(); const m = String(date.getMonth() + 1).padStart(2, '0'); const d = String(date.getDate()).padStart(2, '0'); return `${y}-${m}-${d}`; }
function isBusinessDayJp(date) { const day = date.getDay(); if (day === 0 || day === 6) return false; return !hd.isHoliday(date); }
function getBusinessDayNumberInMonthJst(date) { const y = date.getFullYear(); const m = date.getMonth(); let count = 0; for (let d = 1; d <= date.getDate(); d++) { const current = new Date(y, m, d); if (isBusinessDayJp(current)) count++; } return count; }
function isThirdBusinessDayJst(date) { if (!isBusinessDayJp(date)) return false; return getBusinessDayNumberInMonthJst(date) === 3; }

async function sendDiscordUpdateReminder(todayYmd, fileCount, symbolCount) {
  if (!DISCORD_WEBHOOK_URL) {
    console.log('DISCORD_WEBHOOK_URL が未設定のため、Discord通知をスキップします。');
    return;
  }

  const targetFiles = Array.from({ length: fileCount }, (_, i) => `\`${buildOutputFileName(i, fileCount)}\``).join('\n');

  const body = {
    content: `${DISCORD_MENTION} 銘柄リストの更新をお願いします。`,
    embeds: [
      {
        title: '📌 TradingView 銘柄リスト更新通知',
        description: `株価が ${PRICE_THRESHOLD.toLocaleString('ja-JP')} 円以下の銘柄リストを作成しました。\nTradingView へのインポートをお願いします。`,
        color: 0xf39c12,
        fields: [
          { name: '日付', value: todayYmd, inline: true },
          { name: '抽出銘柄数', value: String(symbolCount), inline: true },
          { name: '分割ファイル数', value: String(fileCount), inline: true },
          { name: '対象ファイル', value: targetFiles || '-', inline: false }
        ],
        timestamp: new Date().toISOString()
      }
    ],
    allowed_mentions: { users: ['470776296931065866'] }
  };

  const res = await fetch(DISCORD_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Discord通知失敗: ${res.status} ${text}`);
  }
}

async function fetchText(url) { const res = await fetch(url); if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`); return await res.text(); }
async function fetchBuffer(url) { const res = await fetch(url); if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`); const ab = await res.arrayBuffer(); return Buffer.from(ab); }
function resolveUrl(base, relative) { return new URL(relative, base).toString(); }

function findJpxExcelUrl(html) {
  const hrefs = [...html.matchAll(/href="([^"]+\.(?:xls|xlsx))"/gi)].map(m => m[1]);
  const scored = hrefs.map(href => {
    const s = href.toLowerCase();
    let score = 0;
    if (s.includes('data_j')) score += 100;
    if (s.includes('xls')) score += 10;
    if (s.includes('misc')) score += 5;
    return { href, score };
  }).sort((a, b) => b.score - a.score);
  if (scored.length === 0) throw new Error('JPXページからExcelリンクを見つけられませんでした。');
  return resolveUrl(JPX_LIST_PAGE, scored[0].href);
}

async function downloadJpxWorkbook() {
  const html = await fetchText(JPX_LIST_PAGE);
  const excelUrl = findJpxExcelUrl(html);
  console.log(`JPX Excel URL: ${excelUrl}`);
  const fileBuffer = await fetchBuffer(excelUrl);
  return XLSX.read(fileBuffer, { type: 'buffer' });
}

function extractTradingViewSymbolsFromWorkbook(workbook) {
  const firstSheetName = workbook.SheetNames[0];
  const worksheet = workbook.Sheets[firstSheetName];
  const rows = XLSX.utils.sheet_to_json(worksheet, { defval: '' });
  if (!rows.length) throw new Error('JPXのExcelにデータがありません。');

  const columns = Object.keys(rows[0]).map(c => String(c).trim());
  const marketCol = pickColumn(columns, MARKET_COL_CANDIDATES);
  const codeCol = pickColumn(columns, CODE_COL_CANDIDATES);

  const symbols = [];
  const seen = new Set();

  for (const row of rows) {
    const marketValue = String(row[marketCol] ?? '').trim();
    const excluded = EXCLUDE_KEYWORDS.some(k => marketValue.includes(k));
    if (excluded) continue;

    const targetMarket = isTargetMarket(marketValue);
    const foreignStock = isForeignStock(marketValue);
    if (!targetMarket && !(INCLUDE_FOREIGN_STOCKS && foreignStock)) continue;

    const code = normalizeCode(row[codeCol]);
    if (!code) continue;

    const tvSymbol = `${PREFIX}:${code}`;
    if (seen.has(tvSymbol)) continue;
    seen.add(tvSymbol);
    symbols.push(tvSymbol);
  }

  return symbols;
}

async function fetchCurrentPrice(yahooSymbol) {
  const result = await yf.quote(yahooSymbol);
  if (!result) return null;

  const candidates = [
    result.regularMarketPrice,
    result.currentPrice,
    result.previousClose
  ];

  for (const value of candidates) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }

  return null;
}

async function main() {
  const todayJst = toJstDate();
  const todayYmd = formatYmd(todayJst);
  const isThirdBusinessDay = isThirdBusinessDayJst(todayJst);
  const businessDayNumber = isBusinessDayJp(todayJst) ? getBusinessDayNumberInMonthJst(todayJst) : null;

  console.log(`JST today: ${todayYmd}`);
  console.log(`Business day: ${isBusinessDayJp(todayJst)}`);
  console.log(`Business day number in month: ${businessDayNumber ?? 'N/A'}`);
  console.log(`Third business day: ${isThirdBusinessDay}`);

  console.log('JPXの上場銘柄一覧を取得中...');
  const workbook = await downloadJpxWorkbook();

  console.log('TradingView用銘柄リストを抽出中...');
  const tvSymbols = extractTradingViewSymbolsFromWorkbook(workbook);
  const mapped = tvSymbols.map(tvToYahoo);

  console.log(`抽出銘柄数: ${tvSymbols.length}`);

  const rows = [];
  let errorCount = 0;

  for (let i = 0; i < mapped.length; i += BATCH_SIZE) {
    const chunk = mapped.slice(i, i + BATCH_SIZE);
    console.log(`株価取得中: ${i + 1} - ${i + chunk.length} / ${mapped.length}`);

    for (const item of chunk) {
      try {
        const currentPrice = await fetchCurrentPrice(item.yahooSymbol);
        rows.push({ tv_symbol: item.tvSymbol, yahoo_symbol: item.yahooSymbol, current_price: currentPrice });
      } catch (err) {
        if (errorCount < MAX_ERROR_LOGS) console.log(`取得失敗: ${item.yahooSymbol} / ${err.message}`);
        else if (errorCount === MAX_ERROR_LOGS) console.log('取得失敗ログが多いため、以降は省略します。');
        errorCount += 1;
        rows.push({ tv_symbol: item.tvSymbol, yahoo_symbol: item.yahooSymbol, current_price: null });
      }
    }

    if (i + BATCH_SIZE < mapped.length) await sleep(SLEEP_MS);
  }

  const filteredRows = rows.filter(row => row.current_price !== null && row.current_price <= PRICE_THRESHOLD).sort((a, b) => a.current_price - b.current_price);
  const chunks = chunkArray(filteredRows, MAX_SYMBOLS_PER_FILE);

  chunks.forEach((chunk, index) => {
    const fileName = buildOutputFileName(index, chunks.length);
    writeTxt(fileName, chunk.map(row => row.tv_symbol));
    console.log(`出力TXT: ${fileName} (${chunk.length}銘柄)`);
  });

  writeCsv(`${OUTPUT_BASENAME}.csv`, filteredRows);

  console.log('---');
  console.log(`母集団銘柄数: ${tvSymbols.length}`);
  console.log(`株価取得できた銘柄数: ${rows.filter(row => row.current_price !== null).length}`);
  console.log(`${PRICE_THRESHOLD}円以下の抽出件数: ${filteredRows.length}`);
  console.log(`分割数: ${chunks.length}`);
  console.log(`失敗件数: ${errorCount}`);
  console.log(`CSV: ${OUTPUT_BASENAME}.csv`);

  if (!NOTIFY_ONLY_ON_THIRD_BUSINESS_DAY || isThirdBusinessDay) {
    await sendDiscordUpdateReminder(todayYmd, chunks.length, filteredRows.length);
  } else {
    console.log('本日は第3営業日ではないため、Discord通知を送りません。');
  }
}

main().catch(async err => {
  console.error(err);
  if (DISCORD_WEBHOOK_URL) {
    try {
      const body = {
        content: `${DISCORD_MENTION} 銘柄リスト更新処理でエラーが発生しました。`,
        embeds: [
          {
            title: '❌ TradingView 銘柄リスト更新エラー',
            description: String(err.message || err),
            color: 0xe74c3c,
            timestamp: new Date().toISOString()
          }
        ],
        allowed_mentions: { users: ['470776296931065866'] }
      };

      await fetch(DISCORD_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
    } catch (_) {}
  }
  process.exit(1);
});
