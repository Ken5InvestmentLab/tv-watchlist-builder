const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const YahooFinance = require('yahoo-finance2').default;

const yf = new YahooFinance();

const JPX_LIST_PAGE = 'https://www.jpx.co.jp/markets/statistics-equities/misc/01.html';
const OUTPUT_DIR = 'output';
const OUTPUT_BASENAME = 'tradingview_tse_price_le_1000';
const PRICE_THRESHOLD = 1000;
const MAX_SYMBOLS_PER_FILE = 1000;
const MAX_WATCHLIST_FILES = 2;
const MAX_TOTAL_SYMBOLS = MAX_SYMBOLS_PER_FILE * MAX_WATCHLIST_FILES;

const INCLUDE_PRIME = true;
const INCLUDE_STANDARD = true;
const INCLUDE_GROWTH = true;
const INCLUDE_FOREIGN_STOCKS = true;

const PREFIX = 'TSE';
const BATCH_SIZE = 100;
const SLEEP_MS = 1200;
const MAX_ERROR_LOGS = 30;

const MARKET_COL_CANDIDATES = ['市場・商品区分', '市場商品区分', '市場区分'];
const CODE_COL_CANDIDATES = ['コード', '銘柄コード'];
const EXCLUDE_KEYWORDS = ['ETF', 'ETN', 'REIT', 'インフラファンド', '出資証券', '優先出資証券'];

let debugCount = 0;

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function ensureOutputDir() { fs.mkdirSync(path.resolve(OUTPUT_DIR), { recursive: true }); }
function outPath(fileName) { return path.resolve(OUTPUT_DIR, fileName); }
function normalizeCode(value) { if (value === null || value === undefined) return ''; let s = String(value).trim(); if (s.endsWith('.0')) s = s.slice(0, -2); return s; }
function pickColumn(columns, candidates) { for (const c of candidates) { if (columns.includes(c)) return c; } throw new Error(`必要な列が見つかりませんでした。候補: ${candidates.join(', ')} / 実際の列: ${columns.join(', ')}`); }
function isPrimeMarket(marketValue) { return marketValue.includes('プライム'); }
function isStandardMarket(marketValue) { return marketValue.includes('スタンダード'); }
function isGrowthMarket(marketValue) { return marketValue.includes('グロース'); }
function isForeignStock(marketValue) { return marketValue.includes('外国株式'); }
function isTargetMarket(marketValue) { const prime = INCLUDE_PRIME && isPrimeMarket(marketValue); const standard = INCLUDE_STANDARD && isStandardMarket(marketValue); const growth = INCLUDE_GROWTH && isGrowthMarket(marketValue); return prime || standard || growth; }
function csvEscape(value) { const s = String(value ?? ''); if (s.includes(',') || s.includes('"') || s.includes('\n')) return `"${s.replace(/"/g, '""')}"`; return s; }
function writeCsv(file, rows) {
  const header = ['tv_symbol', 'yahoo_symbol', 'previous_close', 'volume'];
  const lines = [header.join(',')];
  for (const row of rows) {
    lines.push([
      csvEscape(row.tv_symbol),
      csvEscape(row.yahoo_symbol),
      csvEscape(String(row.previous_close)),
      csvEscape(String(row.volume ?? '')),
    ].join(','));
  }
  fs.writeFileSync(outPath(file), '\uFEFF' + lines.join('\n'), 'utf8');
}
function writeTxt(file, symbols) { fs.writeFileSync(outPath(file), symbols.join(','), 'utf8'); }
function chunkArray(array, size) { const chunks = []; for (let i = 0; i < array.length; i += size) chunks.push(array.slice(i, i + size)); return chunks; }
function buildOutputFileName(index) { const seq = String(index + 1).padStart(3, '0'); return `${OUTPUT_BASENAME}_${seq}.txt`; }
function tvToYahoo(tvSymbol) { const [, code] = tvSymbol.split(':'); return { tvSymbol, yahooSymbol: `${code}.T` }; }

async function fetchText(url) { const res = await fetch(url); if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`); return await res.text(); }
async function fetchBuffer(url) { const res = await fetch(url); if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`); const ab = await res.arrayBuffer(); return Buffer.from(ab); }
function resolveUrl(base, relative) { return new URL(relative, base).toString(); }

function clearOldOutputFiles() {
  ensureOutputDir();
  const dir = path.resolve(OUTPUT_DIR);
  for (const file of fs.readdirSync(dir)) {
    if (
      file.startsWith(OUTPUT_BASENAME) &&
      (file.endsWith('.txt') || file.endsWith('.csv'))
    ) {
      fs.unlinkSync(path.join(dir, file));
    }
  }
}

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

function firstFiniteNumber(...values) {
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

async function fetchQuoteMetrics(yahooSymbol) {
  const result = await yf.quote(yahooSymbol);
  if (!result) return { previousClose: null, volume: null };

  if (debugCount < 10) {
    console.log(`DEBUG ${yahooSymbol} regularMarketPreviousClose=${result.regularMarketPreviousClose} previousClose=${result.previousClose} regularMarketVolume=${result.regularMarketVolume} averageDailyVolume10Day=${result.averageDailyVolume10Day} averageDailyVolume3Month=${result.averageDailyVolume3Month}`);
    debugCount += 1;
  }

  const previousClose = firstFiniteNumber(
    result.regularMarketPreviousClose,
    result.previousClose,
  );

  const volume = firstFiniteNumber(
    result.regularMarketVolume,
    result.averageDailyVolume10Day,
    result.averageDailyVolume3Month,
  );

  return { previousClose, volume };
}

async function main() {
  ensureOutputDir();
  clearOldOutputFiles();

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
    console.log(`前日終値/出来高取得中: ${i + 1} - ${i + chunk.length} / ${mapped.length}`);

    for (const item of chunk) {
      try {
        const metrics = await fetchQuoteMetrics(item.yahooSymbol);
        rows.push({
          tv_symbol: item.tvSymbol,
          yahoo_symbol: item.yahooSymbol,
          previous_close: metrics.previousClose,
          volume: metrics.volume,
        });
      } catch (err) {
        if (errorCount < MAX_ERROR_LOGS) console.log(`取得失敗: ${item.yahooSymbol} / ${err.message}`);
        else if (errorCount === MAX_ERROR_LOGS) console.log('取得失敗ログが多いため、以降は省略します。');
        errorCount += 1;
        rows.push({
          tv_symbol: item.tvSymbol,
          yahoo_symbol: item.yahooSymbol,
          previous_close: null,
          volume: null,
        });
      }
    }

    if (i + BATCH_SIZE < mapped.length) await sleep(SLEEP_MS);
  }

  const filteredRows = rows.filter(row => row.previous_close !== null && row.previous_close <= PRICE_THRESHOLD);

  let outputRows = [...filteredRows];
  let cappedByVolume = false;

  if (outputRows.length > MAX_TOTAL_SYMBOLS) {
    outputRows.sort((a, b) => {
      const volA = Number.isFinite(a.volume) ? a.volume : -1;
      const volB = Number.isFinite(b.volume) ? b.volume : -1;
      if (volB !== volA) return volB - volA;
      return a.previous_close - b.previous_close;
    });
    outputRows = outputRows.slice(0, MAX_TOTAL_SYMBOLS);
    cappedByVolume = true;
  } else {
    outputRows.sort((a, b) => a.previous_close - b.previous_close);
  }

  const chunks = chunkArray(outputRows, MAX_SYMBOLS_PER_FILE).slice(0, MAX_WATCHLIST_FILES);

  chunks.forEach((chunk, index) => {
    const fileName = buildOutputFileName(index);
    writeTxt(fileName, chunk.map(row => row.tv_symbol));
    console.log(`出力TXT: ${OUTPUT_DIR}/${fileName} (${chunk.length}銘柄)`);
  });

  writeCsv(`${OUTPUT_BASENAME}.csv`, outputRows);

  console.log('---');
  console.log(`母集団銘柄数: ${tvSymbols.length}`);
  console.log(`前日終値を取得できた銘柄数: ${rows.filter(row => row.previous_close !== null).length}`);
  console.log(`${PRICE_THRESHOLD}円以下の抽出件数: ${filteredRows.length}`);
  console.log(`最終出力件数: ${outputRows.length}`);
  console.log(`分割数: ${chunks.length}`);
  console.log(`出来高上位2000件制限: ${cappedByVolume ? 'ON' : 'OFF'}`);
  console.log(`失敗件数: ${errorCount}`);
  console.log(`CSV: ${OUTPUT_DIR}/${OUTPUT_BASENAME}.csv`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
