// =====================================================================
// Refatrix ERP · surveyGeo.js — 손으로 적은 지역(도시·주)을 **멕시코 32개 주**로 정리 (2026-09-14)
//
//   설문지에는 「Mty, N.L.」 「Monterrey」 「NUEVO LEON」 「Mérida Yuc.」 처럼 제각각 적힌다.
//   AI 가 읽은 estado/ciudad 를 여기서 **표준 주 이름 하나**로 맞춘다 — 지역 분석의 기준.
//
//   원칙
//     · 주(estado) 가 읽히면 그것이 이긴다. 없으면 도시로 주를 찾는다.
//     · **여러 주에 같은 이름의 도시가 있으면(Guadalupe · Juárez · Matamoros…) 추측하지 않는다.**
//       주를 비우고 「확인 필요」로 표시해 사람이 고르게 한다. 틀린 주로 집계되는 것보다 낫다.
//     · 원문(raw)은 그대로 보관한다 — 나중에 규칙을 고쳐 다시 정리할 수 있게.
//
//   네트워크·DB 호출 없음. surveyAi.js 가 사용.
// =====================================================================

export function foldGeo(s) {
  return String(s == null ? '' : s)
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9ñ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// 32개 주 — [표준 이름, 우편 약자, 별칭…]
export const STATES = [
  ['Aguascalientes', 'AGS', 'ags'],
  ['Baja California', 'BC', 'b c', 'baja california norte', 'bcn', 'bc norte'],
  ['Baja California Sur', 'BCS', 'b c s', 'bcs'],
  ['Campeche', 'CAMP', 'camp'],
  ['Chiapas', 'CHIS', 'chis'],
  ['Chihuahua', 'CHIH', 'chih'],
  ['Ciudad de México', 'CDMX', 'cdmx', 'df', 'd f', 'distrito federal', 'mexico df', 'df mexico', 'mexico city', 'ciudad mexico'],
  ['Coahuila', 'COAH', 'coah', 'coahuila de zaragoza'],
  ['Colima', 'COL', 'col'],
  ['Durango', 'DGO', 'dgo'],
  ['Estado de México', 'EDOMEX', 'edomex', 'edo mex', 'edo de mexico', 'estado mexico', 'edo méxico', 'mexico estado', 'edo de mex'],
  ['Guanajuato', 'GTO', 'gto'],
  ['Guerrero', 'GRO', 'gro'],
  ['Hidalgo', 'HGO', 'hgo'],
  ['Jalisco', 'JAL', 'jal'],
  ['Michoacán', 'MICH', 'mich', 'michoacan de ocampo'],
  ['Morelos', 'MOR', 'mor'],
  ['Nayarit', 'NAY', 'nay'],
  ['Nuevo León', 'NL', 'nl', 'n l', 'nuevo leon', 'nvo leon', 'nvo león', 'n leon', 'nuevoleon'],
  ['Oaxaca', 'OAX', 'oax'],
  ['Puebla', 'PUE', 'pue'],
  ['Querétaro', 'QRO', 'qro', 'queretaro de arteaga'],
  ['Quintana Roo', 'QROO', 'qroo', 'q roo', 'quintanaroo'],
  ['San Luis Potosí', 'SLP', 's l p', 'slp'],
  ['Sinaloa', 'SIN', 'sin'],
  ['Sonora', 'SON', 'son'],
  ['Tabasco', 'TAB', 'tab'],
  ['Tamaulipas', 'TAMPS', 'tamps', 'tam'],
  ['Tlaxcala', 'TLAX', 'tlax'],
  ['Veracruz', 'VER', 'ver', 'veracruz de ignacio de la llave'],
  ['Yucatán', 'YUC', 'yuc'],
  ['Zacatecas', 'ZAC', 'zac'],
];
export const STATE_NAMES = STATES.map((s) => s[0]);
export const STATE_CODE = {};
const ALIAS = new Map();
for (const [name, code, ...alts] of STATES) {
  STATE_CODE[name] = code;
  ALIAS.set(foldGeo(name), name);
  ALIAS.set(foldGeo(code), name);
  for (const a of alts) ALIAS.set(foldGeo(a), name);
}

// 여러 주에 같은 이름이 있는 도시 — 주를 모르면 추측하지 않는다
export const AMBIGUOUS_CITIES = new Set([
  'guadalupe', 'juarez', 'matamoros', 'sabinas', 'santiago', 'allende', 'tonala', 'la paz', 'loreto',
  'cuauhtemoc', 'progreso', 'benito juarez', 'cardenas', 'carmen', 'tula', 'cuautla', 'victoria',
  'hidalgo', 'morelos', 'jimenez', 'union', 'ocampo', 'zaragoza', 'altamira nuevo', 'san pedro',
  'santa catarina', 'guerrero', 'lazaro cardenas', 'tuxpan', 'salamanca', 'linares',
].map(foldGeo));

// 도시 → 주 (주가 안 적혔을 때만 쓰는 보조 표. 헷갈리는 이름은 위 목록에서 제외)
const CITY_TABLE = {
  'Nuevo León': ['Monterrey', 'Mty', 'San Nicolás de los Garza', 'San Nicolas', 'San Pedro Garza García', 'Apodaca',
    'General Escobedo', 'Escobedo', 'Santa Catarina NL', 'García NL', 'Montemorelos', 'Sabinas Hidalgo', 'Cadereyta Jiménez',
    'Salinas Victoria', 'Ciénega de Flores', 'El Carmen NL', 'Pesquería', 'Juárez NL', 'Guadalupe NL', 'Área Metropolitana de Monterrey', 'AMM'],
  'Yucatán': ['Mérida', 'Kanasín', 'Umán', 'Tizimín', 'Motul', 'Ticul', 'Valladolid Yucatán', 'Izamal', 'Progreso Yucatán', 'Hunucmá', 'Tekax'],
  'Coahuila': ['Saltillo', 'Torreón', 'Monclova', 'Piedras Negras', 'Ramos Arizpe', 'Ciudad Acuña', 'Acuña', 'Frontera', 'San Pedro de las Colonias', 'Múzquiz', 'Parras'],
  'Tamaulipas': ['Reynosa', 'Nuevo Laredo', 'Tampico', 'Ciudad Victoria', 'Altamira', 'Ciudad Madero', 'Madero', 'Río Bravo', 'Mante', 'Ciudad Mante', 'Miguel Alemán', 'Valle Hermoso'],
  'Jalisco': ['Guadalajara', 'GDL', 'Zapopan', 'Tlaquepaque', 'San Pedro Tlaquepaque', 'Tlajomulco', 'Puerto Vallarta', 'Lagos de Moreno', 'Tepatitlán', 'Ocotlán', 'El Salto', 'Zapotlanejo', 'Chapala', 'Ciudad Guzmán'],
  'Ciudad de México': ['Iztapalapa', 'Coyoacán', 'Gustavo A Madero', 'Azcapotzalco', 'Tlalpan', 'Xochimilco', 'Polanco', 'Iztacalco',
    'Venustiano Carranza', 'Miguel Hidalgo CDMX', 'Álvaro Obregón', 'Cuajimalpa', 'Tláhuac', 'Magdalena Contreras', 'Milpa Alta', 'Santa Fe CDMX'],
  'Estado de México': ['Toluca', 'Ecatepec', 'Naucalpan', 'Nezahualcóyotl', 'Neza', 'Tlalnepantla', 'Cuautitlán', 'Cuautitlán Izcalli',
    'Atizapán', 'Chalco', 'Texcoco', 'Metepec', 'Lerma', 'Huixquilucan', 'Zumpango', 'Coacalco', 'Tultitlán', 'Ixtapaluca', 'Nicolás Romero', 'Valle de Chalco'],
  'Puebla': ['Puebla', 'Tehuacán', 'Cholula', 'San Andrés Cholula', 'Atlixco', 'Amozoc', 'San Martín Texmelucan', 'Teziutlán'],
  'Querétaro': ['Querétaro', 'El Marqués', 'San Juan del Río', 'Corregidora', 'Tequisquiapan'],
  'Guanajuato': ['León', 'Irapuato', 'Celaya', 'Silao', 'San Miguel de Allende', 'Guanajuato', 'Dolores Hidalgo', 'Moroleón', 'San Francisco del Rincón', 'Pénjamo'],
  'San Luis Potosí': ['San Luis Potosí', 'Soledad de Graciano Sánchez', 'Matehuala', 'Ciudad Valles', 'Rioverde'],
  'Aguascalientes': ['Aguascalientes', 'Jesús María', 'Calvillo'],
  'Chihuahua': ['Chihuahua', 'Ciudad Juárez', 'Cd Juárez', 'Cd Juarez', 'Delicias', 'Hidalgo del Parral', 'Parral', 'Nuevo Casas Grandes', 'Camargo'],
  'Sonora': ['Hermosillo', 'Ciudad Obregón', 'Obregón', 'Nogales', 'Navojoa', 'Guaymas', 'San Luis Río Colorado', 'Caborca', 'Agua Prieta', 'Empalme'],
  'Sinaloa': ['Culiacán', 'Mazatlán', 'Los Mochis', 'Ahome', 'Guasave', 'Guamúchil', 'Navolato', 'El Fuerte'],
  'Baja California': ['Tijuana', 'Mexicali', 'Ensenada', 'Tecate', 'Rosarito', 'Playas de Rosarito'],
  'Baja California Sur': ['Cabo San Lucas', 'San José del Cabo', 'Los Cabos', 'Ciudad Constitución', 'Comondú', 'La Paz BCS'],
  'Veracruz': ['Veracruz', 'Xalapa', 'Jalapa', 'Coatzacoalcos', 'Córdoba', 'Orizaba', 'Poza Rica', 'Minatitlán', 'Boca del Río', 'Martínez de la Torre', 'San Andrés Tuxtla'],
  'Michoacán': ['Morelia', 'Uruapan', 'Zamora', 'Zitácuaro', 'Apatzingán', 'Pátzcuaro', 'La Piedad', 'Sahuayo'],
  'Guerrero': ['Acapulco', 'Chilpancingo', 'Iguala', 'Zihuatanejo', 'Taxco', 'Ixtapa'],
  'Oaxaca': ['Oaxaca', 'Salina Cruz', 'Juchitán', 'Tuxtepec', 'Huajuapan', 'Puerto Escondido', 'Huatulco'],
  'Chiapas': ['Tuxtla Gutiérrez', 'Tuxtla', 'Tapachula', 'San Cristóbal de las Casas', 'Comitán', 'Palenque', 'Villaflores'],
  'Tabasco': ['Villahermosa', 'Comalcalco', 'Macuspana', 'Paraíso', 'Huimanguillo', 'Centro Tabasco'],
  'Campeche': ['Campeche', 'Ciudad del Carmen', 'Champotón', 'Escárcega', 'Calkiní'],
  'Quintana Roo': ['Cancún', 'Chetumal', 'Playa del Carmen', 'Cozumel', 'Tulum', 'Solidaridad', 'Puerto Morelos', 'Felipe Carrillo Puerto'],
  'Hidalgo': ['Pachuca', 'Tulancingo', 'Tizayuca', 'Huejutla', 'Tepeji del Río', 'Actopan'],
  'Morelos': ['Cuernavaca', 'Jiutepec', 'Temixco', 'Yautepec', 'Emiliano Zapata Morelos'],
  'Nayarit': ['Tepic', 'Bahía de Banderas', 'Nuevo Vallarta', 'Ixtlán del Río', 'Santiago Ixcuintla'],
  'Colima': ['Colima', 'Manzanillo', 'Villa de Álvarez', 'Tecomán'],
  'Durango': ['Durango', 'Gómez Palacio', 'Lerdo', 'Victoria de Durango', 'Santiago Papasquiaro'],
  'Zacatecas': ['Zacatecas', 'Fresnillo', 'Jerez', 'Río Grande', 'Sombrerete'],
  'Tlaxcala': ['Tlaxcala', 'Apizaco', 'Huamantla', 'Chiautempan'],
};
const CITY = new Map();
const CITY_CANON = new Map();          // 접은 값 → 보여줄 표준 도시 이름
for (const [state, list] of Object.entries(CITY_TABLE)) {
  for (const c of list) {
    const clean = c.replace(/ (NL|CDMX|BCS|Yucatán|Morelos|Tabasco)$/, '').trim();
    const f = foldGeo(clean);
    if (!f) continue;
    if (!CITY_CANON.has(f)) CITY_CANON.set(f, clean);
    if (AMBIGUOUS_CITIES.has(f)) continue;
    if (CITY.has(f) && CITY.get(f) !== state) { CITY.set(f, null); continue; }  // 표 안에서 겹치면 무효
    CITY.set(f, state);
  }
}
// 흔한 약자 → 도시 표준 이름
for (const [a, full] of [['mty', 'Monterrey'], ['gdl', 'Guadalajara'], ['cd juarez', 'Ciudad Juárez'],
  ['cd victoria', 'Ciudad Victoria'], ['cd obregon', 'Ciudad Obregón'], ['slp', 'San Luis Potosí'],
  ['cd del carmen', 'Ciudad del Carmen'], ['cd madero', 'Ciudad Madero'], ['nuevo vallarta', 'Nuevo Vallarta']]) {
  CITY_CANON.set(foldGeo(a), full);
}
// 이름이 주와 같은 도시(Puebla, Querétaro…)는 주로 그대로 간다 — ALIAS 가 먼저 잡는다.

const NOISE = /^(mexico|mex|mx|republica mexicana|na|n a|no|ninguno|sin dato|s d|x)$/;

export function stateOf(text) {
  const f = foldGeo(text);
  if (!f || NOISE.test(f)) return null;
  if (ALIAS.has(f)) return ALIAS.get(f);
  if (CITY.get(f)) return CITY.get(f);
  // 「Monterrey, N.L.」 「Mérida Yucatán」 처럼 한 칸에 같이 적은 경우 — 조각을 뒤에서부터 본다
  const parts = f.split(' ').filter(Boolean);
  for (let len = Math.min(3, parts.length); len >= 1; len--) {
    for (let i = parts.length - len; i >= 0; i--) {
      const seg = parts.slice(i, i + len).join(' ');
      if (ALIAS.has(seg)) return ALIAS.get(seg);
    }
  }
  for (let len = Math.min(3, parts.length); len >= 1; len--) {
    for (let i = 0; i + len <= parts.length; i++) {
      const seg = parts.slice(i, i + len).join(' ');
      if (CITY.get(seg)) return CITY.get(seg);
    }
  }
  return null;
}

export function isAmbiguousCity(text) {
  const f = foldGeo(text);
  return !!f && (AMBIGUOUS_CITIES.has(f) || CITY.get(f) === null);
}

function titleCase(s) {
  return String(s || '').trim().replace(/\s+/g, ' ')
    .split(' ').map((w) => (w.length > 2 || /^[A-ZÁÉÍÓÚÑ]/.test(w) ? w.charAt(0).toUpperCase() + w.slice(1) : w)).join(' ')
    .slice(0, 80);
}

// 도시 칸에서 주 이름 꼬리를 떼어 도시만 남긴다: 「Monterrey, Nuevo León」 → 「Monterrey」
function cityOnly(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  const pieces = t.split(/[,/·|]+/).map((x) => x.trim()).filter(Boolean);
  const keep = pieces.filter((p) => !ALIAS.has(foldGeo(p)));
  const s = (keep.length ? keep[0] : pieces[0]) || '';
  const f = foldGeo(s);
  if (CITY_CANON.has(f)) return CITY_CANON.get(f);
  return titleCase(s);
}

/**
 * AI 가 읽은 지역을 표준 주로 맞춘다.
 * @param {{estado?:string, ciudad?:string}|string} input
 * @returns {{estado:string|null, ciudad:string|null, raw:string, matched:'estado'|'ciudad'|null, ambiguous:boolean}}
 */
export function normalizeGeo(input) {
  const o = (input && typeof input === 'object') ? input : { estado: input == null ? '' : String(input) };
  const eRaw = String(o.estado == null ? '' : o.estado).trim();
  const cRaw = String(o.ciudad == null ? '' : o.ciudad).trim();
  const raw = [cRaw, eRaw].filter(Boolean).join(', ').slice(0, 160);
  let estado = null; let matched = null;
  if (eRaw) { estado = stateOf(eRaw); if (estado) matched = 'estado'; }
  if (!estado && cRaw) { estado = stateOf(cRaw); if (estado) matched = 'ciudad'; }
  const ciudad = cityOnly(cRaw || (estado && foldGeo(eRaw) !== foldGeo(estado) ? eRaw : '')) || null;
  const ambiguous = !estado && !!(cRaw || eRaw) && (isAmbiguousCity(cRaw) || isAmbiguousCity(eRaw));
  // 도시 칸에 주 이름(또는 그 약자)만 적힌 경우는 도시로 치지 않는다: CDMX / Yuc. / N.L.
  const cityIsState = !ciudad || ALIAS.get(foldGeo(ciudad)) === estado || foldGeo(ciudad) === foldGeo(estado || '');
  return { estado, ciudad: cityIsState ? null : ciudad, raw, matched, ambiguous };
}
