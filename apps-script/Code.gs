/**
 * ระบบจดวันลาทีมงาน — ตัวกลางเก็บข้อมูลบน Google Sheet
 *
 * วิธีติดตั้ง (ทำครั้งเดียว โดยคนใดคนหนึ่งในทีม)
 *  1. สร้าง Google Sheet ใหม่ 1 ไฟล์ ตั้งชื่ออะไรก็ได้
 *  2. เมนู Extensions → Apps Script แล้ววางโค้ดทั้งไฟล์นี้ทับของเดิม
 *  3. กด Deploy → New deployment → เลือก type เป็น "Web app"
 *       - Execute as:      Me
 *       - Who has access:  Anyone
 *  4. กด Deploy แล้วคัดลอก Web app URL (ลงท้ายด้วย /exec)
 *  5. เอา URL นั้นไปวางในหน้าเว็บจดวันลา ช่อง "ลิงก์ Google Sheet"
 *     แล้วแจก URL เดียวกันนี้ให้ทุกคนในทีม — ไม่ต้องล็อกอินหรือกรอก token ใด ๆ
 *
 * หมายเหตุ: ใครที่รู้ URL นี้จะอ่านและแก้ข้อมูลวันลาได้ จึงควรแจกเฉพาะในทีม
 * ถ้า URL หลุด ให้กด Deploy → Manage deployments → Archive แล้ว deploy ใหม่เพื่อเปลี่ยน URL
 */

/* approval ต่อท้ายคอลัมน์เดิมไว้ ชีตที่ใช้งานอยู่แล้วจะได้ไม่ต้องย้ายข้อมูล
   ค่าที่เป็นไปได้: pending (รออนุมัติ), approved (อนุมัติแล้ว), rejected (ไม่อนุมัติ)
   ช่องว่างถือว่า pending */
var SHEETS = {
  members: ['id', 'name', 'role', 'quota'],
  leaves:  ['id', 'memberId', 'date', 'span', 'note', 'approval'],
  deleted: ['id']
};

function doGet() {
  return jsonOut({ ok: true, data: readAll() });
}

function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);                       // กันสองคนเขียนทับกันพร้อมกัน
  } catch (err) {
    return jsonOut({ ok: false, error: 'ระบบกำลังถูกใช้งาน ลองใหม่อีกครั้ง' });
  }
  try {
    var incoming = JSON.parse(e.postData.contents);
    var merged = mergeStates(readAll(), normalize(incoming));
    writeAll(merged);
    return jsonOut({ ok: true, data: merged, savedAt: new Date().toISOString() });
  } catch (err) {
    return jsonOut({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

/* ---------- อ่าน/เขียนชีต ---------- */

function sheetFor(name) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.appendRow(SHEETS[name]);
    sh.setFrozenRows(1);
  }
  if (sh.getLastRow() === 0) sh.appendRow(SHEETS[name]);
  ensureHeader(sh, SHEETS[name]);
  return sh;
}

/** เขียนหัวตารางให้ครบเสมอ เผื่อชีตเดิมสร้างไว้ตอนที่ยังไม่มีคอลัมน์ใหม่ */
function ensureHeader(sh, cols) {
  var head = sh.getRange(1, 1, 1, cols.length).getValues()[0];
  for (var i = 0; i < cols.length; i++) {
    if (String(head[i]) !== cols[i]) {
      sh.getRange(1, 1, 1, cols.length).setValues([cols]);
      return;
    }
  }
}

function readSheet(name) {
  var sh = sheetFor(name);
  var cols = SHEETS[name];
  if (sh.getLastRow() < 2) return [];
  var values = sh.getRange(2, 1, sh.getLastRow() - 1, cols.length).getValues();
  return values
    .filter(function (row) { return String(row[0]).trim() !== ''; })
    .map(function (row) {
      var o = {};
      cols.forEach(function (c, i) {
        var v = row[i];
        if (c === 'quota') v = Number(v) || 0;
        else if (c === 'date' && v instanceof Date) v = Utilities.formatDate(v, 'Asia/Bangkok', 'yyyy-MM-dd');
        else if (c === 'approval') v = String(v).trim() || 'pending';
        else v = String(v);
        o[c] = v;
      });
      return o;
    });
}

function writeSheet(name, rows) {
  var sh = sheetFor(name);
  var cols = SHEETS[name];
  if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, cols.length).clearContent();
  if (!rows.length) return;
  var out = rows.map(function (o) {
    return cols.map(function (c) { return o[c] === undefined ? '' : o[c]; });
  });
  var range = sh.getRange(2, 1, out.length, cols.length);
  // บังคับคอลัมน์ date ให้เป็นข้อความ ไม่ให้ชีตแปลง "2026-12-09" เป็นวันที่แล้วคืนค่ากลับมาเป็น Date
  var dateCol = cols.indexOf('date');
  if (dateCol >= 0) sh.getRange(2, dateCol + 1, out.length, 1).setNumberFormat('@');
  range.setValues(out);
}

function readAll() {
  return {
    members: readSheet('members'),
    leaves:  readSheet('leaves'),
    deleted: readSheet('deleted').map(function (r) { return r.id; })
  };
}

function writeAll(state) {
  writeSheet('members', state.members);
  writeSheet('leaves',  state.leaves);
  writeSheet('deleted', state.deleted.map(function (id) { return { id: id }; }));
}

/* ---------- รวมข้อมูลของทุกคน ---------- */

function normalize(d) {
  d = d || {};
  return {
    members: d.members || [],
    leaves:  d.leaves  || [],
    deleted: d.deleted || []
  };
}

/** รวมแบบ union ตาม id โดยให้ของที่ส่งเข้ามาใหม่ทับของเดิม
 *  ส่วนที่เคยถูกลบ (deleted) จะไม่ถูกนำกลับมา */
function mergeStates(remote, local) {
  var del = {};
  remote.deleted.concat(local.deleted).forEach(function (id) { del[id] = true; });

  function merge(a, b) {
    var map = {};
    a.forEach(function (x) { map[x.id] = x; });
    b.forEach(function (x) { map[x.id] = x; });
    return Object.keys(map)
      .filter(function (id) { return !del[id]; })
      .map(function (id) { return map[id]; });
  }

  return {
    members: merge(remote.members, local.members),
    leaves:  merge(remote.leaves,  local.leaves),
    deleted: Object.keys(del)
  };
}

function jsonOut(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
