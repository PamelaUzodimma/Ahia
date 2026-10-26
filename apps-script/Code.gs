/**
 * Ahia backend (Google Apps Script web app)
 * Actions: record_sale, get_daily_sales
 *
 * Setup once:
 * 1. Extensions > Apps Script, paste this file.
 * 2. Project Settings > Script Properties > add API_KEY = (a long random string).
 * 3. Run setup() once and authorise.
 * 4. Deploy > New deployment > Web app > Execute as: Me, Access: Anyone.
 * 5. Put the /exec URL into the Chord tools, with ?key=YOUR_API_KEY on the end
 *    if Chord cannot send a fixed api_key field in the body.
 *
 * The backend, not the language model, calculates all totals.
 */

var TZ = 'Africa/Lagos';
var SHEET_NAME = 'Sales';
var HEADERS = [
  'transaction_id', 'created_at', 'trading_date', 'line_no', 'product',
  'quantity', 'unit_price', 'line_total', 'payment_method',
  'transaction_total', 'status', 'payload_hash'
];
var PAYMENTS = ['cash', 'transfer', 'pos'];
var MAX_LINES = 20;
var DUP_WINDOW_MS = 3 * 60 * 1000; // identical sale within 3 minutes = suspected duplicate

// ---------- one-time setup ----------
function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME) || ss.insertSheet(SHEET_NAME);
  sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]).setFontWeight('bold');
  sheet.setFrozenRows(1);
  // keep ids and dates as plain text so Sheets never converts them
  ['A', 'B', 'C', 'L'].forEach(function (col) {
    sheet.getRange(col + ':' + col).setNumberFormat('@');
  });
}

// ---------- entry point ----------
function doPost(e) {
  try {
    var body = JSON.parse((e.postData && e.postData.contents) || '{}');
    var expected = PropertiesService.getScriptProperties().getProperty('API_KEY');
    var supplied = (e.parameter && e.parameter.key) || body.api_key;
    if (!expected || supplied !== expected) {
      return out({ ok: false, error_code: 'UNAUTHORIZED', message: 'Access key missing or wrong.' });
    }
    if (body.action === 'record_sale') return out(recordSale(body));
    if (body.action === 'get_daily_sales') return out(getDailySales(body));
    return out({ ok: false, error_code: 'UNKNOWN_ACTION', message: 'Unknown action: ' + body.action });
  } catch (err) {
    return out({ ok: false, error_code: 'SERVER_ERROR', message: 'Something went wrong on the server. Nothing was confirmed as saved.' });
  }
}

function out(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// ---------- helpers ----------
function todayStr() {
  return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
}

function dayStr(v) {
  if (v instanceof Date) return Utilities.formatDate(v, TZ, 'yyyy-MM-dd');
  return String(v);
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function normalisePayment(p) {
  var s = String(p || '').toLowerCase().trim();
  if (s === 'bank transfer' || s === 'transfer' || s === 'tfr') return 'transfer';
  if (s === 'cash') return 'cash';
  if (s === 'pos' || s === 'pos machine' || s === 'card') return 'pos';
  return null;
}

function validateLines(lines) {
  if (!Array.isArray(lines) || lines.length === 0) {
    return { error: { error_code: 'NO_ITEMS', message: 'No items were provided.' } };
  }
  if (lines.length > MAX_LINES) {
    return { error: { error_code: 'TOO_MANY_ITEMS', message: 'Maximum ' + MAX_LINES + ' items per sale.' } };
  }
  var clean = [];
  for (var i = 0; i < lines.length; i++) {
    var l = lines[i] || {};
    var n = i + 1;
    var product = String(l.product || '').trim();
    var qty = Number(l.quantity);
    var price = Number(l.unit_price);
    var pay = normalisePayment(l.payment_method);
    if (!product) return { error: { error_code: 'MISSING_PRODUCT', message: 'Item ' + n + ' has no product name.' } };
    if (!isFinite(qty) || qty <= 0 || Math.floor(qty) !== qty) {
      return { error: { error_code: 'BAD_QUANTITY', message: 'Item ' + n + ' (' + product + '): quantity must be a whole number above 0.' } };
    }
    if (!isFinite(price) || price <= 0) {
      return { error: { error_code: 'BAD_PRICE', message: 'Item ' + n + ' (' + product + '): unit price must be above 0.' } };
    }
    if (!pay) {
      return { error: { error_code: 'BAD_PAYMENT', message: 'Item ' + n + ' (' + product + '): payment must be cash, transfer or pos.' } };
    }
    clean.push({ product: product, quantity: qty, unit_price: price, payment_method: pay, line_total: round2(qty * price) });
  }
  return { lines: clean };
}

function hashLines(lines) {
  var raw = JSON.stringify(lines.map(function (l) {
    return [l.product.toLowerCase(), l.quantity, l.unit_price, l.payment_method];
  }));
  var digest = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, raw);
  return Utilities.base64Encode(digest);
}

// ---------- record_sale ----------
function recordSale(body) {
  var v = validateLines(body.lines);
  if (v.error) return { ok: false, error_code: v.error.error_code, message: v.error.message };
  var lines = v.lines;
  var hash = hashLines(lines);

  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
  } catch (e) {
    return { ok: false, error_code: 'BUSY', message: 'System busy. Nothing was confirmed as saved. Please try again.' };
  }

  try {
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
    if (!sheet) return { ok: false, error_code: 'NOT_SET_UP', message: 'Sales sheet missing. Run setup().' };

    var lastRow = sheet.getLastRow();
    var data = lastRow > 1 ? sheet.getRange(2, 1, lastRow - 1, HEADERS.length).getValues() : [];
    var now = new Date();
    var today = todayStr();

    // duplicate protection (unless the user confirmed it is a genuine second sale)
    if (body.allow_duplicate !== true) {
      for (var r = data.length - 1; r >= 0 && r >= data.length - 200; r--) {
        if (String(data[r][11]) === hash && String(data[r][10]) === 'RECORDED') {
          var age = now.getTime() - new Date(String(data[r][1])).getTime();
          if (age >= 0 && age < DUP_WINDOW_MS) {
            return {
              ok: false,
              error_code: 'POSSIBLE_DUPLICATE',
              message: 'An identical sale was recorded a moment ago (' + data[r][0] + '). Not saved again. Ask the user if this is a genuine second sale; if yes, retry with allow_duplicate true.',
              existing_transaction_id: String(data[r][0])
            };
          }
        }
      }
    }

    // sequential id per day: AHI-YYYYMMDD-0001
    var seen = {};
    var count = 0;
    for (var i = 0; i < data.length; i++) {
      if (dayStr(data[i][2]) === today && !seen[data[i][0]]) {
        seen[data[i][0]] = true;
        count++;
      }
    }
    var txId = 'AHI-' + today.replace(/-/g, '') + '-' + ('0000' + (count + 1)).slice(-4);

    var total = 0;
    lines.forEach(function (l) { total += l.line_total; });
    total = round2(total);

    var rows = lines.map(function (l, idx) {
      return [txId, now.toISOString(), today, idx + 1, l.product, l.quantity, l.unit_price,
              l.line_total, l.payment_method, total, 'RECORDED', hash];
    });
    sheet.getRange(lastRow + 1, 1, rows.length, HEADERS.length).setValues(rows);
    SpreadsheetApp.flush();

    return { ok: true, transaction_id: txId, trading_date: today, lines: lines, transaction_total: total };
  } catch (err) {
    return { ok: false, error_code: 'WRITE_FAILED', message: 'Could not save. Nothing was confirmed as saved.' };
  } finally {
    lock.releaseLock();
  }
}

// ---------- get_daily_sales ----------
function getDailySales(body) {
  var date = String(body.date || '').trim();
  if (!date) date = todayStr();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return { ok: false, error_code: 'BAD_DATE', message: 'Date must be YYYY-MM-DD.' };
  }

  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
  if (!sheet) return { ok: false, error_code: 'NOT_SET_UP', message: 'Sales sheet missing. Run setup().' };

  var lastRow = sheet.getLastRow();
  var data = lastRow > 1 ? sheet.getRange(2, 1, lastRow - 1, HEADERS.length).getValues() : [];

  var tx = {};
  var byPayment = { cash: 0, transfer: 0, pos: 0 };
  var products = {};
  var total = 0;

  data.forEach(function (row) {
    if (dayStr(row[2]) !== date || String(row[10]) !== 'RECORDED') return;
    var pay = String(row[8]);
    var lt = Number(row[7]);
    tx[row[0]] = true;
    total += lt;
    byPayment[pay] = round2((byPayment[pay] || 0) + lt);
    var name = String(row[4]).toLowerCase();
    products[name] = (products[name] || 0) + Number(row[5]);
  });

  var top = Object.keys(products)
    .map(function (k) { return { product: k, quantity_sold: products[k] }; })
    .sort(function (a, b) { return b.quantity_sold - a.quantity_sold; })
    .slice(0, 5);

  total = round2(total);
  var split = round2(byPayment.cash + byPayment.transfer + byPayment.pos);

  return {
    ok: true,
    date: date,
    transaction_count: Object.keys(tx).length,
    total_sales: total,
    by_payment: byPayment,
    top_products: top,
    totals_reconcile: split === total,
    note: 'Recorded sales only. Not verified cash or physical stock.'
  };
}
