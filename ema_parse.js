/* ═══ EMA (ANCGVW · Reporte Estadístico EMA) PDF 판독기 — 2026-11-27 ═══
   · "Ventas Menudeo Segmento Pasajeros / Comerciales" 쪽에서 모델별 판매를 읽음
       세그먼트 · 모델 · 브랜드 · 원산지 · 당월 · 전년 동월 · 당해 누적(1월~당월) · 전년 누적
   · 표지/머리글의 "Octubre 2026" 으로 보고 월(YYYY-MM)을 정함
   · pdf.js 의 글자 위치(x, y)로 표를 재구성 — 머리글의 열 위치(oct-25 · oct-26 · Ene-Oct 25 · Ene-Oct 26)에
     가장 가까운 숫자를 그 열 값으로 씀 (빈칸 · 'n.c.' 에도 열이 밀리지 않음)
   사용: rfxEma.parse(pdfjsLib, arrayBuffer) → Promise<{ ym, label, rows:[…], pages, warn:[…] }> */
(function (root) {
  "use strict";
  var MES = { enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7, agosto: 8, septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12 };
  var AB = { ene: 1, feb: 2, mar: 3, abr: 4, may: 5, jun: 6, jul: 7, ago: 8, sep: 9, oct: 10, nov: 11, dic: 12 };
  function num(s) {
    s = String(s || "").trim();
    if (!s || /^n\.?c\.?$/i.test(s)) return null;
    if (/%$/.test(s)) return null;
    var v = Number(s.replace(/,/g, ""));
    return isFinite(v) ? v : null;
  }
  function isNum(s) { return /^-?[\d,]+(\.\d+)?%?$/.test(String(s).trim()) || /^n\.?c\.?$/i.test(String(s).trim()); }

  /* 한 쪽의 글자 조각 → 줄 [{y, items:[{x, w, s}]}] (같은 줄 = y 차이 2.5 이하) */
  function lines(items) {
    var arr = items.filter(function (it) { return String(it.str || "").trim() !== ""; }).map(function (it) {
      return { x: it.transform[4], y: it.transform[5], w: it.width || 0, s: String(it.str).trim() };
    }).sort(function (a, b) { return b.y - a.y || a.x - b.x; });
    var out = [];
    arr.forEach(function (it) {
      var L = out.length ? out[out.length - 1] : null;
      if (L && Math.abs(L.y - it.y) <= 2.5) L.items.push(it); else out.push({ y: it.y, items: [it] });
    });
    out.forEach(function (L) {
      L.items.sort(function (a, b) { return a.x - b.x; });
      /* pdf.js 가 한 칸을 여러 조각으로 줄 때 붙이기 (간격 2pt 이하) */
      var m = [];
      L.items.forEach(function (it) {
        var p = m[m.length - 1];
        if (p && it.x - (p.x + p.w) < 2.2 && !(isNum(p.s) && isNum(it.s))) { p.s += (it.x - (p.x + p.w) > 0.8 ? " " : "") + it.s; p.w = it.x + it.w - p.x; }
        else m.push({ x: it.x, w: it.w, s: it.s });
      });
      L.items = m;
    });
    return out;
  }
  function center(it) { return it.x + it.w / 2; }

  function parsePage(ls, kind, warn, pno, segIn) {
    /* 머리글: 왼쪽 표의 월 열 2개(예 oct-25 · oct-26), 오른쪽 표의 누적 열 2개(예 Ene-Oct 25 · Ene-Oct 26) */
    var colM = [], colY = [], colBrand = null, colOrig = null, split = null;
    ls.forEach(function (L) {
      L.items.forEach(function (it) {
        if (/^[a-z]{3}-\d{2}$/i.test(it.s) && AB[it.s.slice(0, 3).toLowerCase()]) colM.push(center(it));
        else if (/^Ene-[A-Za-z]{3}\s?\d{2}$/i.test(it.s)) colY.push(center(it));
        else if (/^Marca$/i.test(it.s) && colBrand == null) colBrand = it.x;
        else if (/^Origen$/i.test(it.s) && colOrig == null) colOrig = it.x;
        else if (/^Segmento\/Modelo$/i.test(it.s) && it.x > 300) split = it.x - 4;
      });
    });
    if (colM.length < 2 || colY.length < 2 || split == null) { warn.push(pno + "쪽: 표 머리글을 찾지 못함"); return []; }
    colM = colM.slice(0, 2).sort(function (a, b) { return a - b; });
    colY = colY.slice(0, 2).sort(function (a, b) { return a - b; });
    function near(it, cols) {                                 /* 숫자 조각 → 가장 가까운 열 (오른쪽 정렬 숫자라 끝 x 기준도 봄) */
      var c = center(it), r = it.x + it.w, best = -1, bd = 1e9;
      cols.forEach(function (x, i) { var d = Math.min(Math.abs(c - x), Math.abs(r - x - 12)); if (d < bd) { bd = d; best = i; } });
      return bd <= 26 ? best : -1;
    }
    var out = [], seg = segIn || "", cand = [];
    /* 모델 줄의 왼쪽 여백 x (소계 · 합계 줄은 들여쓰기 되어 있음) */
    var xs = [];
    ls.forEach(function (L) { var t = L.items.filter(function (it) { return it.x < split && !isNum(it.s); });
      if (t.length >= 2 && colBrand != null && t.some(function (it) { return Math.abs(it.x - colBrand) < 60; })) xs.push(Math.round(t[0].x)); });
    xs.sort(function (a, b) { return a - b; });
    var baseX = xs.length ? xs[Math.floor(xs.length / 2)] : 40;
    ls.forEach(function (L) {
      var left = L.items.filter(function (it) { return it.x < split; }), right = L.items.filter(function (it) { return it.x >= split; });
      if (!left.length) return;
      /* 모델명 칸 = 브랜드 열 왼쪽 (모델명이 "911.0" · "5008.0" 처럼 숫자 모양이어도 이름으로) · 숫자 칸 = 월 열 근처 */
      var numStart = colM[0] - 28;
      var txt = left.filter(function (it) { return center(it) < numStart && (!isNum(it.s) || (colBrand != null && it.x < colBrand - 8)); });
      var name = txt.length ? txt[0] : null;
      if (!name || name.x > 120) return;
      if (/^(Segmento\/Modelo|Marca|Origen|Comparativo|Var\.|MS |Abs\.|Fuente|EMA|Executive|Ventas|Total)/i.test(name.s)) return;
      var brand = txt.filter(function (it) { return it !== name && colBrand != null && Math.abs(it.x - colBrand) < 60 && it.x < (colOrig || 1e9) - 5; })[0];
      var orig = txt.filter(function (it) { return it !== name && it !== brand && colOrig != null && Math.abs(it.x - colOrig) < 60; })[0];
      var nums = left.filter(function (it) { return isNum(it.s) && center(it) >= numStart; });
      if (!brand) {                                          /* 브랜드 없는 줄 = 세그먼트 제목 · 소계 — 단, 여백이 모델 줄과 같고 숫자가 있으면 브랜드 빈칸인 모델 */
        if (!nums.length) { seg = name.s.replace(/\s+/g, " "); return; }
        if (Math.abs(name.x - baseX) > 6 || /^(TOT|TOTAL)\b/i.test(name.s) || name.s.replace(/\s+/g, " ").toUpperCase() === seg.toUpperCase()) return;
        brand = { s: "" };
      }
      var m = [null, null], y = [null, null];
      nums.forEach(function (it) { var k = near(it, colM); if (k >= 0 && m[k] == null) m[k] = num(it.s); });
      right.filter(function (it) { return isNum(it.s); }).forEach(function (it) { var k = near(it, colY); if (k >= 0 && y[k] == null) y[k] = num(it.s); });
      out.push({ kind: kind, seg: seg, nob: !brand.s ? 1 : 0, model: name.s.replace(/\s+/g, " "), brand: brand.s.replace(/\s+/g, " ").toUpperCase(), origin: orig ? orig.s : "",
        m_prev: m[0], m: m[1], ytd_prev: y[0], ytd: y[1], page: pno });
    });
    out.seg = seg;
    return out;
  }

  function monthOf(text) {
    var r = /(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)\s+(\d{4})/i.exec(text);
    if (!r) return null;
    var mm = MES[r[1].toLowerCase()];
    return r[2] + "-" + (mm < 10 ? "0" : "") + mm;
  }

  function parse(pdfjsLib, data) {
    return pdfjsLib.getDocument({ data: data }).promise.then(function (doc) {
      var n = doc.numPages, idx = [], i;
      for (i = 1; i <= n; i++) idx.push(i);
      var res = { ym: null, label: "", rows: [], pages: [], warn: [], numPages: n };
      var chain = Promise.resolve(), lastSeg = { pas: "", com: "" };
      idx.forEach(function (p) {
        chain = chain.then(function () { return doc.getPage(p); }).then(function (pg) { return pg.getTextContent(); }).then(function (tc) {
          var all = tc.items.map(function (it) { return it.str; }).join(" ");
          if (!res.ym && /Reporte|EMA|Executive/i.test(all)) { var y0 = monthOf(all); if (y0 && /Ventas|Reporte/i.test(all)) { res.ym = y0; res.label = (/(Enero|Febrero|Marzo|Abril|Mayo|Junio|Julio|Agosto|Septiembre|Setiembre|Octubre|Noviembre|Diciembre)\s+\d{4}/i.exec(all) || [""])[0]; } }
          var mm = /Ventas\s+Menudeo\s+Segmento\s+(Pasajeros|Comerciales)/i.exec(all);
          if (!mm) return;
          var kind = /Pasajeros/i.test(mm[1]) ? "pas" : "com";
          var ym2 = monthOf(all); if (ym2 && !res.ym) res.ym = ym2;
          var rows = parsePage(lines(tc.items), kind, res.warn, p, lastSeg[kind]);
          lastSeg[kind] = rows.seg || lastSeg[kind];
          res.pages.push(p); rows.forEach(function (r) { res.rows.push(r); });
        });
      });
      return chain.then(function () {
        /* 같은 브랜드·모델이 두 번 나오면(세그먼트 중복 표기) 판매가 큰 줄만 */
        var seen = {}, rows = [];
        res.rows.forEach(function (r) {
          var k = r.kind + "|" + r.brand + "|" + r.model.toUpperCase();
          if (seen[k]) { var o = seen[k]; if ((r.ytd || 0) > (o.ytd || 0)) { rows[rows.indexOf(o)] = r; seen[k] = r; } return; }
          seen[k] = r; rows.push(r);
        });
        res.rows = rows;
        if (!res.ym) res.warn.push("보고 월을 찾지 못함 — 직접 선택하세요");
        if (!res.rows.length) res.warn.push("모델별 판매 표(Ventas Menudeo Segmento)를 찾지 못함 — EMA 보고서가 맞는지 확인하세요");
        try { doc.destroy(); } catch (e) {}
        return res;
      });
    });
  }
  /* ═══ 대리점 견적서 PDF (Cotización de Servicio Postventa) — 2026-11-27 ═══
     머리글 "NUMERO DE PARTE · Cantidad · Precio U/ Sin IVA · Subtotal" 열 위치로 줄마다
     설명 · 부품번호(OE) · 수량 · 단가(부가세 별도) · 소계 를 읽음. 머리 정보: Marca · Vehículo · Fecha */
  function money(s) { var v = Number(String(s || "").replace(/[$,\s]/g, "")); return isFinite(v) && /\d/.test(s) ? v : null; }
  function parseQuote(pdfjsLib, data) {
    return pdfjsLib.getDocument({ data: data }).promise.then(function (doc) {
      var out = { brand: "", vehicle: "", date: "", rows: [], total: null, subtotal: null, iva: null, warn: [] }, chain = Promise.resolve();
      for (var p = 1; p <= doc.numPages; p++) (function (p) {
        chain = chain.then(function () { return doc.getPage(p); }).then(function (pg) { return pg.getTextContent(); }).then(function (tc) {
          var ls = lines(tc.items), hdr = null, col = {};
          ls.forEach(function (L, li) {
            var t = L.items.map(function (i) { return i.s; }).join(" ");
            function after(re) { var k = -1; L.items.forEach(function (it, j) { if (k < 0 && re.test(it.s)) k = j; }); if (k < 0) return "";
              var m = L.items[k].s.replace(re, "").trim(); var rest = L.items.slice(k + 1); var stop = rest.findIndex(function (it) { return /:$/.test(it.s); });
              return (m + " " + (stop >= 0 ? rest.slice(0, stop) : rest).map(function (i) { return i.s; }).join(" ")).trim(); }
            if (!out.brand && /Marca:/i.test(t)) out.brand = after(/^Marca:?/i);
            if (!out.date && /Fecha:/i.test(t)) out.date = after(/^Fecha:?/i);
            if (!out.vehicle && /Veh[ií]culo:/i.test(t)) out.vehicle = after(/^Veh[ií]culo:?/i);
            if (!hdr && /NUMERO|N[ÚU]MERO|PARTE/i.test(t) && /Cantidad/i.test(t)) {
              hdr = li;
              L.items.forEach(function (it) {
                if (/^N[ÚU]MERO/i.test(it.s) && col.part == null) col.part = it.x;
                else if (/^Cantidad/i.test(it.s)) col.qty = it.x;
                else if (/^Precio/i.test(it.s)) col.price = it.x;
                else if (/^Subtotal/i.test(it.s)) col.sub = it.x;
              });
            }
          });
          if (hdr == null || col.part == null || col.qty == null) { out.warn.push(p + "쪽: 견적 표 머리글(NUMERO DE PARTE · Cantidad)을 찾지 못함"); return; }
          if (col.price == null) col.price = col.qty + 40; if (col.sub == null) col.sub = col.price + 70;
          for (var li = hdr + 1; li < ls.length; li++) {
            var L = ls[li], txt = L.items.map(function (i) { return i.s; }).join(" ");
            if (/^\s*(Subtotal|IVA|TOTAL)\b/i.test(L.items.filter(function (i) { return i.s !== "$"; })[0] ? L.items.filter(function (i) { return i.s !== "$"; })[0].s : "")) {
              var v = money(L.items[L.items.length - 1].s), k = L.items.filter(function (i) { return i.s !== "$"; })[0].s.toLowerCase();
              if (/^subtotal/.test(k)) out.subtotal = v; else if (/^iva/.test(k)) out.iva = v; else out.total = v;
              continue;
            }
            if (/Nombre y|Firma|Vigencia|partir de/i.test(txt)) break;
            var desc = L.items.filter(function (i) { return i.x < col.part - 8; }).map(function (i) { return i.s; }).join(" ").replace(/\s+/g, " ").trim();
            var part = L.items.filter(function (i) { return i.x >= col.part - 25 && i.x < col.qty - 8; }).map(function (i) { return i.s; }).join(" ").replace(/\s+/g, "").trim();
            var qty = L.items.filter(function (i) { return i.x >= col.qty - 8 && i.x < col.price - 12 && /^\d+(\.\d+)?$/.test(i.s); })[0];
            var pr = L.items.filter(function (i) { return i.x >= col.price - 12 && i.x < col.sub - 10 && i.s !== "$"; }).map(function (i) { return money(i.s); }).filter(function (x) { return x != null; })[0];
            var sb = L.items.filter(function (i) { return i.x >= col.sub - 10 && i.s !== "$"; }).map(function (i) { return money(i.s); }).filter(function (x) { return x != null; })[0];
            if (!desc && !part) continue;
            out.rows.push({ desc: desc, oe: part, qty: qty ? +qty.s : null, price: pr == null ? null : pr, subtotal: sb == null ? null : sb, page: p });
          }
        });
      })(p);
      return chain.then(function () { try { doc.destroy(); } catch (e) {} if (!out.rows.length) out.warn.push("견적 줄을 찾지 못함"); return out; });
    });
  }
  /* 스페인어 부품명 → [부품 카테고리, 위치] 목록 ("IZQ Y DER" 는 좌 · 우 두 줄) */
  function quoteCat(desc) {
    var d = String(desc || "").toUpperCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    var front = !/TRASER/.test(d), up = /SUPERIOR/.test(d), lo = /INFERIOR/.test(d);
    var both = /(IZQ\w*\s*(Y|\/|-|E)\s*DER)|(DER\w*\s*(Y|\/|-|E)\s*IZQ)|AMBOS|PAR\b/.test(d);
    var side = both ? "LR" : /IZQ/.test(d) ? "LH" : /DER/.test(d) ? "RH" : "";
    var fr = front ? "Front" : "Rear", cat = "", pos = fr, sided = false;
    if (/SOPORTE.*(TRANSM|CAJA)/.test(d)) { cat = "TRANSMISSION MOUNT"; pos = ""; }
    else if (/SOPORTE.*MOTOR|SOPORTE DE MOTOR/.test(d)) { cat = "ENGINE MOUNT"; pos = ""; }
    else if (/BASE.*AMORT|SOPORTE.*AMORT|TOPE.*AMORT|STRUT MOUNT/.test(d)) { cat = "TOP STRUT MOUNT"; }
    else if (/AMORTIGUADOR/.test(d)) { cat = "SHOCK ABSORBER"; sided = true; }
    else if (/BUJE.*BARRA|BUJE.*ESTABILIZ/.test(d)) { cat = "STABILIZER BAR BUSHING"; }
    else if (/BUJE/.test(d)) { cat = "CONTROL ARM BUSHING"; pos = fr + (up ? " Upper" : " Lower"); }
    else if (/TORNILLO.*ESTABILIZ|LINK|ESTABILIZADOR/.test(d)) { cat = "STABILIZER LINK"; sided = true; }
    else if (/VARILLA INTERIOR|TERMINAL INTERIOR|AXIAL|BIELETA|INNER/.test(d)) { cat = "INNER TIE ROD"; sided = true; }
    else if (/TERMINAL/.test(d)) { cat = "OUTER TIE ROD"; sided = true; if (!side) side = "LR"; }
    else if (/ROTULA/.test(d)) { cat = "BALL JOINT"; pos = fr + (up ? " Upper" : " Lower"); sided = true; }
    else if (/HORQUILLA|BRAZO|CONTROL ARM/.test(d)) { cat = "CONTROL ARM"; pos = fr + (up ? " Upper" : " Lower"); sided = true; if (!side) side = "LR"; }
    if (!cat) return [];
    if (!sided || !side) return [[cat, pos]];
    if (side === "LR") return [[cat, pos + " LH"], [cat, pos + " RH"]];
    return [[cat, pos + " " + side]];
  }
  var api = { parse: parse, parseQuote: parseQuote, quoteCat: quoteCat, _lines: lines, _monthOf: monthOf };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.rfxEma = api;
})(this);
