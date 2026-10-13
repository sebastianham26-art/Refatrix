// =====================================================================
// Refatrix ERP · metaLeadExtract.js — Meta 광고 문의에서 업종 · 지역 · 연락처 · 차종 · 부품 뽑기 (0270)
//
//   순수 함수만 둔다(DB · 네트워크 없음) — 시험으로 규칙을 고정한다.
//   입력은 「고객이 쓴 말」만이다. 우리 쪽(봇 · 직원) 문구는 넣지 않는다 — 봇 안내문에
//   「WhatsApp 8118250003」이 들어 있어 고객 전화로 잘못 잡히던 것을 막는다.
//
//   광고 버튼 문구 「Soy Particular de MTY, quiero comprar producto CTR…」는 고객이 누른 것이지만
//   「MTY」는 버튼에 박힌 글자라 지역으로 쓰지 않는다. 업종은 a_tipo_btn 으로 따로(참고값) 둔다.
// =====================================================================

const strip = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// 광고 빠른 답장 버튼(고객이 누르면 고객 메시지로 들어온다)
const BUTTON_RE = /soy (particular|refaccionaria|mayorista|taller mecanico|flotilla) de mty,? quiero comprar producto ctr como equipo origina[l]?/g;
const CANNED = [
  /quiero conocer su catalogo/g, /¿?como puedo cotizar o hacer una compra\??/g, /¿?hacen envios a toda la republica\??/g,
  /quiero hablar con un asesor de ventas/g, /quiero cotizar/g, /ver catalogo/g,
];
const BTN_TIPO = { particular: 'Particular', refaccionaria: 'Refaccionaria', mayorista: 'Mayorista', 'taller mecanico': 'Taller mecánico', flotilla: 'Flotilla' };

// ── 업종 ──
const TIPO_RULES = [
  ['Refaccionaria', /\b(refaccionaria|refaccionarias|refacciones? (para|de) (venta|mi negocio)|tengo (una )?(tienda|refaccionaria)|autopartes .*negocio|negocio de (refacciones|autopartes))\b/],
  ['Mayorista', /\b((soy|somos) (mayorista|distribuidor(a|es)?)|tengo (una )?distribuidora|vendo (refacciones|autopartes) (al )?mayoreo)\b/],
  ['Taller mecánico', /\b(taller|mecanico|mecanica automotriz|soy mecanic|servicio automotriz)\b/],
  ['Flotilla', /\b(flotilla|flota|flotillas)\b/],
  ['Taxi / app', /\b(taxi|taxista|uber|didi|indriver|trabajo en (app|plataforma)|plataforma)\b/],
  ['Particular', /\b(particular|para mi (auto|carro|coche|carrito|vehiculo)|uso personal|es para mi)\b/],
];

// ── 지역(주 · 도시) ──
//   애매한 도시 이름(사람 성씨 · 차 이름과 겹침)은 「en / de / desde / soy de」 뒤에 올 때만 인정한다.
const STATES = [
  ['Aguascalientes', ['aguascalientes', 'ags']],
  ['Baja California', ['baja california', 'tijuana', 'mexicali', 'ensenada', 'tecate', 'rosarito']],
  ['Baja California Sur', ['baja california sur', 'la paz bcs', 'los cabos', 'cabo san lucas', 'san jose del cabo']],
  ['Campeche', ['campeche', 'ciudad del carmen']],
  ['Chiapas', ['chiapas', 'tuxtla', 'tapachula', 'san cristobal de las casas']],
  ['Chihuahua', ['chihuahua', 'ciudad juarez', 'cd juarez', 'cd. juarez', 'delicias', 'parral', 'cuauhtemoc chihuahua']],
  ['Ciudad de México', ['cdmx', 'ciudad de mexico', 'distrito federal', 'iztapalapa', 'coyoacan', 'tlalpan', 'xochimilco', 'gustavo a madero', 'azcapotzalco', 'iztacalco', 'venustiano carranza', 'tlahuac', 'milpa alta', 'alvaro obregon', 'benito juarez cdmx', 'miguel hidalgo cdmx']],
  ['Coahuila', ['coahuila', 'saltillo', 'torreon', 'monclova', 'piedras negras', 'ramos arizpe', 'acuna', 'sabinas']],
  ['Colima', ['colima', 'manzanillo']],
  ['Durango', ['durango', 'gomez palacio', 'lerdo']],
  ['Guanajuato', ['guanajuato', 'irapuato', 'celaya', 'salamanca', 'silao', 'san miguel de allende', 'leon gto', 'leon guanajuato']],
  ['Guerrero', ['guerrero', 'acapulco', 'chilpancingo', 'iguala', 'zihuatanejo', 'taxco']],
  ['Hidalgo', ['hidalgo', 'pachuca', 'tulancingo', 'tula de allende', 'tizayuca']],
  ['Jalisco', ['jalisco', 'guadalajara', 'gdl', 'zapopan', 'tlaquepaque', 'tonala', 'tlajomulco', 'puerto vallarta', 'lagos de moreno', 'tepatitlan', 'ocotlan', 'jocotepec', 'cocula']],
  ['Estado de México', ['estado de mexico', 'edo mex', 'edomex', 'edo. mex', 'toluca', 'ecatepec', 'nezahualcoyotl', 'neza', 'naucalpan', 'tlalnepantla', 'ixtapaluca', 'texcoco', 'chalco', 'huixquilucan', 'cuautitlan', 'tecamac', 'nicolas romero', 'atizapan', 'chimalhuacan', 'la paz edomex', 'valle de chalco', 'zumpango', 'metepec', 'el oro']],
  ['Michoacán', ['michoacan', 'morelia', 'uruapan', 'zamora', 'lazaro cardenas', 'apatzingan']],
  ['Morelos', ['morelos', 'cuernavaca', 'jiutepec', 'cuautla', 'temixco', 'yautepec']],
  ['Nayarit', ['nayarit', 'tepic']],
  ['Nuevo León', ['nuevo leon', 'monterrey', 'mty', 'apodaca', 'san nicolas de los garza', 'san nicolas', 'santa catarina', 'san pedro garza', 'cadereyta', 'linares', 'general escobedo', 'pesqueria', 'zuazua', 'cienega de flores', 'montemorelos', 'salinas victoria', 'villa de garcia']],
  ['Oaxaca', ['oaxaca', 'salina cruz', 'juchitan', 'tuxtepec']],
  ['Puebla', ['puebla', 'tehuacan', 'atlixco', 'san martin texmelucan', 'cholula']],
  ['Querétaro', ['queretaro', 'qro', 'san juan del rio', 'pedro escobedo', 'corregidora', 'el marques']],
  ['Quintana Roo', ['quintana roo', 'cancun', 'chetumal', 'playa del carmen', 'tulum', 'cozumel']],
  ['San Luis Potosí', ['san luis potosi', 'slp', 'ciudad valles', 'matehuala', 'soledad de graciano']],
  ['Sinaloa', ['sinaloa', 'culiacan', 'mazatlan', 'los mochis', 'guasave']],
  ['Sonora', ['sonora', 'hermosillo', 'ciudad obregon', 'cd obregon', 'nogales', 'navojoa', 'san luis rio colorado', 'guaymas']],
  ['Tabasco', ['tabasco', 'villahermosa', 'cardenas tabasco']],
  ['Tamaulipas', ['tamaulipas', 'reynosa', 'nuevo laredo', 'tampico', 'ciudad victoria', 'cd victoria', 'madero tamaulipas', 'altamira', 'rio bravo']],
  ['Tlaxcala', ['tlaxcala', 'apizaco', 'huamantla', 'tepeyanco']],
  ['Veracruz', ['veracruz', 'xalapa', 'jalapa', 'coatzacoalcos', 'poza rica', 'orizaba', 'minatitlan', 'tuxpan', 'boca del rio', 'alvarado', 'papantla', 'martinez de la torre']],
  ['Yucatán', ['yucatan', 'merida', 'valladolid', 'progreso', 'tizimin', 'uman']],
  ['Zacatecas', ['zacatecas', 'fresnillo']],
];
// 앞에 「en/de/desde/soy de」가 있어야 인정
const AMBIGUOUS = [
  ['Nuevo León', ['guadalupe', 'escobedo', 'garcia', 'juarez']],
  ['Guanajuato', ['leon']],
  ['Tamaulipas', ['matamoros', 'victoria']],
  ['Veracruz', ['cordoba']],
  ['Baja California Sur', ['la paz']],
];
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const STATE_RES = STATES.flatMap(([st, names]) => names.map((n) => [st, n, new RegExp(`(^|[^a-z])${esc(n)}([^a-z]|$)`)]));
const AMB_RES = AMBIGUOUS.flatMap(([st, names]) => names.map((n) => [st, n, new RegExp(`\\b(en|de|desde|soy de|vivo en|estoy en)\\s+${esc(n)}\\b`)]));
const TITLE = (s) => s.replace(/\b\w/g, (c) => c.toUpperCase());

// ── 차종 ──
const VEHICLES = [
  ['Nissan', 'Versa', /\b(versa|verza|bersa|berza|vers)(?![a-z])/], ['Nissan', 'Sentra', /\b(sentra|sentr|centra)(?![a-z])/], ['Nissan', 'March', /\b(march|marh)(?![a-z])/],
  ['Nissan', 'Tsuru', /\btsuru(?![a-z])/], ['Nissan', 'Tiida', /\b(tiida|tida|tiída)(?![a-z])/], ['Nissan', 'Kicks', /\b(kicks|kics|kiks|kick)(?![a-z])/],
  ['Nissan', 'V-Drive', /\bv[- ]?drive(?![a-z])/], ['Nissan', 'NP300 / Frontier', /\b(np ?300|frontier|estaquitas)(?![a-z])/], ['Nissan', 'X-Trail', /\bx[- ]?trail(?![a-z])/],
  ['Nissan', 'Altima', /\baltima(?![a-z])/], ['Nissan', 'Platina', /\bplatina(?![a-z])/], ['Nissan', 'Note', /\bnissan note(?![a-z])/], ['Nissan', 'Urvan', /\burvan(?![a-z])/], ['Nissan', 'Juke', /\bjuke(?![a-z])/],
  ['Chevrolet', 'Aveo', /\b(aveo|abeo)(?![a-z])/], ['Chevrolet', 'Spark', /\bspark(?![a-z])/], ['Chevrolet', 'Beat', /\bbeat(?![a-z])/], ['Chevrolet', 'Sonic', /\bsonic(?![a-z])/],
  ['Chevrolet', 'Cruze', /\bcruze(?![a-z])/], ['Chevrolet', 'Chevy', /\bchevy(?![a-z])/], ['Chevrolet', 'S10', /\b(s ?-?10|a10)(?![a-z])/], ['Chevrolet', 'Silverado', /\bsilverado(?![a-z])/],
  ['Chevrolet', 'Tornado', /\btornado(?![a-z])/], ['Chevrolet', 'Matiz', /\bmatiz(?![a-z])/], ['Chevrolet', 'Optra', /\boptra(?![a-z])/], ['Chevrolet', 'Captiva', /\bcaptiva(?![a-z])/],
  ['Chevrolet', 'Trax', /\btrax(?![a-z])/], ['Chevrolet', 'Onix', /\bonix(?![a-z])/], ['Chevrolet', 'Cavalier', /\bcavalier(?![a-z])/],
  ['Ford', 'Fiesta', /\bfiesta(?![a-z])/], ['Ford', 'Focus', /\bfocus(?![a-z])/], ['Ford', 'Ikon', /\bikon(?![a-z])/], ['Ford', 'Ka', /\bford ka(?![a-z])/], ['Ford', 'Figo', /\bfigo(?![a-z])/],
  ['Ford', 'Ranger', /\branger(?![a-z])/], ['Ford', 'F-150', /\bf[- ]?150(?![a-z])/], ['Ford', 'EcoSport', /\becosport(?![a-z])/], ['Ford', 'Escape', /\bescape(?![a-z])/],
  ['Volkswagen', 'Jetta', /\b(jetta|jeta)(?![a-z])/], ['Volkswagen', 'Vento', /\bvento(?![a-z])/], ['Volkswagen', 'Golf', /\bgolf(?![a-z])/], ['Volkswagen', 'Pointer', /\bpointer(?![a-z])/],
  ['Volkswagen', 'Gol', /\bgol(?![a-z])/], ['Volkswagen', 'Polo', /\bpolo(?![a-z])/], ['Volkswagen', 'Sedán (Vocho)', /\b(vocho|sedan vw)(?![a-z])/], ['Volkswagen', 'Virtus', /\bvirtus(?![a-z])/],
  ['Toyota', 'Corolla', /\bcorolla(?![a-z])/], ['Toyota', 'Yaris', /\byaris(?![a-z])/], ['Toyota', 'Hilux', /\bhilux(?![a-z])/], ['Toyota', 'Tacoma', /\btacoma(?![a-z])/], ['Toyota', 'Avanza', /\bavanza(?![a-z])/], ['Toyota', 'Camry', /\bcamry(?![a-z])/],
  ['Honda', 'Civic', /\bcivic(?![a-z])/], ['Honda', 'Accord', /\baccord(?![a-z])/], ['Honda', 'CR-V', /\bcr[- ]?v(?![a-z])/], ['Honda', 'City', /\bhonda city(?![a-z])/], ['Honda', 'Fit', /\bhonda fit(?![a-z])/],
  ['Mazda', 'Mazda 2/3', /\bmazda ?[23](?![a-z])/], ['Mazda', 'CX-5', /\bcx[- ]?5(?![a-z])/],
  ['Hyundai', 'Grand i10', /\b(grand )?i10(?![a-z])/], ['Hyundai', 'Accent', /\baccent(?![a-z])/], ['Hyundai', 'Elantra', /\belantra(?![a-z])/], ['Hyundai', 'Tucson', /\btucson(?![a-z])/],
  ['Kia', 'Rio', /\bkia rio\b|\brio (19|20)\d\d(?![a-z])/], ['Kia', 'Forte', /\bforte(?![a-z])/], ['Kia', 'Soul', /\bsoul(?![a-z])/], ['Kia', 'Sportage', /\bsportage(?![a-z])/], ['Kia', 'Seltos', /\bseltos(?![a-z])/],
  ['Dodge', 'Attitude', /\battitude(?![a-z])/], ['Dodge', 'Neon', /\bneon(?![a-z])/], ['Dodge', 'Journey', /\bjourney(?![a-z])/], ['RAM', 'RAM', /\bram (700|1500|2500)(?![a-z])/],
  ['Renault', 'Duster', /\bduster(?![a-z])/], ['Renault', 'Logan', /\blogan(?![a-z])/], ['Renault', 'Kwid', /\bkwid(?![a-z])/], ['Renault', 'Sandero', /\bsandero(?![a-z])/], ['Renault', 'Clio', /\bclio(?![a-z])/],
  ['Seat', 'Ibiza', /\bibiza(?![a-z])/], ['Seat', 'León', /\bseat leon(?![a-z])/], ['Seat', 'Toledo', /\btoledo(?![a-z])/],
  ['Mitsubishi', 'Lancer', /\blancer(?![a-z])/], ['Mitsubishi', 'Mirage', /\bmirage(?![a-z])/], ['Mitsubishi', 'L200', /\bl ?200(?![a-z])/],
  ['Suzuki', 'Swift', /\bswift(?![a-z])/], ['Suzuki', 'Ertiga', /\bertiga(?![a-z])/], ['Suzuki', 'Vitara', /\bvitara(?![a-z])/],
];

// ── 부품(스페인어 표준 이름) ──
const PARTS = [
  ['Horquilla (brazo de control)', /\b(h?orqu?ill?as?|horquia|ojrquilla|brazos? de control|brazo inferior|brazo superior)\b/],
  ['Rótula', /\brotulas?\b/],
  ['Terminal exterior', /\bterminal(es)? (de direccion )?(exterior|ext)\b/],
  ['Terminal interior', /\b(terminal(es)? (de direccion )?(interior|int|(exterior|ext) y (interior|int))|bayonetas?|tie ?rods?|varillas? de direccion)\b/],
  ['Terminal', /\bterminal(es)?\b/],
  ['Bieleta / tornillo estabilizador', /\b(bieletas?|torni(ll|y)os? (de )?(la )?barra( estabilizadora)?|links? estabilizador|estabilizador(es)?)\b/],
  ['Barra estabilizadora', /\bbarra estabilizadora\b/],
  ['Amortiguador', /\b(amortiguador(es)?|amortiguadoras?|shocks?)\b/],
  ['Base de amortiguador', /\b(bases? (de|del|para) (los )?amortiguador(es)?|soportes? de amortiguador(es)?|cazoletas?)\b/],
  ['Buje / cacahuate', /\b(bujes?|cacahuates?|gomas?)\b/],
  ['Soporte de motor / transmisión', /\b(soportes? (de )?(motor|transmision|caja)|soporte motor)\b/],
  ['Maza / balero', /\b(mazas?|maza de rueda|baleros?|rodamientos?)\b/],
  ['Cremallera / caja de dirección', /\b(cremallera|caja de direccion)\b/],
  ['Resorte / espiral', /\b(resortes?|espirales?|muelles?)\b/],
  ['Tirante / tensor', /\b(tirantes?|tensor(es)?)\b/],
  ['Suspensión completa (kit)', /\b(kit (de )?suspension|suspension completa|toda la suspension|todo (lo )?de (la )?suspension|partes de la suspension)\b/],
  ['Frenos (fuera de línea)', /\b(balatas?|frenos?|discos? de freno)\b/],
];

const INTENTS = [
  ['Precio', /\b(precio|precios|costo|cuanto (cuesta|sale|salen|vale)|cotiza|cotizacion)\b/],
  ['Catálogo', /\b(catalogo|lista de precios)\b/],
  ['Envío', /\b(envio|envios|mandan|paqueteria|codigo postal)\b/],
  ['Dónde comprar', /\b(donde (puedo )?(conseguir|comprar)|tienda fisica|sucursal|donde se ubican|ubicacion)\b/],
  ['Asesor', /\b(asesor|agente|hablar con)\b/],
];

const OUR_PHONES = new Set(['8118250003', '8116606680']);   // 우리 번호(봇 안내문) — 고객 전화로 잡지 않는다

export function extractPhone(text) {
  const out = [];
  const s = String(text || '');
  const re = /(?:\+?\s?52[\s.-]?)?(?:1[\s.-]?)?(\d{2,3})[\s.-]?(\d{3,4})[\s.-]?(\d{4})(?!\d)/g;
  let m;
  while ((m = re.exec(s))) {
    const d = (m[1] + m[2] + m[3]);
    if (d.length !== 10 || OUR_PHONES.has(d)) continue;
    if (/^(19|20)\d\d/.test(d) && /\b(19|20)\d\d\b/.test(m[0])) continue;   // 「2017 2018 …」 연식 나열
    if (!out.includes(d)) out.push(d);
  }
  return out;
}
export function extractEmail(text) {
  const m = String(text || '').match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i);
  return m && !/marketingrefatrix/i.test(m[0]) ? m[0].toLowerCase() : null;
}

function yearsNear(s, idx, len) {
  // 모델 바로 뒤(같은 줄 60자 안)의 첫 연식 하나 — 「2013-2019 / 2013 a 2019」 같은 범위만 함께. 다음 차 이름의 연식을 끌어오지 않는다.
  const win = s.slice(idx + len, idx + len + 60).split(/\n/)[0];
  const r = win.match(/(?<!\d)((?:19[6-9]|20[0-3])\d)(?:\s*(?:-|\/|a|al)\s*((?:19[6-9]|20[0-3])\d))?(?!\d)/);
  if (r) return r[2] ? [r[1] + '-' + r[2]] : [r[1]];
  const m2 = win.match(/^\s*(?:modelo |mod\.? )?'?([0-2]\d)(?!\d)/);   // 「versa 17」
  if (m2) return ['20' + m2[1]];
  const next = (s.slice(idx + len).split(/\n/)[1] || '').trim();   // 다음 줄에 연식만 따로 보낸 경우
  const m3 = next.match(/^(?:modelo |año )?((?:19[6-9]|20[0-3])\d)$/);
  return m3 ? [m3[1]] : [];
}

// 고객이 쓴 말 → 추출값
export function extractLead(customerText) {
  const raw = String(customerText || '');
  let s = strip(raw);
  const btn = [];
  s = s.replace(BUTTON_RE, (_, t) => { const v = BTN_TIPO[t]; if (v && !btn.includes(v)) btn.push(v); return ' '; });
  const canned = [];
  for (const re of CANNED) s = s.replace(re, (x) => { canned.push(x); return ' '; });

  const tipo = TIPO_RULES.filter(([, re]) => re.test(s)).map(([t]) => t);

  let state = null, city = null;
  for (const [st, , re] of STATE_RES) { if (re.test(s)) { state = st; break; } }
  if (state) {   // 같은 주 안에서 도시 이름이 따로 보이면 그것을 도시로
    const c = STATE_RES.find(([st, n, re]) => st === state && n !== strip(state) && n.length > 3 && re.test(s));
    city = c ? c[1] : null;
  }
  if (!state) for (const [st, n, re] of AMB_RES) { if (re.test(s)) { state = st; city = n; break; } }

  const vehicles = [];
  for (const [brand, model, re] of VEHICLES) {
    const m = re.exec(s);
    if (!m) continue;
    const ys = yearsNear(s, m.index, m[0].length);
    const label = `${brand} ${model}${ys.length ? ' ' + ys[0] : ''}`;
    if (!vehicles.includes(label)) vehicles.push(label);
  }

  let parts = PARTS.filter(([, re]) => re.test(s)).map(([p]) => p);
  if (parts.some((p) => p.startsWith('Terminal ')) ) parts = parts.filter((p) => p !== 'Terminal');
  if (parts.includes('Bieleta / tornillo estabilizador') && /torni(ll|y)os? (de )?(la )?barra/.test(s)) parts = parts.filter((p) => p !== 'Barra estabilizadora');
  // 「bases de amortiguador」만 말했으면 쇼바 자체는 아니다
  if (parts.includes('Base de amortiguador') && !/\bamortiguador/.test(s.replace(/\b(bases?|soportes?) (de|del|para) (los )?amortiguador(es)?/g, ' '))) parts = parts.filter((p) => p !== 'Amortiguador');

  const intents = INTENTS.filter(([, re]) => re.test(s)).map(([t]) => t);
  for (const c of canned) {
    if (/catalogo/.test(c) && !intents.includes('Catálogo')) intents.push('Catálogo');
    if (/cotizar/.test(c) && !intents.includes('Precio')) intents.push('Precio');
    if (/envios/.test(c) && !intents.includes('Envío')) intents.push('Envío');
    if (/asesor/.test(c) && !intents.includes('Asesor')) intents.push('Asesor');
  }

  const phones = extractPhone(raw);
  return {
    tipo: tipo.length ? tipo.join(' / ') : null,
    tipo_btn: btn.length ? btn.join(' / ') : null,
    state, city: city ? TITLE(city) : null,
    phone: phones.length ? phones.join(', ') : null,
    email: extractEmail(raw),
    vehicles: vehicles.length ? vehicles.join('; ') : null,
    parts: parts.length ? parts.join('; ') : null,
    intent: intents.length ? intents.join(', ') : null,
    // 고객이 버튼 말고 자기 말을 썼는가(판매기회 판단용)
    wrote: s.replace(/[^a-z0-9]+/g, ' ').trim().length > 2,
  };
}

export const META_STATES = STATES.map(([s]) => s);
