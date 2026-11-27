/* ═══ REFATRIX · SYD 경쟁사 샘플 — 공용 모듈 (2026-11-11) ═══════════════════════════════
   · 플랫폼 어디서든 SYD 코드 옆에 샘플 구매·발송·도착·검토 배지를 붙이는 데이터·배지 모듈
   · 상단 메뉴에 [샘플 구매] [샘플 검토] 링크 추가
   · ERP 공용 도구 (로그인 · 제품 찾기 · SYD 연결/해제 · 신규 CTR 생성 · 전체 매칭 목록)
   전제: Supabase 에서 refatrix_syd_sample.sql 실행
   사용: window.rfxSample.badge(code) → HTML · window 이벤트 "rfx-sample" = 데이터가 바뀜
   ═════════════════════════════════════════════════════════════════════════════════════ */
(function () {
  "use strict";
  if (window.rfxSample) return;
  var SUPA = "https://hvwteeecvukddmurzlfm.supabase.co";
  var KEY = "sb_publishable_-hlx1MHlTNEwyif6nePYHA_ue_r8mV0";
  var ERP = "https://refatrix-production.up.railway.app";
  var CK = "rfx_ss_cache_v1", POLL = 60 * 1000;
  var S = { map: {}, list: [], at: 0, ver: "", ok: false, err: "", busy: false };

  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function sess() { try { return JSON.parse(sessionStorage.getItem("rfx_sess") || "null"); } catch (e) { return null; } }
  function rpc(fn, body) {
    return fetch(SUPA + "/rest/v1/rpc/" + fn, { method: "POST", headers: { apikey: KEY, Authorization: "Bearer " + KEY, "Content-Type": "application/json" }, body: JSON.stringify(body || {}) })
      .then(function (r) { return r.json().catch(function () { return null; }).then(function (j) {
        if (!r.ok) {
          var m = (j && (j.message || j.hint || j.error)) || ("http " + r.status);
          if (/app_ss_|Could not find the function/i.test(m)) m = "샘플 모듈이 아직 설치되지 않았습니다 — Supabase에서 refatrix_syd_sample.sql 을 실행하세요 (" + m + ")";
          throw new Error(m);
        }
        return j; }); });
  }
  function tok() { var s = sess(); return s && s.t; }
  function emit() { try { window.dispatchEvent(new Event("rfx-sample")); } catch (e) {} }
  function setList(list) {
    S.list = list || []; S.map = {};
    S.list.forEach(function (r) { S.map[String(r.c).toUpperCase()] = r; });
    S.ok = true; S.at = Date.now();
    try { localStorage.setItem(CK, JSON.stringify({ t: S.at, list: S.list })); } catch (e) {}
    emit();
  }
  try { var c0 = JSON.parse(localStorage.getItem(CK) || "null"); if (c0 && c0.list) { S.list = c0.list; c0.list.forEach(function (r) { S.map[String(r.c).toUpperCase()] = r; }); } } catch (e) {}

  function load() {
    var t = tok(); if (!t) return Promise.resolve(S.list);
    S.busy = true;
    return rpc("app_ss_all", { p_token: t }).then(function (l) { S.err = ""; S.busy = false; setList(l); return S.list; },
      function (e) { S.busy = false; S.err = e.message; emit(); throw e; });
  }
  function poll() {
    var t = tok(); if (!t || document.hidden) return;
    rpc("app_ss_ver", { p_token: t }).then(function (v) {
      var k = (v && v.n) + "|" + (v && v.at);
      if (k !== S.ver) { S.ver = k; load().catch(function () {}); }
    }).catch(function () {});
  }

  /* ── 상태 · 배지 ── */
  function stage(r) {
    if (!r) return "";
    if (r.rv) return "rv";
    if (r.arr) return "arr";
    if (r.ship) return "ship";
    if (r.buy) return "buy";
    return "plan";
  }
  var ST_LBL = { plan: "구매 예정", buy: "구매", ship: "발송", arr: "도착", rv: "검토 완료" };
  var RV_LBL = { match: "매칭 컨펌", "new": "신규 CTR", nomatch: "매칭 없음", hold: "보류" };
  var ES_LBL = { sent: "ERP 전송 완료", pending: "ERP 전송 대기", fail: "ERP 전송 실패" };
  function md(d) { if (!d) return ""; var p = String(d).slice(0, 10).split("-"); return p.length === 3 ? (+p[1]) + "/" + (+p[2]) : String(d); }
  function tip(r) {
    var a = ["샘플 SYD " + r.c + (r.q > 1 ? " · 수량 " + r.q : "")];
    if (r.buy) a.push("구매 " + r.buy); else a.push("구매 예정");
    if (r.ship) a.push("발송 " + r.ship + (r.car ? " · " + r.car : "") + (r.trk ? " · " + r.trk : ""));
    if (r.arr) a.push("도착 " + r.arr);
    if (r.rv) a.push("검토: " + (RV_LBL[r.rv] || r.rv) + (r.rc ? " " + r.rc : "") + (r.rb ? " · " + r.rb : ""));
    if (r.es) a.push(ES_LBL[r.es] || r.es);
    if (r.note) a.push("메모: " + r.note);
    return a.join("\n");
  }
  function badge(code, opt) {
    var r = S.map[String(code || "").trim().toUpperCase()]; if (!r) return "";
    var st = stage(r), h = "";
    if (st === "plan") h = '<span class="ssB plan">🛒 구매 예정</span>';
    else {
      h = '<span class="ssB buy">🛒 구매 ' + esc(md(r.buy) || "—") + "</span>";
      if (r.ship) h += '<span class="ssB ship">🚚 발송 ' + esc(md(r.ship)) + "</span>";
      if (r.arr) h += '<span class="ssB arr">📦 도착 ' + esc(md(r.arr)) + "</span>";
    }
    if (r.rv) h += '<span class="ssB rv ' + esc(r.rv) + '">' + ({ match: "✓ ", "new": "✚ ", nomatch: "✗ ", hold: "⏸ " }[r.rv] || "") + esc(RV_LBL[r.rv] || r.rv) + (r.rc ? " " + esc(r.rc) : "") + "</span>";
    if (r.es === "pending" || r.es === "fail") h += '<span class="ssB es ' + esc(r.es) + '">' + esc(ES_LBL[r.es]) + "</span>";
    return '<span class="ssW' + (opt && opt.block ? " blk" : "") + '" title="' + esc(tip(r)) + '" translate="no">' + h + "</span>";
  }
  var CSS = ".ssW{display:inline-flex;flex-wrap:wrap;gap:3px;margin-left:6px;vertical-align:1px}.ssW.blk{display:flex;margin:4px 0 0}"
    + ".ssB{font:800 10px/1.5 -apple-system,system-ui,sans-serif;padding:0 6px;border-radius:7px;white-space:nowrap;letter-spacing:0;font-family:inherit}"
    + ".ssB.plan{background:#f2f2f2;color:#666;border:1px dashed #bbb}.ssB.buy{background:#fff1c2;color:#7d4e00}.ssB.ship{background:#ddf4ff;color:#0550ae}"
    + ".ssB.arr{background:#dafbe1;color:#1a7f37}.ssB.rv{background:#1f1f1f;color:#fff}.ssB.rv.new{background:#8250df}.ssB.rv.nomatch{background:#6e7781}.ssB.rv.hold{background:#bf8700}"
    + ".ssB.es.pending{background:#fff8c5;color:#9a6700;border:1px solid #d4a72c}.ssB.es.fail{background:#ffebe9;color:#cf222e;border:1px solid #cf222e}"
    + ".ssNav.cur{background:var(--ink,#13171d)!important;border-color:var(--ink,#13171d)!important;color:#fff!important;pointer-events:none}";
  function css() { if (document.getElementById("ssCss")) return; var st = document.createElement("style"); st.id = "ssCss"; st.textContent = CSS; document.head.appendChild(st); }

  /* ── 메뉴 링크 ── */
  function nav() {
    var here = location.pathname.split("/").pop();
    var L = [["sample_buy.html", "🛒 샘플 구매"], ["sample_review.html", "🔍 샘플 검토"], ["market.html", "📈 시장 데이터"]];   /* 2026-11-27 시장 데이터 */
    var me = sess(); if (me && me.u && me.u.role === "dir") L.push(["sample_plan.html", "🧮 샘플 계획"]);   /* 2026-11-12 디렉터 전용 */
    var pf = document.getElementById("pfnav");
    if (pf && !pf.querySelector(".ssNav")) L.forEach(function (x) {
      var a = document.createElement("a"); a.href = x[0]; a.textContent = x[1]; a.className = "ssNav" + (here === x[0] ? " cur" : ""); a.setAttribute("translate", "no"); pf.appendChild(a);
    });
    var nv = document.querySelector("header.top nav.nav");
    if (nv && !nv.querySelector(".ssNav")) L.forEach(function (x) {
      var b = document.createElement("button"); b.type = "button"; b.textContent = x[1]; b.className = "ssNav"; b.onclick = function () { location.href = x[0]; }; nv.appendChild(b);
    });
  }

  /* ── ERP 공용 도구 ── */
  var ET = null;
  function erpLogin() {
    var s = sess(); if (!s) return Promise.resolve(null);
    var u = s.u || {};
    return fetch(ERP + "/api/pf-catalog/login", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: s.t, name: u.name || "", user_key: String(u.id != null ? u.id : "") }) })
      .then(function (r) { return r.ok ? r.json() : null; }).then(function (b) { ET = b && b.token || null; return ET; }).catch(function () { return null; });
  }
  function erpReq(method, path, body, retried) {
    return (ET ? Promise.resolve(ET) : erpLogin()).then(function (tk) {
      if (!tk) throw new Error("ERP 로그인 실패 — 플랫폼에 다시 로그인해 주세요");
      var o = { method: method, headers: { Authorization: "Bearer " + tk } };
      if (body !== undefined) { o.headers["Content-Type"] = "application/json"; o.body = JSON.stringify(body); }
      return fetch(ERP + path, o);
    }).then(function (r) {
      if (r.status === 401 && !retried) { ET = null; return erpReq(method, path, body, true); }
      return r.json().catch(function () { return {}; }).then(function (b) { if (!r.ok) { var e = new Error(b && b.error ? String(b.error) : ("ERP http " + r.status)); e.status = r.status; throw e; } return b; });
    });
  }
  function erpFind(code) {
    return erpReq("GET", "/api/pf-catalog/items?q=" + encodeURIComponent(code) + "&status=&active=all&sort=code&round=&tag=&limit=100&offset=0")
      .then(function (b) { var up = String(code).toUpperCase(); return (b.items || []).filter(function (x) { return String(x.code).toUpperCase() === up; })[0] || null; });
  }
  function splitS(v) { return String(v || "").split(/\/\/|;|\n/).map(function (x) { return x.trim(); }).filter(Boolean); }
  /* SYD 를 CTR 제품의 scode 에 넣거나(want=true) 빼고 confirm — SYD 카탈로그 [확인완료]와 같은 호출 */
  function erpApplySyd(ctr, syd, want, note) {
    return erpFind(ctr).then(function (d) {
      if (!d) return { code: ctr, st: "none" };
      var FL = ["name", "scode", "app", "oe", "material"], cur = splitS(d.scode);
      var has = cur.map(function (c) { return c.toUpperCase(); }).indexOf(String(syd).toUpperCase()) >= 0;
      if (want === has) return { code: ctr, st: "same", scode: cur.join(" // ") };
      var next = want ? cur.concat([syd]) : cur.filter(function (c) { return c.toUpperCase() !== String(syd).toUpperCase(); });
      var loaded = {}, fields = {};
      FL.forEach(function (f) { loaded[f] = d[f] == null ? null : d[f]; fields[f] = d[f] == null ? null : d[f]; });
      fields.scode = next.join(" // ");
      return erpReq("POST", "/api/pf-catalog/items/" + d.id + "/confirm", { fields: fields, resolve: {}, note: note || ("샘플 검토 (SYD " + syd + (want ? " 추가" : " 제거") + ")"), loaded: loaded, rev: d.rev })
        .then(function () { return { code: ctr, st: want ? "add" : "rm", scode: fields.scode }; });
    }).catch(function (e) { return { code: ctr, st: "fail", msg: String(e && e.message || e) }; });
  }
  /* 신규 CTR 제품 생성 — ERP 요청서: ERP질의프로토콜_신규CTR생성API_20261111.md
     API 가 아직 없으면(404 · 405 · 501) {st:"pending"} — 플랫폼에 대기로 남기고 나중에 재전송 */
  function erpCreate(spec) {
    var body = { code: spec.code, name: spec.name || "", scode: spec.scode || "", app: spec.app || "", oe: spec.oe || "",
      material: spec.material || "", pos: spec.pos || "", category: spec.cat || "", note: spec.note || "", source: spec.source || "refatrix-sample-review" };
    return erpReq("POST", "/api/pf-catalog/items", body).then(function (b) { return { st: "sent", item: b && (b.item || b), msg: "ERP 신규 제품 생성 완료" }; },
      function (e) {
        if (e.status === 404 || e.status === 405 || e.status === 501) return { st: "pending", msg: "ERP 신규 생성 API 준비 전 — 플랫폼에 대기로 저장 (ERP 연결 후 [ERP 재전송])" };
        if (e.status === 409) return { st: "fail", msg: "ERP에 이미 같은 코드가 있습니다 — [매칭 컨펌]으로 연결하세요" };
        return { st: "fail", msg: e.message || String(e) };
      });
  }
  /* ERP 전체 매칭 (CTR → scode) — SYD 카탈로그 캐시가 10분 이내면 사용, 아니면 6쪽씩 동시에 받음 */
  function erpMap(force, onProg) {
    try { var c = JSON.parse(localStorage.getItem("rfx_dup_cache_v2") || "null"); if (!force && c && c.map && Date.now() - c.t < 10 * 60 * 1000) return Promise.resolve({ t: c.t, map: c.map }); } catch (e) {}
    var map = {}, LIM = 200, P = "/api/pf-catalog/items?q=&status=&active=all&sort=code&round=&tag=&limit=" + LIM + "&offset=";
    var got = 0, tot = 0;
    function eat(b) { if (!b || !Array.isArray(b.items)) throw new Error("ERP 응답 형식 오류"); got += b.items.length; b.items.forEach(function (x) { var v = String(x.scode || "").trim(); if (v) map[String(x.code)] = v; }); }
    return erpReq("GET", P + 0).then(function (b0) {
      eat(b0);
      tot = b0.total || 0; var step = (b0.items || []).length || LIM, offs = [], done = 1;
      for (var o = step; o < tot; o += step) offs.push(o);
      if (onProg) onProg(done, offs.length + 1);
      var i = 0;
      function w() { if (i >= offs.length) return Promise.resolve(); var off = offs[i++]; return erpReq("GET", P + off).then(function (b) { eat(b); done++; if (onProg) onProg(done, offs.length + 1); return w(); }); }
      var ws = []; for (var k = 0; k < 6; k++) ws.push(w());
      return Promise.all(ws);
    }).then(function () {
      if (!(tot > 0) || got < tot - 5) throw new Error("ERP 수집 불완전 (" + got + "/" + tot + ") — 이전 값 유지");   /* 2026-11-24 */
      return { t: Date.now(), map: map };
    });
  }
  function ownOf(map) {
    var own = {};
    Object.keys(map || {}).forEach(function (code) { splitS(map[code]).forEach(function (x) { x = x.toUpperCase(); if (/IT$/.test(x)) return; (own[x] = own[x] || []).push(code); }); });
    return own;
  }

  window.rfxSample = {
    rpc: rpc, tok: tok, sess: sess, load: load, list: function () { return S.list; }, get: function (c) { return S.map[String(c || "").trim().toUpperCase()] || null; },
    state: function () { return { ok: S.ok, err: S.err, at: S.at, busy: S.busy }; }, stage: stage, ST_LBL: ST_LBL, RV_LBL: RV_LBL, ES_LBL: ES_LBL,
    badge: badge, tip: tip, esc: esc, md: md, css: css,
    erp: { login: erpLogin, req: erpReq, find: erpFind, applySyd: erpApplySyd, create: erpCreate, map: erpMap, own: ownOf, split: splitS },
    SUPA: SUPA, KEY: KEY, ERP: ERP
  };
  function init() { css(); nav(); load().catch(function () {}); setInterval(poll, POLL); document.addEventListener("visibilitychange", function () { if (!document.hidden) poll(); }); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
