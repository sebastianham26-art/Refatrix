/* ═══ 시장 데이터 공통 계산 (EMA 판매 × 저장 VIO) — 2026-11-27 ═══
   · match(rows, vehicles, alias)   EMA 모델 → 차량·부품 마스터 차종 (브랜드 묶음 + 이름 정규화 + 수동 지정 alias)
   · series(rows)                    월별 판매 · 연간 누적을 모델별로 재구성 (당월 · 전년 동월 · 누적 · 전년 누적)
   · sumRange(S, a, b)               기간(YYYY-MM ~ YYYY-MM) 판매 합계 + 자료 범위(정확/추정)
   · build(opts)                     차종별 표: 저장 VIO · 기준월 이후 판매 · 추정 VIO · 기간 판매 · 순위
   브라우저: window.rfxMkt · node: module.exports */
(function (root) {
  "use strict";
  var BR = {
    vw: "volkswagen", volkswagen: "volkswagen", vwp: "volkswagen", vwvc: "volkswagen",
    chevrolet: "chevrolet", gm: "chevrolet", generalmotors: "chevrolet", gmc: "gmc",
    ford: "ford", fordmotor: "ford", lincoln: "lincoln",
    mitsubishi: "mitsubishi", mitsubishimotors: "mitsubishi",
    gwm: "gwm", greatwallmotors: "gwm", greatwallmotor: "gwm", greatwall: "gwm",
    mb: "mercedesbenz", mercedesbenz: "mercedesbenz", mercedes: "mercedesbenz",
    mg: "mg", mgmotor: "mg",
    dodge: "dodge", ram: "dodge", chrysler: "chrysler", jeep: "jeep", fiat: "fiat",
    jac: "jac", jacnfz: "jac", kia: "kia", hyundai: "hyundai", seat: "seat", seatcupra: "seat", cupra: "seat"
  };
  var GRP = { jeep: ["chrysler"], dodge: ["chrysler"], chrysler: ["dodge", "jeep"], gmc: ["chevrolet"], chevrolet: ["gmc"] };
  function nb(b) { var k = String(b || "").toLowerCase().replace(/[^a-z0-9]/g, ""); return BR[k] || k; }
  var SUF = /\b(sedan|sedán|hatchback|hatch|sportback|coupe|coupé|cabrio|convertible|wagon|van|cargo|pasajeros|chasis|cabina|doble|sencilla|crew|cab|pick ?up|pickup|4x4|4x2|hev|phev|hybrid|híbrido|ev|e-power|epower|turbo|nuevo|new)\b/gi;
  function nm(s) { return String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\.0$/, "").replace(/[^a-z0-9]/g, ""); }
  function nmCore(s) { return nm(String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(SUF, " ")); }
  /* 다른 차종을 뜻하는 꼬리말 — 앞부분이 같아도 연결하지 않음 */
  var DIFF = { cross: 1, euv: 1, ev: 1, etech: 1, e: 1, electric: 1, electrico: 1, max: 1, l: 1, xl: 1, sport: 1, rs: 1, gt: 1, gti: 1, n: 1, hev: 1, phev: 1, emi: 1, dmi: 1 };
  function toks(s) {
    var x = String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\.0$/, "").replace(SUF, " ");
    x = x.replace(/([a-z])-(\d)/g, "$1$2").replace(/(\d)-([a-z])/g, "$1$2");                 /* CX-5 → cx5 · HB-20 → hb20 */
    return x.split(/[^a-z0-9]+/).filter(Boolean);
  }
  function ekey(r) { return (r.brand || "") + "|" + r.model; }               /* EMA 모델 키 (원문) */
  function vkey(v) { return v.brand + "|" + v.model; }                        /* 마스터 차종 키 */

  /* alias: { "BRAND|Model": "Brand|Model" (마스터 키) | "-" (연결 안 함) } */
  function match(emaKeys, vehicles, alias) {
    alias = alias || {};
    var byBrand = {};
    vehicles.forEach(function (v) { var b = nb(v.brand); (byBrand[b] = byBrand[b] || []).push(v); });
    /* 마스터 차종 이름도 앞의 브랜드 단어를 뗀 이름으로 비교 ("KIA K3 Sedán" → "K3 Sedán") */
    function vn(v) {
      var mdl = String(v.model || ""), f = mdl.split(/\s+/)[0], w = String(v.brand || "").split(/\s+/)[0].replace(/[^A-Za-z0-9]/g, "");
      var st = mdl;
      if (w && new RegExp("^" + w + "\\s+", "i").test(mdl)) st = mdl.replace(new RegExp("^" + w + "\\s+", "i"), "");
      else if (BR[f.toLowerCase().replace(/[^a-z0-9]/g, "")] && mdl.split(/\s+/).length > 1) st = mdl.slice(f.length).trim();   /* "Jeep Compass" (Chrysler) */
      return st !== mdl && st.length >= 2 ? [mdl, st] : [mdl];
    }
    var out = {};
    emaKeys.forEach(function (k) {
      if (alias[k] != null) { out[k] = alias[k] === "-" ? null : { key: alias[k], how: "manual" }; return; }
      var p = k.split("|"), b = nb(p[0]), m0 = p.slice(1).join("|");
      /* 이름 후보: 원문 + 앞의 브랜드 단어를 뗀 이름 ("Honda City" → "City" · "Mazda 3 Sedan" 은 원문으로도 시도) */
      var bw = String(p[0] || "").split(/\s+/)[0].replace(/[^A-Za-z0-9]/g, ""), names = [m0];
      if (bw) { var st = m0.replace(new RegExp("^" + bw + "\\s+", "i"), ""); if (st !== m0 && st.length >= 2) names.push(st); }
      var pool = (byBrand[b] || []).slice();
      (GRP[b] || []).forEach(function (g) { pool = pool.concat(byBrand[g] || []); });   /* Jeep · RAM 은 마스터에서 Chrysler 로도 등재 */
      if (!p[0]) pool = vehicles;                                          /* 브랜드 빈칸 → 전체에서 */
      var hit = null, how = "";
      names.some(function (m) { var n1 = nm(m); return pool.some(function (v) { if (vn(v).some(function (x) { return nm(x) === n1; })) { hit = v; how = "exact"; return true; } }); });
      if (!hit) names.some(function (m) { var c1 = nmCore(m); return c1 && pool.some(function (v) { if (vn(v).some(function (x) { return nmCore(x) === c1; })) { hit = v; how = "core"; return true; } }); });
      if (!hit) names.some(function (m) {
        /* 단어 단위 앞부분 일치 (CX-5 ≠ CX-50 · Tera ≠ Teramont) — 다른 차를 뜻하는 꼬리말(Cross · EUV · EV …)이 붙으면 제외 */
        var t1 = toks(m), best = null, bl = 0;
        pool.forEach(function (v) {
          var t2 = toks(vn(v).slice(-1)[0]); if (!t2.length || !t1.length) return;
          var a1 = t1.length <= t2.length ? t1 : t2, a2 = a1 === t1 ? t2 : t1;
          for (var i = 0; i < a1.length; i++) if (a1[i] !== a2[i]) return;
          var rest = a2.slice(a1.length);
          if (rest.some(function (w) { return DIFF[w]; })) return;
          if (a1.join("").length < 2) return;
          if (a1.length > bl) { best = v; bl = a1.length; }
        });
        if (best) { hit = best; how = "prefix"; return true; }
      });
      out[k] = hit ? { key: vkey(hit), how: how } : null;
    });
    return out;
  }

  function ymAdd(ym, n) { var y = +ym.slice(0, 4), m = +ym.slice(5, 7) - 1 + n; y += Math.floor(m / 12); m = ((m % 12) + 12) % 12; return y + "-" + (m < 9 ? "0" : "") + (m + 1); }
  /* rows: [{ym, kind, brand, model, m, m_prev, ytd, ytd_prev}] → S[ekey] = { M:{ym:n}, Y:{ym:n} } (Y = 그 해 1월~그 달 누적) */
  function series(rows) {
    var S = {};
    rows.forEach(function (r) {
      var k = ekey(r), s = S[k] || (S[k] = { M: {}, Y: {}, kind: r.kind, seg: r.seg, origin: r.origin, brand: r.brand, model: r.model });
      var prev = ymAdd(r.ym, -12);
      function put(o, ym, v) { if (v == null || !isFinite(v)) return; if (o[ym] == null) o[ym] = v; }
      put(s.M, r.ym, r.m); put(s.Y, r.ym, r.ytd);
      put(s.M, prev, r.m_prev); put(s.Y, prev, r.ytd_prev);
      if (r.ym > (s.last || "")) { s.last = r.ym; s.seg = r.seg || s.seg; s.origin = r.origin || s.origin; s.kind = r.kind; }
    });
    return S;
  }
  /* 기간 판매 합계 — 해마다: 누적(Y) 두 개로 정확히 → 없으면 월 값 합 → 그래도 빈 달은 그 해 평균으로 채움(추정) */
  function sumRange(s, a, b) {
    var tot = 0, known = 0, months = 0, est = false;
    for (var y = +a.slice(0, 4); y <= +b.slice(0, 4); y++) {
      var s0 = y === +a.slice(0, 4) ? +a.slice(5, 7) : 1, e0 = y === +b.slice(0, 4) ? +b.slice(5, 7) : 12;
      var Y = function (mm) { if (mm === 0) return 0; var k = y + "-" + (mm < 10 ? "0" : "") + mm; return s.Y[k]; };
      var n = e0 - s0 + 1; months += n;
      var ye = Y(e0), ys = Y(s0 - 1);
      if (ye != null && ys != null) { tot += Math.max(0, ye - ys); known += n; continue; }
      var sum = 0, got = 0;
      for (var mm = s0; mm <= e0; mm++) { var v = s.M[y + "-" + (mm < 10 ? "0" : "") + mm]; if (v != null) { sum += v; got++; } }
      /* 그 해 누적 값이 하나라도 있으면 월평균으로, 아니면 아는 달 평균으로 빈 달 채움 */
      var avg = null, lastY = null;
      for (var q = 12; q >= 1; q--) { var yv = Y(q); if (yv != null) { lastY = q; avg = yv / q; break; } }
      if (avg == null && got) avg = sum / got;
      if (got < n) { est = true; if (avg != null) sum += avg * (n - got); }
      tot += sum; known += got;
    }
    return { v: Math.round(tot), cov: months ? known / months : 0, est: est };
  }
  /* 세대 연식 "2012-2019" · "2020-" · "2023-2026" → [시작, 끝] */
  function yrs(t) { var m = String(t || "").match(/(19|20)\d{2}/g); if (!m) return null; var a = +m[0], b = m.length > 1 ? +m[1] : (/[-–]\s*$/.test(String(t).trim()) ? 2100 : a); return [Math.min(a, b), Math.max(a, b)]; }
  /* 저장 VIO (연식 구간 안의 세대만) — 세대마다 VIO가 다르면 겹치는 세대 합, 모델 단위 값이 반복되면 겹치는 세대가 있을 때 그 값 */
  function vioIn(v, y1, y2) {
    var gs = v.gens || [], vs = gs.map(function (g) { return +g.vio || 0; }), uniq = {};
    vs.forEach(function (x) { uniq[x] = 1; });
    var perGen = Object.keys(uniq).length > 1, tot = 0, any = false, all = true;
    gs.forEach(function (g) {
      var r = yrs(g.yr), hit = !r || (r[1] >= y1 && r[0] <= y2);
      if (!hit) { all = false; return; }
      any = true; if (perGen) tot += +g.vio || 0;
    });
    if (!gs.length) return { v: +v.vio || 0, part: false };
    if (!perGen) return { v: any ? (vs[0] || +v.vio || 0) : 0, part: any && !all };
    return { v: tot, part: !all };
  }
  /* 차종별 시장 표
     o = { vehicles:[{rk,brand,model,vio,gens}], sales:[행], alias:{}, newVeh:[{k,brand,model,src,seg,origin}], base:"YYYY-MM", y1, y2 }
     → { rows:[…], latest, first, matchedShare } */
  function build(o) {
    var rows = o.sales || [], S = series(rows), ek = Object.keys(S);
    var latest = "", first = "9999-99";
    rows.forEach(function (r) { if (r.ym > latest) latest = r.ym; var p = ymAdd(r.ym, -12).slice(0, 4) + "-01"; if (p < first) first = p; });
    var newBySrc = {}, newByK = {};
    (o.newVeh || []).forEach(function (v) { newByK[v.k] = v; if (v.src) newBySrc[v.src] = v.k; });
    var mt = match(ek, o.vehicles || [], o.alias || {});
    var y1 = o.y1 || 1900, y2 = o.y2 || 2100, base = o.base || "2026-06";
    var lo = (y1 + "-01") > first ? y1 + "-01" : first, hi = (y2 + "-12") < latest ? y2 + "-12" : latest;
    var aLo = ymAdd(base, 1) > lo ? ymAdd(base, 1) : lo;
    var out = {}, tot = 0, hitTot = 0;
    function row(k, init) { return out[k] || (out[k] = Object.assign({ key: k, ema: [], after: 0, afterEst: false, period: 0, periodEst: false, ytd: 0, kind: "", seg: "" }, init)); }
    (o.vehicles || []).forEach(function (v) {
      var vi = vioIn(v, y1, y2);
      row(vkey(v), { brand: v.brand, model: v.model, rk: +v.rk || 9999, vio: vi.v, vioPart: vi.part, vioAll: +v.vio || 0, isNew: false, master: true });
    });
    (o.newVeh || []).forEach(function (v) { row(v.k, { brand: v.brand, model: v.model, rk: 9999, vio: 0, vioAll: 0, isNew: true, master: false, auto: v.auto, seg: v.seg || "" }); });
    ek.forEach(function (k) {
      var s = S[k], m = mt[k], tk = m ? m.key : (newBySrc[k] || ("EMA|" + k));
      if (m && !out[tk] && newByK[tk]) tk = m.key;
      var R = out[tk] || row(tk, { brand: s.brand, model: s.model, rk: 9999, vio: 0, vioAll: 0, isNew: !m, master: false, unreg: !m && !newBySrc[k] });
      var yt = s.Y[latest] || 0; tot += yt; if (m) hitTot += yt;
      R.ema.push({ k: k, model: s.model, brand: s.brand, how: m ? m.how : "", ytd: yt });
      R.kind = R.kind || s.kind; R.seg = R.seg || s.seg; R.origin = R.origin || s.origin; R.ytd += yt;
      if (hi >= lo) { var p = sumRange(s, lo, hi); R.period += p.v; if (p.est) R.periodEst = true; }
      /* 기준 월 이후 판매 — 마스터 차종만 (신규 차종은 저장 VIO가 없으니 자료 전체 기간 판매를 추정 VIO로) */
      if (R.master) { if (hi >= aLo) { var a2 = sumRange(s, aLo, hi); R.after += a2.v; if (a2.est) R.afterEst = true; } }
    });
    var list = Object.keys(out).map(function (k) { var r = out[k]; r.est = r.master ? r.vio + r.after : r.period; r.estBasis = r.master ? "vio+after" : "sales"; return r; });
    return { rows: list, latest: latest, first: first, lo: lo, hi: hi, aLo: aLo, share: tot ? hitTot / tot : 0, S: S, match: mt };
  }
  function rank(list, key) {
    var l = list.slice().sort(function (a, b) { return (b[key] || 0) - (a[key] || 0) || (a.rk || 9999) - (b.rk || 9999); });
    l.forEach(function (r, i) { r.rank = i + 1; });
    return l;
  }
  var api = { yrs: yrs, vioIn: vioIn, build: build, rank: rank, toks: toks, nb: nb, nm: nm, nmCore: nmCore, ekey: ekey, vkey: vkey, match: match, series: series, sumRange: sumRange, ymAdd: ymAdd };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.rfxMkt = api;
})(this);
