// 영업단계 이름 한국어 → 스페인어 병기 (2026-08-25)
//
// 배경: 화면은 크롬 자동번역(스페인어)으로 쓰는데, 영업단계 이름은 DB 값(`01_잠재` 등)이라
//   번호 접두어와 붙어 있어 번역기가 코드 문자열로 보고 건너뛴다. 그래서 영업사원 화면에
//   한국어 그대로 남아 있었다.
// 방침(디렉터 확정): DB 값은 그대로 두고 **표시할 때만** 스페인어를 괄호로 병기한다.
//   `01_잠재` → `01_잠재 (Potencial)`
//   - 디렉터는 한국어로 그대로 읽고, 영업사원은 괄호 안 용어를 본다.
//   - 자동번역 결과에 의존하지 않으므로 번역이 흔들리지 않는다.
//   - DB를 안 바꾸므로 마이그레이션이 없고, 단계 id 기반 로직·색상(번호 접두어)도 그대로 동작한다.
//
// 용어는 디렉터가 정의한 의미에 맞춘 것:
//   잠재   연락만 발송한 상태            → Potencial
//   접촉   고객과 교신에 성공            → Contacto
//   견적   고객에게 견적서 발송          → Cotización
//   협상   조건 협상 중                  → Negociación
//   수주   주문(견적요청)을 받음         → Pedido
//   거래중 견적이 컨펌되어 거래 진행 중  → En operación

const ES = {
  '미지정': 'Sin definir',
  '잠재': 'Potencial',
  '접촉': 'Contacto',
  '견적': 'Cotización',
  '협상': 'Negociación',
  '수주': 'Pedido',
  '거래중': 'En operación',
};

// 표시용 라벨. 매칭되는 용어가 없으면 원래 이름을 그대로 돌려준다(임의로 만든 단계도 안전).
export function stageLabel(name) {
  if (name == null || name === '') return name;
  const raw = String(name);
  if (raw.includes('(')) return raw;                 // 이미 병기된 값 → 두 번 붙이지 않음
  const core = raw.replace(/^\d+_/, '').trim();      // 번호 접두어 제거 후 매칭
  const es = ES[core];
  return es ? `${raw} (${es})` : raw;
}

// 병기 라벨을 원래 DB 이름으로 되돌린다.
//   엑셀 업로드에서 사용자가 화면에 보이는 `01_잠재 (Potencial)` 를 그대로 붙여넣어도
//   단계 매칭이 깨지지 않게 하기 위한 안전장치.
export function stripStageLabel(name) {
  if (name == null) return name;
  return String(name).replace(/\s*\([^()]*\)\s*$/, '').trim();
}
