/* refatrix-guide-referral.js — 소개 계약 단계 안내 팝업 (2026-10-30)
   커미션 화면 · 합의 페이지가 같이 쓴다. 스페인어. 6단계 다이어그램 + 「어디서 · 무엇을」 + 현재 단계 강조.
   사용: RefGuide.open({ step: 1~6, onGo: fn(stepNo) })   ·   RefGuide.stepOf(referralItem|null)
*/
(function (g) {
  'use strict';
  var STEPS = [
    { n: 1, icon: '📂', t: 'Abre «Acuerdo y contratos»',
      where: 'Pantalla <b>Comisión</b> › arriba a la derecha',
      what: 'Toca el botón <b>Acuerdo y contratos</b>.' },
    { n: 2, icon: '📝', t: 'Registrar datos', key: true,
      where: 'Página <b>Acuerdo y contratos</b> › recuadro verde de arriba › botón <b>Registrar datos</b>',
      what: 'Elige la cuenta del comisionista (por ejemplo <b>CDMX</b>), escribe los datos de su empresa y <b>tus datos</b> (nombre, RFC, domicilio, teléfono, correo). Toca <b>Guardar y continuar</b>.',
      note: 'Con este paso se crea el <b>borrador del contrato</b>.' },
    { n: 3, icon: '📎', t: 'Sube los documentos',
      where: 'Debajo, tabla <b>Documentación</b>',
      what: 'En cada renglón: toca el botón de <b>archivo</b> → elige el archivo → <b>Subir</b>. Constancia de Situación Fiscal (30 días máx.), comprobante de domicilio (3 meses máx.), INE; si es empresa, acta y poder; y tu estado de cuenta.' },
    { n: 4, icon: '✍️', t: 'Revisa y firma',
      where: 'Al final de la página, recuadro <b>Firma</b>',
      what: 'Lee el contrato, firma con el dedo o el ratón, marca la casilla, escribe <b>tu PIN</b> y toca <b>Firmar contrato</b>.' },
    { n: 5, icon: '✅', t: 'Aprobación de Refatrix',
      where: 'No tienes que hacer nada',
      what: 'Refatrix revisa tus datos y documentos y aprueba. Mientras tanto puedes corregir con <b>Corregir datos</b>.' },
    { n: 6, icon: '💰', t: 'Ve tu comisión',
      where: 'Pantalla <b>Comisión</b> › <b>Comisión por referencia</b>',
      what: 'Ves las ventas y cobros del comisionista y tu <b>1%</b>. Se paga el <b>día 15</b> del mes siguiente; envía tu <b>CFDI</b> antes del día 10.' },
  ];

  // 계약 상태 → 지금 해야 할 단계
  function stepOf(it) {
    if (!it) return 2;
    if (!it.docs || !it.docs.complete) return 3;
    if (it.sign_status !== 'signed') return 4;
    if (!it.approved) return 5;
    return 6;
  }

  var CSS = ''
    + '#rgBack{position:fixed;inset:0;background:rgba(20,20,18,.55);z-index:2147483000}'
    + '#rgBox{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);width:min(980px,95vw);max-height:92vh;overflow:auto;z-index:2147483001;background:#fff;border-radius:14px;box-shadow:0 18px 60px rgba(0,0,0,.4);padding:22px 22px 18px;font-family:inherit;color:#1C1B19}'
    + '#rgBox h2{margin:0;font-size:20px;color:#143D34}'
    + '#rgBox .rgsub{font-size:13px;color:#6F6A60;margin:4px 0 16px}'
    + '.rgflow{display:grid;grid-template-columns:repeat(3,1fr);gap:26px 34px;position:relative}'
    + '.rgst{position:relative;border:1.5px solid #E6E1D6;border-radius:12px;padding:12px 13px 12px;background:#faf8f3}'
    + '.rgst .hd{display:flex;align-items:center;gap:8px;margin-bottom:6px}'
    + '.rgst .no{flex:none;width:28px;height:28px;border-radius:50%;background:#143D34;color:#fff;font-weight:800;display:flex;align-items:center;justify-content:center;font-size:14px}'
    + '.rgst .ic{font-size:20px}'
    + '.rgst .tt{font-weight:800;font-size:14.5px;color:#143D34;line-height:1.2}'
    + '.rgst .wh{font-size:12px;color:#6F6A60;margin:4px 0 5px;line-height:1.4}'
    + '.rgst .wh::before{content:"📍 Dónde: ";font-weight:700;color:#8a6d1f}'
    + '.rgst .wt{font-size:12.8px;line-height:1.5}'
    + '.rgst .nt{margin-top:7px;font-size:12px;font-weight:700;color:#B23A2E;background:#F6E7E4;border-radius:7px;padding:5px 8px}'
    + '.rgst.done{opacity:.55}.rgst.done .no{background:#0F6E56}'
    + '.rgst.cur{border-color:#C9A75C;background:#FFF7E6;box-shadow:0 0 0 3px rgba(201,167,92,.25)}'
    + '.rgst.cur .no{background:#C9A75C;color:#2b210c}'
    + '.rgst .here{position:absolute;top:-11px;right:10px;background:#C9A75C;color:#2b210c;font-size:11px;font-weight:800;border-radius:20px;padding:2px 9px}'
    + '.rgst.key:not(.done){border-width:2px}'
    + '.rgst .ar{position:absolute;font-size:22px;color:#C9A75C;font-weight:800;line-height:1}'
    + '.rgst .ar.r{right:-27px;top:50%;transform:translateY(-50%)}'
    + '.rgst .ar.d{left:50%;bottom:-25px;transform:translateX(-50%)}'
    + '.rgbar{display:flex;gap:10px;align-items:center;justify-content:flex-end;margin-top:18px;flex-wrap:wrap}'
    + '.rgbar .b{padding:10px 16px;border-radius:9px;border:none;background:#143D34;color:#fff;font-weight:700;font-size:14px;cursor:pointer;font-family:inherit}'
    + '.rgbar .b.gh{background:#fff;color:#143D34;border:1px solid #143D34}'
    + '@media(max-width:760px){.rgflow{grid-template-columns:1fr;gap:24px}.rgst .ar.r{display:none}.rgst .ar.d{display:block!important}#rgBox{padding:16px;top:8px;bottom:8px;transform:translateX(-50%);max-height:none}}';

  function ensureCss() {
    if (document.getElementById('rgCss')) return;
    var st = document.createElement('style'); st.id = 'rgCss'; st.textContent = CSS; document.head.appendChild(st);
  }
  function close() {
    var a = document.getElementById('rgBack'), b = document.getElementById('rgBox');
    if (a) a.remove(); if (b) b.remove();
    document.removeEventListener('keydown', onKey);
  }
  function onKey(e) { if (e.key === 'Escape') close(); }

  // opt: { step, onGo(step), goLabel }
  function open(opt) {
    opt = opt || {};
    ensureCss(); close();
    var cur = Math.max(1, Math.min(6, Number(opt.step) || 1));
    var html = '<h2>Cómo registrar tu comisión por referencia</h2>'
      + '<div class="rgsub">6 pasos. Tú haces los pasos 1 a 4; Refatrix aprueba (5) y ya puedes ver tu comisión (6).</div>'
      + '<div class="rgflow">';
    STEPS.forEach(function (s, i) {
      var cls = s.n < cur ? 'done' : (s.n === cur ? 'cur' : '');
      // 화살표: 같은 줄 다음 칸(→), 줄 끝(3번)은 아래(↓)·모바일은 모두 아래
      var arrow = '';
      if (i < STEPS.length - 1) arrow = (i % 3 === 2) ? '<span class="ar d">↓</span>' : '<span class="ar r">→</span><span class="ar d" style="display:none">↓</span>';
      html += '<div class="rgst ' + cls + (s.key ? ' key' : '') + '">'
        + (s.n === cur ? '<span class="here">Estás aquí</span>' : '')
        + '<div class="hd"><span class="no">' + (s.n < cur ? '✓' : s.n) + '</span><span class="ic">' + s.icon + '</span><span class="tt">' + s.t + '</span></div>'
        + '<div class="wh">' + s.where + '</div><div class="wt">' + s.what + '</div>'
        + (s.note ? '<div class="nt">⚠ ' + s.note + '</div>' : '')
        + arrow + '</div>';
    });
    html += '</div><div class="rgbar"><button class="b gh" id="rgClose" type="button">Cerrar</button>'
      + (opt.onGo ? '<button class="b" id="rgGo" type="button">' + (opt.goLabel || ('Ir al paso ' + cur + ' ›')) + '</button>' : '') + '</div>';
    var back = document.createElement('div'); back.id = 'rgBack';
    var box = document.createElement('div'); box.id = 'rgBox'; box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true');
    box.innerHTML = html;
    document.body.appendChild(back); document.body.appendChild(box);
    back.addEventListener('click', close);
    document.getElementById('rgClose').addEventListener('click', close);
    var go = document.getElementById('rgGo');
    if (go) go.addEventListener('click', function () { close(); opt.onGo(cur); });
    document.addEventListener('keydown', onKey);
    setTimeout(function () { (go || document.getElementById('rgClose')).focus(); }, 0);
  }

  // 고정 상단 메뉴 높이만큼 비켜서 스크롤 (메뉴에 가려지지 않게)
  function scrollTo(el) {
    if (!el) return;
    var nav = document.getElementById('rnav');
    var h = nav ? nav.getBoundingClientRect().height : 0;
    var y = el.getBoundingClientRect().top + window.pageYOffset - h - 14;
    window.scrollTo({ top: Math.max(0, y), behavior: 'smooth' });
  }

  g.RefGuide = { open: open, close: close, stepOf: stepOf, scrollTo: scrollTo, STEPS: STEPS };
})(window);
