// =====================================================================
// 영업 > 고객개발(0334) — 순수 함수 단위 테스트 (2026-11-25)
//   실행: node --test test/prospects.test.mjs
// =====================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  inPolygon, optimizeRoute, rankForRoute, weekBounds, routeMinutes,
  potentialOf, POTENTIAL_TIERS, infoCompleteness, scoreOf, deriveStage, STAGE_RANK_SQL, SCORE_RULES,
  checkStageMove, autoAdvance, segmentOf, priorityOf, normalizeImportRow, parseCsv, territoryFor,
  distanceM, orderStops, nameSimilarity, matchScore, suggestCustomers, prefillFromProspect, buildAltaPrompt,
  parseAltaDraft, coerceValue, mergeForReview, validateAltaValues, missingRequired, pct, paceStatus, periodBounds,
} from '../src/prospectCore.js';
import { ALTA_FIELDS, ALTA_FIELD_MAP, ALTA_FORM } from '../src/altaClientesForm.js';

test('양식 v2: Hoja1 6개 + 고객규모·잠재성 2개 섹션 · 경쟁사 3세트 펼침', () => {
  assert.equal(ALTA_FORM.version, 2);
  assert.equal(ALTA_FORM.sections.length, 8);
  assert.deepEqual(ALTA_FORM.sections.slice(0, 3).map((x) => x.key), ['datos_generales', 'tamano_cliente', 'potencial']);
  assert.ok(ALTA_FIELD_MAP['tamano_cliente.metodo_entrega'].options.includes('Paquetería'));
  assert.equal(ALTA_FIELDS.filter((f) => f.section === 'competencia').length, 15);
  assert.ok(ALTA_FIELD_MAP['competencia.2.precio_compra']);
  assert.ok(ALTA_FIELD_MAP['datos_generales.contacto_principal'].required);
});

test('단계 규칙: 앞으로만 · 중단 사유 · 되돌리기/복구/신규고객은 디렉터', () => {
  assert.deepEqual(checkStageMove('asignado', 'contactado'), { ok: true });
  assert.equal(checkStageMove('cotizado', 'contactado').error, 'no_backward');
  assert.equal(checkStageMove('cotizado', 'contactado', { isDirector: true }).ok, true);
  assert.equal(checkStageMove('contactado', 'descartado').error, 'reason_required');
  assert.equal(checkStageMove('contactado', 'descartado', { reason: 'Sin interés' }).ok, true);
  assert.equal(checkStageMove('descartado', 'contactado').error, 'director_only');
  assert.equal(checkStageMove('registro', 'cliente_activo').error, 'auto_only');
  assert.equal(checkStageMove('contactado', 'perfilado').error, 'auto_only');
  assert.equal(checkStageMove('perfilado', 'interesado').ok, true);
  assert.equal(checkStageMove('interesado', 'cotizado').error, 'auto_only');
  assert.equal(checkStageMove('asignado', 'asignado').error, 'same_stage');
  assert.equal(autoAdvance('asignado', 'contactado'), 'contactado');
  assert.equal(autoAdvance('cotizado', 'contactado'), null);
  assert.equal(autoAdvance('descartado', 'contactado'), null);
});

test('세그먼트·우선순위', () => {
  assert.equal(segmentOf('436112'), 'mayorista');
  assert.equal(segmentOf('811116'), 'taller_suspension');
  assert.equal(segmentOf('999999'), 'otro');
  assert.equal(priorityOf('468211', '0 a 5 personas'), 'A');
  assert.equal(priorityOf('811111', '6 a 10 personas'), 'B');
  assert.equal(priorityOf('811111', '0 a 5 personas'), 'C');
  assert.equal(priorityOf('468212', '11 a 30 personas'), 'C');
});

test('CSV 파싱 + 가져오기 행 정규화(가공 CSV · DENUE 원본 둘 다)', () => {
  const csv = '﻿denue_id,nom_estab,scian_code,lat,lng,address,cve_ent,municipio\n"123","Refaccionaria ""El Sol""",468211,25.67,-100.25,"Av. Juárez 100, int 2",19,Guadalupe\n';
  const rows = parseCsv(csv);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].nom_estab, 'Refaccionaria "El Sol"');
  const n = normalizeImportRow(rows[0]);
  assert.equal(n.segment, 'refaccionaria'); assert.equal(n.priority, 'A'); assert.equal(n.lat, 25.67);
  const raw = normalizeImportRow({ id: '9', clee: '19039811111000011000000000U3', nom_estab: '', raz_social: 'TALLER SA', codigo_act: '811111',
    latitud: '25.6', longitud: '-100.3', tipo_vial: 'CALLE', nom_vial: 'HIDALGO', numero_ext: '5', per_ocu: '6 a 10 personas' });
  assert.equal(raw.nom_estab, 'TALLER SA'); assert.equal(raw.cve_ent, '19'); assert.equal(raw.address, 'CALLE HIDALGO 5'); assert.equal(raw.priority, 'B');
  assert.equal(normalizeImportRow({ id: '1', nom_estab: 'X' }).error, 'bad_geo');
  assert.equal(normalizeImportRow({ nom_estab: 'X', lat: 1, lng: 1 }).error, 'no_denue_id');
  assert.match(normalizeImportRow({ id: '7', codigo_act: '468212', nomb_asent: 'CENTRO', latitud: '25.6', longitud: '-100.3' }).nom_estab, /^\(Sin nombre\) 468212 · CENTRO$/);
});

test('지역 판정: 같은 주 · CP 우선 · municipio 강세 무시', () => {
  const T = [
    { id: 1, cve_ent: '19', municipios: ['San Nicolás de los Garza'], cps: [], active: true },
    { id: 2, cve_ent: '19', municipios: [], cps: ['67100'], active: true },
    { id: 3, cve_ent: '31', municipios: ['Mérida'], cps: [], active: true },
  ];
  assert.equal(territoryFor({ cve_ent: '19', municipio: 'San Nicolas de los Garza', cp: '66400' }, T).id, 1);
  assert.equal(territoryFor({ cve_ent: '19', municipio: 'Guadalupe', cp: '67100' }, T).id, 2);
  assert.equal(territoryFor({ cve_ent: '31', municipio: 'Merida' }, T).id, 3);
  assert.equal(territoryFor({ cve_ent: '19', municipio: 'Mérida' }, T), null);
});

test('거리·방문 순서(최근접)', () => {
  const d = distanceM(25.6785, -100.2551, 25.6753, -100.2551);
  assert.ok(d > 340 && d < 370, String(d));
  const o = orderStops([{ id: 1, lat: 25.70, lng: -100.30 }, { id: 2, lat: 25.60, lng: -100.30 }, { id: 3, lat: 25.69, lng: -100.30 }],
    { lat: 25.71, lng: -100.30 });
  assert.deepEqual(o.map((x) => x.id), [1, 3, 2]);
});

test('고객 매칭: RFC 100 · 전화+상호 · 불용어 무시', () => {
  assert.ok(nameSimilarity('Refaccionaria Tacubaya', 'REFACCIONES TACUBAYA SA DE CV') >= 0.99);
  assert.equal(matchScore({ rfc: 'RTA010101AB1' }, { rfc: 'rta010101ab1' }).score, 100);
  const m = matchScore({ nom_estab: 'Amortiguadores NL', phone: '81 1234 5678' }, { name: 'Amortiguadores N.L.', phone: '+52 (81) 1234-5678' });
  assert.ok(m.score >= 80 && m.reasons.includes('telefono'), JSON.stringify(m));
  const s = suggestCustomers({ nom_estab: 'Taller Garcia' }, [{ id: 1, name: 'Taller García Hnos' }, { id: 2, name: 'Otro' }]);
  assert.equal(s[0].customer_id, 1);
});

test('DENUE 미리 채움', () => {
  const v = prefillFromProspect({ nom_estab: 'Refaccionaria Moderna', address: 'Avenida BENITO JUÁREZ 511', colonia: 'Centro',
    cp: '67100', municipio: 'Guadalupe', entidad: 'Nuevo León', phone: '8112345678', segment: 'taller_suspension' });
  assert.equal(v['datos_generales.calle'], 'Avenida BENITO JUÁREZ');
  assert.equal(v['datos_generales.numero'], '511');
  assert.deepEqual(v['servicios.servicios'], ['Chasis y Suspensión']);
  const w = prefillFromProspect({ address: 'Calle SIERRA DE LAMPAZOS 1321 A' });
  assert.equal(w['datos_generales.calle'], 'Calle SIERRA DE LAMPAZOS'); assert.equal(w['datos_generales.numero'], '1321 A');
  assert.equal(prefillFromProspect({ address: 'Calle ALDAMA SN' })['datos_generales.numero'], 'SN');
  assert.deepEqual(v['tipo_taller.tipo_taller'], ['Reparación General']);
});

test('AI 프롬프트: 규칙·전사문·ia 항목만 포함', () => {
  const p = buildAltaPrompt({ transcript: 'hola soy Juan', companyName: 'X', prefill: { 'datos_generales.ciudad': 'Guadalupe' } });
  assert.ok(p.includes('Nunca inventes'));
  assert.ok(p.includes('hola soy Juan'));
  assert.ok(p.includes('datos_generales.contacto_principal'));
  assert.ok(!p.includes('facturacion.uso_cfdi'));           // manual 전용은 AI 에 묻지 않는다
  assert.ok(p.includes('competencia.N.marca'));
});

test('AI 응답 파싱: 형식 보정 · 옵션 제한 · 경쟁사 펼침 · 모르는 키 버림', () => {
  const txt = 'Claro:\n' + JSON.stringify({
    resumen: 'Visita breve.',
    campos: {
      'datos_generales.contacto_principal': { valor: 'Sr. Ramírez', evidencia: 'soy Ramírez', confianza: 'alta' },
      'informacion_empresa.num_tecnicos': { valor: '4 técnicos', confianza: 'media' },
      'informacion_empresa.ofrece_credito': { valor: 'sí' },
      'informacion_empresa.horario_apertura_lv': { valor: '8.30' },
      'tipo_taller.tipo_taller': { valor: ['refaccionaria', 'Inventado'] },
      'facturacion.uso_cfdi': { valor: 'G03' },                     // manual 전용 → 버림
      'no.existe': { valor: 1 },
      'datos_generales.correo': { valor: 'no-es-correo' },           // 형식 틀림 → 버림
    },
    competencia: [{ marca: 'SYD', precio_compra: '$450.50', evidencia: 'compro SYD a 450' }, { marca: 'Moog' }],
    etapa_sugerida: 'interesado', fecha_siguiente_paso: '2026-11-27',
  });
  const d = parseAltaDraft(txt);
  assert.equal(d.campos['datos_generales.contacto_principal'].valor, 'Sr. Ramírez');
  assert.equal(d.campos['informacion_empresa.num_tecnicos'].valor, 4);
  assert.equal(d.campos['informacion_empresa.ofrece_credito'].valor, true);
  assert.equal(d.campos['informacion_empresa.horario_apertura_lv'].valor, '08:30');
  assert.deepEqual(d.campos['tipo_taller.tipo_taller'].valor, ['Refaccionaria']);
  assert.equal(d.campos['facturacion.uso_cfdi'], undefined);
  assert.equal(d.campos['no.existe'], undefined);
  assert.equal(d.campos['datos_generales.correo'], undefined);
  assert.equal(d.campos['competencia.1.precio_compra'].valor, 450.5);
  assert.equal(d.campos['competencia.2.marca'].valor, 'Moog');
  assert.equal(d.etapa_sugerida, 'interesado');
  assert.equal(parseAltaDraft('no json'), null);
});

test('검토 병합 우선순위: AI > 저장 > DENUE', () => {
  const m = mergeForReview({
    prefill: { 'datos_generales.ciudad': 'Guadalupe', 'datos_generales.telefono': '811' },
    saved: { 'datos_generales.telefono': '8112223333' },
    draft: { campos: { 'datos_generales.contacto_principal': { valor: 'Ana', evidencia: 'soy Ana', confianza: 'baja' } } },
  });
  assert.equal(m['datos_generales.contacto_principal'].source, 'ia');
  assert.equal(m['datos_generales.contacto_principal'].confidence, 'baja');
  assert.equal(m['datos_generales.telefono'].source, 'guardado');
  assert.equal(m['datos_generales.ciudad'].source, 'denue');
  assert.equal(m['datos_generales.correo'].source, null);
});

test('저장 검증 · 필수 누락(청구 제외)', () => {
  const { clean, errors } = validateAltaValues({ 'datos_generales.correo': 'malo', 'tamano_cliente.num_vendedores': '3', 'x.y': 1, 'datos_generales.calle': '' });
  assert.deepEqual(errors.map((e) => e.key), ['datos_generales.correo']);
  assert.equal(clean['tamano_cliente.num_vendedores'], 3);
  assert.equal(clean['datos_generales.calle'], null);
  assert.ok(!('x.y' in clean));
  const miss = missingRequired({ 'datos_generales.nombre_cuenta': 'X' });
  assert.ok(miss.includes('datos_generales.contacto_principal'));
  assert.ok(!miss.some((k) => k.startsWith('facturacion.')));
  assert.equal(coerceValue(ALTA_FIELD_MAP['facturacion.rfc'], 'xaxx010101000'), 'xaxx010101000');
  assert.equal(coerceValue(ALTA_FIELD_MAP['facturacion.rfc'], 'abc'), null);
});

test('KPI: 달성률 · 경과일 비례 판정 · 월 경계', () => {
  assert.equal(pct(41, 40), 102.5);
  assert.equal(pct(5, 0), null);
  assert.equal(paceStatus(10, 30, 10, 30), 'ok');
  assert.equal(paceStatus(8, 30, 10, 30), 'warn');
  assert.equal(paceStatus(5, 30, 10, 30), 'bad');
  assert.deepEqual(periodBounds('2026-12'), { from: '2026-12-01', to: '2027-01-01', days: 31 });
  assert.equal(periodBounds('2026-02').days, 28);
});

test('잠재성: 월 서스펜션 구매액으로 A/B/C · 비중', () => {
  const p = potentialOf({ 'potencial.compra_total_mensual': 200000, 'potencial.compra_suspension_mensual': 60000,
    'potencial.venta_total_mensual': 300000, 'potencial.venta_suspension_mensual': 90000 });
  assert.equal(p.tier, 'A'); assert.equal(p.share_susp_compra, 30); assert.equal(p.share_susp_venta, 30);
  assert.equal(potentialOf({ 'potencial.compra_suspension_mensual': 15000 }).tier, 'B');
  assert.equal(potentialOf({ 'potencial.compra_suspension_mensual': 0 }).tier, 'C');
  assert.equal(potentialOf({ 'potencial.compra_total_mensual': 1000 }).tier, null);
  assert.equal(POTENTIAL_TIERS[0].min, 50000);
  const d = parseAltaDraft(JSON.stringify({ campos: { 'potencial.compra_suspension_mensual': { valor: '$ 45,000' },
    'tamano_cliente.metodo_entrega': { valor: ['paqueteria', 'Reparto en moto'] } } }));
  assert.equal(d.campos['potencial.compra_suspension_mensual'].valor, 45000);
  assert.deepEqual(d.campos['tamano_cliente.metodo_entrega'].valor, ['Paquetería', 'Reparto en moto']);
});

test('정보 충족도: 섹션 가중치 · 경쟁사는 가장 많이 채운 1세트 · 청구 제외', () => {
  assert.equal(infoCompleteness({}).pct, 0);
  const all = Object.fromEntries(ALTA_FIELDS.filter((f) => f.section !== 'facturacion').map((f) => [f.key, f.type === 'multiselect' ? [f.options[0]] : f.type === 'boolean' ? true : 1]));
  assert.equal(infoCompleteness(all).pct, 100);
  const one = { 'competencia.2.marca': 'SYD', 'competencia.2.proveedor': 'X', 'competencia.2.producto_ejemplo': 'Y', 'competencia.2.precio_compra': 1, 'competencia.2.precio_venta_publico': 2 };
  assert.equal(infoCompleteness(one).pct, 15);
  assert.equal(infoCompleteness({ 'facturacion.rfc': 'XAXX010101000' }).pct, 0);
  const pot = { 'potencial.venta_total_mensual': 1, 'potencial.venta_suspension_mensual': 1, 'potencial.compra_total_mensual': 1, 'potencial.compra_suspension_mensual': 1 };
  assert.equal(infoCompleteness(pot).pct, 25);
});

test('개발 점수: 정보 60 + 관심 5 + 견적 15 + 등록 10 · 첫 매출 100', () => {
  assert.equal(scoreOf({ info_pct: 20 }).total, 12);
  assert.equal(scoreOf({ info_pct: 70 }).total, 42);
  assert.equal(scoreOf({ info_pct: 70, interest: true }).total, 47);
  assert.equal(scoreOf({ info_pct: 70, interest: true, quoted: true }).total, 62);
  assert.equal(scoreOf({ info_pct: 70, interest: true, quoted: true, linked: true }).total, 72);
  assert.equal(scoreOf({ info_pct: 100, interest: true, quoted: true, linked: true }).total, 90);
  assert.equal(scoreOf({ info_pct: 10, sale: true }).total, 100);
  assert.equal(SCORE_RULES.info_max + SCORE_RULES.interest + SCORE_RULES.quote + SCORE_RULES.registro, 90);
});

test('근거 기반 단계 + 제안', () => {
  assert.equal(deriveStage({ owner: false, visits: 0 }, 'sin_asignar').auto, 'sin_asignar');
  assert.equal(deriveStage({ owner: true, visits: 0 }, 'sin_asignar').auto, 'asignado');
  assert.equal(deriveStage({ owner: true, visits: 1, info_pct: 30 }, 'asignado').auto, 'contactado');
  assert.equal(deriveStage({ owner: true, visits: 2, info_pct: 55 }, 'contactado').auto, 'perfilado');
  assert.equal(deriveStage({ owner: true, visits: 1, info_pct: 55, interest_confirmed: true }, 'perfilado').auto, 'interesado');
  assert.equal(deriveStage({ owner: true, visits: 1, quoted: true }, 'perfilado').auto, 'cotizado');
  assert.equal(deriveStage({ owner: true, visits: 1, linked: true }, 'cotizado').auto, 'registro');
  assert.equal(deriveStage({ owner: true, linked: true, sale: true }, 'registro').auto, 'cliente_activo');
  const s1 = deriveStage({ owner: true, visits: 1, info_pct: 55, ai_stage: 'interesado' }, 'perfilado');
  assert.equal(s1.suggest.stage, 'interesado');
  assert.equal(deriveStage({ owner: true, visits: 1, ai_stage: 'descartado' }, 'contactado').suggest.stage, 'descartado');
  assert.equal(deriveStage({ owner: true, visits: 1, ai_stage: 'cotizado' }, 'perfilado').suggest, null);   // 견적은 ERP 견적서로만
  assert.ok(STAGE_RANK_SQL('x').includes("WHEN 'perfilado' THEN 3"));
});

test('구역 루트: 다각형 판정 · 2-opt 최적화 · 우선 고르기 · 주 단위 기간', () => {
  const sq = [[25.60, -100.40], [25.60, -100.20], [25.80, -100.20], [25.80, -100.40]];
  assert.equal(inPolygon(25.70, -100.30, sq), true);
  assert.equal(inPolygon(25.90, -100.30, sq), false);
  // 지그재그로 주면 최근접 순서보다 짧거나 같아야 한다
  const pts = [{ id: 1, lat: 25.70, lng: -100.30 }, { id: 2, lat: 25.70, lng: -100.20 }, { id: 3, lat: 25.70, lng: -100.25 }, { id: 4, lat: 25.70, lng: -100.35 }];
  const o = optimizeRoute(pts, { lat: 25.70, lng: -100.40 });
  assert.deepEqual(o.stops.map((x) => x.id), [4, 1, 3, 2]);
  assert.ok(o.distance_m > 19000 && o.distance_m < 21000, String(o.distance_m));
  const r = [{ id: 1, priority: 'C' }, { id: 2, priority: 'A', pot_tier: 'B' }, { id: 3, priority: 'A', pot_tier: 'A' }].sort(rankForRoute);
  assert.deepEqual(r.map((x) => x.id), [3, 2, 1]);
  assert.deepEqual(weekBounds('2026-11-25'), { from: '2026-11-23', to: '2026-11-30', days: 7 });
  assert.equal(routeMinutes(22000, 4), 160);
});
