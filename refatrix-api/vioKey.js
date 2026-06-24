// 멕시코 VIO(등록대수) 순위 매칭용 모델 키 정규화기.
// 적용차종(maker, model)과 VIO 모델명을 동일 규칙으로 정규화해 같은 키를 만든다.
// product_applications.model_key(저장) ↔ vio_models.model_key(시드)가 이 함수로 일치해야 한다.
// 이 파일을 바꾸면 /api/products/resync-derived 를 한 번 실행해 model_key를 재생성해야 한다.

// 악센트 제거 (Á→A, ñ→N 등)
function stripAccents(s) {
  return String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

// 메이커 동의어 → VIO Marca 표준명.
// VIO 파일은 Aveo·Spark·Beat·Chevy를 'General Motors'로 분류하므로 CHEVROLET→GENERAL MOTORS 매핑이 필수.
const MAKER_SYN = {
  CHEVROLET: 'GENERAL MOTORS', CHEVY: 'GENERAL MOTORS', GM: 'GENERAL MOTORS', GMC: 'GENERAL MOTORS',
  GENERALMOTORS: 'GENERAL MOTORS', 'GENERAL MOTORS': 'GENERAL MOTORS', BUICK: 'GENERAL MOTORS', CADILLAC: 'GENERAL MOTORS',
  VW: 'VOLKSWAGEN', VOLKSWAGEN: 'VOLKSWAGEN',
  MERCEDES: 'MERCEDES BENZ', MERCEDESBENZ: 'MERCEDES BENZ', MB: 'MERCEDES BENZ', 'MERCEDES BENZ': 'MERCEDES BENZ',
  FORD: 'FORD MOTOR', 'FORD MOTOR': 'FORD MOTOR',
  MITSUBISHI: 'MITSUBISHI', 'MITSUBISHI MOTORS': 'MITSUBISHI',
  DODGE: 'CHRYSLER', RAM: 'CHRYSLER', CHRYSLER: 'CHRYSLER', JEEP: 'CHRYSLER', FIAT: 'FIAT',
};

export function normMaker(m) {
  if (!m) return '';
  let k = stripAccents(m).toUpperCase().trim();
  k = k.replace(/[^A-Z& ]/g, ' ').replace(/\s+/g, ' ').trim();
  if (MAKER_SYN[k]) return MAKER_SYN[k];
  const noSpace = k.replace(/ /g, '');
  if (MAKER_SYN[noSpace]) return MAKER_SYN[noSpace];
  return k;
}

// 순수 차체형식 단어(숫자 없음) — 모델 키에서 제거. 같은 차종의 바디/도어 변형을 한 순위로 통합.
const BODY = new Set(['SEDAN', 'HATCHBACK', 'HB', 'HATCH', 'COUPE', 'SUV', 'UUV', 'VAN', 'PICKUP', 'PICK', 'UP',
  'SW', 'WAGON', 'DC', 'CD', 'DOBLE', 'SENCILLA', 'CABINA', 'REGULAR', 'CHASSIS', 'CHASIS', 'SPORT', 'CARGO',
  'NG', 'PTS', 'PTAS', 'PTA', 'PUERTAS', 'PUERTA', 'CREW', 'CAB', 'SUPER', 'EXT', 'EXTENDIDA', 'PASAJEROS', 'PAS']);
// 도어수 패턴("4 PTAS", "2 Ptas", "5P" 등)만 제거. 그 외 숫자(Mazda 2, CX-3, I10, 508)는 모델 식별자이므로 보존.
const DOOR_RE = /\b\d+\s*(?:PTS|PTAS|PTA|PUERTAS?|P)\b/g;

export function normModel(model, makerCanon) {
  let s = stripAccents(model == null ? '' : model).toUpperCase()
    .replace(/-/g, ' ').replace(/\//g, ' ').replace(/\./g, ' ');
  s = s.replace(DOOR_RE, ' ').replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  let toks = s ? s.split(' ') : [];
  const mk = (makerCanon || '').split(' ').filter(Boolean);
  // 모델 앞에 브랜드명이 중복되면 제거 (VIO "KIA Río Sedan" → "RIO")
  while (toks.length && mk.length && toks[0] === mk[0]) toks = toks.slice(1);
  const kept = toks.filter((t) => !BODY.has(t));
  let key = kept.join('');
  if (!key) key = toks.join(''); // 차체형식만 남는 경우 원형 토큰 유지(빈 키 방지)
  return key;
}

// (maker, model) → "MAKER_CANON|MODELKEY"
export function vioKey(maker, model) {
  const mc = normMaker(maker);
  return mc + '|' + normModel(model, mc);
}

// 보조(폴백) 매칭키: 카탈로그가 세대/플랫폼 코드를 덧붙인 경우 대비.
// 모델이 복수 토큰이고 선두 토큰이 순수 알파벳 4자 이상일 때만 "MAKER|선두토큰" 생성.
// (예: "JETTA A4" → "VOLKSWAGEN|JETTA", "GOLF A4" → "VOLKSWAGEN|GOLF")
// 2~3자 약어(CX, RAV, S10 등)는 오매칭 위험이 있어 제외 → null.
export function vioStem(maker, model) {
  const mc = normMaker(maker);
  let s = stripAccents(model == null ? '' : model).toUpperCase()
    .replace(/-/g, ' ').replace(/\//g, ' ').replace(/\./g, ' ');
  s = s.replace(DOOR_RE, ' ').replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  let toks = s ? s.split(' ') : [];
  const mk = mc.split(' ').filter(Boolean);
  while (toks.length && mk.length && toks[0] === mk[0]) toks = toks.slice(1);
  const kept = toks.filter((t) => !BODY.has(t));
  if (kept.length < 2) return null;            // 단일 토큰 모델은 exact로 충분
  const head = kept[0];
  if (!/^[A-Z]{4,}$/.test(head)) return null;   // 순수 알파벳 4자 이상만
  return mc + '|' + head;
}

export default { normMaker, normModel, vioKey, vioStem };
