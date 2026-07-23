/* 공용 엑셀/CSV 데이터 입력 위젯 — 시트/열/행범위 선택 후 숫자 행만 추출해 콜백.
 * window.DataInput.mount(container, { columns:[{key,label,numeric}], onData:fn(rows) })
 * SheetJS(xlsx.mini)는 파일을 올릴 때만 지연 로드. CSV/TXT는 자체 파서.
 */
(function () {
  "use strict";
  var SHEETJS_URL = "/tools/vendor/xlsx.mini.min.js";
  var loading = null;
  function loadXLSX() {
    if (window.XLSX) return Promise.resolve(window.XLSX);
    if (loading) return loading;
    loading = new Promise(function (res, rej) {
      var s = document.createElement("script");
      s.src = SHEETJS_URL;
      s.onload = function () { res(window.XLSX); };
      s.onerror = function () { rej(new Error("엑셀 파서를 불러오지 못했습니다.")); };
      document.head.appendChild(s);
    });
    return loading;
  }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function colLetter(i) { var s = ""; i++; while (i > 0) { var m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; }
  function toNum(c) { if (typeof c === "number") return c; if (c == null) return NaN; var s = String(c).replace(/,/g, "").trim(); if (s === "") return NaN; var v = parseFloat(s); return isFinite(v) ? v : NaN; }
  function parseCSV(text) {
    return text.split(/\r?\n/).filter(function (l) { return l.length; }).map(function (line) {
      var out = [], cur = "", q = false;
      for (var i = 0; i < line.length; i++) {
        var c = line[i];
        if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
        else { if (c === '"') q = true; else if (c === "," || c === "\t") { out.push(cur); cur = ""; } else cur += c; }
      }
      out.push(cur); return out;
    });
  }

  window.DataInput = {
    mount: function (container, opts) {
      var sheets = {}, names = [];
      container.innerHTML = '<input type="file" accept=".xlsx,.xls,.csv,.txt" class="tool-input" style="padding:9px" /><div data-r="msg" class="hint" style="margin:6px 0 0"></div><div data-r="picker" style="display:none;margin-top:12px;gap:12px"></div>';
      var input = container.querySelector("input"), picker = container.querySelector('[data-r="picker"]'), msg = container.querySelector('[data-r="msg"]');

      function colCount(rows) { var c = 0; rows.forEach(function (r) { if (r && r.length > c) c = r.length; }); return c; }
      function cur() { var s = picker.querySelector('[data-r="sheet"]'); return sheets[s ? s.value : names[0]] || []; }

      function build() {
        picker.style.display = "grid";
        var h = "";
        if (names.length > 1) h += '<label class="tool-label">시트<select class="tool-input" data-r="sheet">' + names.map(function (n) { return "<option>" + esc(n) + "</option>"; }).join("") + "</select></label>";
        h += '<div data-r="cols"></div>';
        h += '<div class="tool-row"><label class="tool-label">시작 행 (선택)<input type="number" min="1" step="1" class="tool-input" data-r="r0" placeholder="처음" /></label><label class="tool-label">끝 행 (선택)<input type="number" min="1" step="1" class="tool-input" data-r="r1" placeholder="끝" /></label></div>';
        h += '<div data-r="prev"></div><div data-r="count" class="hint" style="margin:0"></div>';
        picker.innerHTML = h;
        if (names.length > 1) picker.querySelector('[data-r="sheet"]').addEventListener("change", renderSheet);
        picker.querySelector('[data-r="r0"]').addEventListener("input", extract);
        picker.querySelector('[data-r="r1"]').addEventListener("input", extract);
        renderSheet();
      }

      function renderSheet() {
        var rows = cur(), nc = colCount(rows);
        var colOpts = "";
        for (var c = 0; c < nc; c++) {
          var samp = []; for (var r = 0; r < rows.length && samp.length < 3; r++) { var v = rows[r] && rows[r][c]; if (v != null && v !== "") samp.push(String(v).slice(0, 10)); }
          colOpts += '<option value="' + c + '">' + colLetter(c) + (samp.length ? " · " + esc(samp.join(", ")) : "") + "</option>";
        }
        picker.querySelector('[data-r="cols"]').className = "tool-row";
        picker.querySelector('[data-r="cols"]').innerHTML = opts.columns.map(function (col, i) {
          var def = Math.min(i, Math.max(0, nc - 1));
          var o = colOpts.replace('value="' + def + '"', 'value="' + def + '" selected');
          return '<label class="tool-label">' + esc(col.label) + '<select class="tool-input" data-col="' + col.key + '">' + o + "</select></label>";
        }).join("");
        picker.querySelectorAll("select[data-col]").forEach(function (s) { s.addEventListener("change", extract); });

        var cap = Math.min(rows.length, 60), ph = '<div style="overflow:auto;max-height:240px;border:1px solid var(--border);border-radius:10px"><table class="prev-table"><thead><tr><th>#</th>';
        for (var c2 = 0; c2 < nc; c2++) ph += "<th>" + colLetter(c2) + "</th>";
        ph += "</tr></thead><tbody>";
        for (var r2 = 0; r2 < cap; r2++) { ph += '<tr><td class="prev-rn">' + (r2 + 1) + "</td>"; for (var c3 = 0; c3 < nc; c3++) { var cell = rows[r2] && rows[r2][c3]; ph += "<td>" + esc(cell == null ? "" : String(cell).slice(0, 18)) + "</td>"; } ph += "</tr>"; }
        ph += "</tbody></table></div>" + (rows.length > cap ? '<div class="hint" style="margin:4px 0 0">미리보기는 처음 ' + cap + "행. 전체 " + rows.length + "행. 필요하면 시작/끝 행으로 범위를 좁히세요.</div>" : "");
        picker.querySelector('[data-r="prev"]').innerHTML = ph;
        extract();
      }

      function extract() {
        var rows = cur(), sel = {};
        opts.columns.forEach(function (col) { var s = picker.querySelector('select[data-col="' + col.key + '"]'); sel[col.key] = s ? +s.value : 0; });
        var r0 = parseInt(picker.querySelector('[data-r="r0"]').value, 10), r1 = parseInt(picker.querySelector('[data-r="r1"]').value, 10);
        var start = isFinite(r0) ? r0 - 1 : 0, end = isFinite(r1) ? r1 - 1 : rows.length - 1;
        var result = [];
        for (var i = Math.max(0, start); i <= Math.min(rows.length - 1, end); i++) {
          var row = rows[i], obj = {}, ok = true;
          opts.columns.forEach(function (col) {
            var raw = row ? row[sel[col.key]] : undefined;
            if (col.numeric === false) { if (raw == null || String(raw).trim() === "") ok = false; else obj[col.key] = String(raw); }
            else { var v = toNum(raw); if (!isFinite(v)) ok = false; else obj[col.key] = v; }
          });
          if (ok) result.push(obj);
        }
        picker.querySelector('[data-r="count"]').textContent = "추출된 데이터: " + result.length + "행";
        opts.onData(result);
      }

      input.addEventListener("change", function () {
        var f = input.files[0]; if (!f) return;
        msg.textContent = "불러오는 중…";
        var name = f.name.toLowerCase();
        if (/\.(csv|txt)$/.test(name)) {
          var rd = new FileReader();
          rd.onload = function () { try { sheets = { "데이터": parseCSV(rd.result) }; names = ["데이터"]; msg.textContent = ""; build(); } catch (e) { msg.innerHTML = '<span class="error">파일을 읽지 못했습니다.</span>'; } };
          rd.readAsText(f);
        } else {
          loadXLSX().then(function (XLSX) {
            var rd = new FileReader();
            rd.onload = function () {
              try {
                var wb = XLSX.read(new Uint8Array(rd.result), { type: "array" });
                sheets = {}; names = wb.SheetNames.slice();
                wb.SheetNames.forEach(function (n) { sheets[n] = XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, blankrows: false, defval: "" }); });
                msg.textContent = ""; build();
              } catch (e) { msg.innerHTML = '<span class="error">엑셀을 읽지 못했습니다: ' + esc(e.message || "") + "</span>"; }
            };
            rd.readAsArrayBuffer(f);
          }).catch(function (e) { msg.innerHTML = '<span class="error">' + esc(e.message) + "</span>"; });
        }
      });
    }
  };
})();
