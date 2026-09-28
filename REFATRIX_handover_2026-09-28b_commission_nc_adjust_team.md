# REFATRIX 인수인계 — 커미션: 크레딧 노트 순액 · 지급 후 차액 정산 · 팀 커미션 수혜자

- 작업일: 2026-09-28
- 마이그레이션: **0232**(지급 시점 순매출 스냅샷) · **0233**(팀 커미션 수혜자, 06_Tele → Maria 시드)
- nav.js 변경 없음 → 다른 HTML 토큰 변경 불필요. 화면 빌드 마커 `b0928adj`
- 산출물: `refatrix_commission_0928b.zip` — 같은 날 핫픽스(고객마스터 담당자 기준, `refatrix_commission_owner_0928.zip`)를 **포함한 누적본**. 앞 zip 을 아직 안 올렸으면 이것만 올리면 된다.
- 검증: 종단(실 PG16, 0001~0233 클린 적용) 신규 15 + 담당자·팀 9 + 성과급 12 / 순수 31 / 매출총이익 9 = **전부 통과**. 매출·고객·견적 관련 기존 테스트 전후 동일(기존 실패 2종은 변경 전과 같음). **마이그레이션 전 배포 시 500 없음** 확인.

---

## ① 크레딧 노트(NC) 반영

NC 는 인보이스 금액을 바꾸지 않고 비현금 반제로만 들어간다(0085). 그래서 지금까지:

- 매출 기준 사원: **할인·반품분에도 커미션이 붙었다.**
- 수금 기준 사원: NC 분은 현금 수금이 아니라서 인보이스가 **영영 완납으로 안 잡혀 커미션이 확정되지 않았다.**

이제 **커미션·성과급·매출총이익의 커미션 비용 모두 「인보이스 − 적용 NC」 순액 기준**.

- 기준액 = 인보이스 ex-IVA − 적용 NC ex-IVA (`status='applied'` 만, `void` 는 제외)
- 수금 기준 완납 = **현금 수금 ≥ 인보이스 합계 − NC 합계**
- 성과급 수금 실적에는 현금만 들어간다.
- 커미션 내역의 매출 칸에 `NC −금액 차감` 표시.

운영 점검(2026-09-28): 적용된 NC 는 1건(#10, C-0049 oscar, 8월 인보이스, 반품) — oscar 커미션 시작일(10-01) 이전이라 영향 없음.

## ② 지급 후 매출이 바뀌면 다음 지급에서 차액 정산 (디렉터 결정 A)

| 지급 후 변화 | 결과 |
|---|---|
| 매출 삭제 | 지급한 커미션 **전액 차감** |
| NC 적용 / 금액 수정으로 감소 | 줄어든 만큼 **차감** |
| NC 취소 / 금액 수정으로 증가 | 늘어난 만큼 **추가 지급** |
| 요율·기간 설정 변경 | **차액 없음** (지급 당시 율 고정) |

- 차액 = 지급 당시 실효율(지급액 ÷ 지급 시점 순매출) × (현재 순매출 − 지급 시점 순매출). 지급 시점 순매출은 0232 `commission_payouts.base_mxn` 에 저장.
- 지급 패널: 이번 달 커미션·성과급 아래 **「지급 후 매출 조정 N건」 표**가 나오고 기본 지급액에 반영된다. 지급 등록 한 번에 함께 정산 → 같은 차액은 다시 안 잡힌다.
- **차감이 이번 달 지급 대상보다 크면 지급 불가**(다음 지급으로 이월). 지급액을 너무 작게 넣어 차감만 먼저 빠지는 등록도 거부.
- 영업사원 본인 화면에도 「지급 후 매출 조정 — 다음 지급에서 정산」 카드가 보인다.
- **디렉터 직접 매출 삭제 가드 해제**: 커미션이 지급된 매출도 삭제 가능(차감으로 처리). 수금이 잡힌 매출 삭제 불가는 그대로.
- 운영 점검: 지금까지 커미션 지급 전표 0건 → 소급 대상 없음. (0232 는 기존 지급분이 있어도 현재 순매출로 백필)

## ③ 팀 커미션 수혜자 — 06_Tele 고객 매출 → Maria

- 규칙: 고객의 팀에 수혜자가 지정돼 있으면 **그 사람**, 없으면 **고객마스터 담당자**. 이미 지급된 커미션은 지급받은 사람으로 동결.
- 0233 이 `06_Tele` → `Maria` 로 시드한다(이름 일치, 이미 지정된 값은 덮어쓰지 않음).
- 화면: **커미션 설정** 창 맨 위 「팀 커미션 수혜자」 — 팀별로 고객 수와 수혜자 드롭다운. 디렉터만 변경, 바꾸는 즉시 저장.
- 운영 점검: 06_Tele(팀 id 9) 소속 고객은 아직 **0명**. Maria 는 커미션 대상(2026-09-28~ 수금 4%). → 고객을 06_Tele 팀으로 등록하면 그 매출부터 Maria 에게 잡힌다.

## ④ 배포 — 순서

| 파일 | 위치 | 구분 |
|---|---|---|
| `commissionRoutes.js` · `commissionBonus.js` · `grossProfitRoutes.js` · `salesRoutes.js` | `refatrix-api/src/routes/` | 덮어쓰기 |
| `0232_commission_payout_base.sql` · `0233_team_commission_beneficiary.sql` | `refatrix-api/migrations/` | 신규 |
| `refatrix-commission.html` | 레포 루트 | 덮어쓰기 |
| `commission_nc_adjust.test.mjs` · `commission_customer_owner_e2e.test.mjs` · `commission_bonus_e2e.test.mjs` | `refatrix-api/test/` | (선택) 검증용 |

1. GitHub Desktop **Fetch/Pull** → zip 을 레포 루트에서 풀기 → **Commit → Push** → Railway **Success**.
2. **🔴 Railway APP 콘솔 `npm run migrate`** → `apply 0232…`, `apply 0233…` 확인.
   - migrate 전에도 커미션 화면은 정상(500 없음). 차액 정산은 꺼져 있고, 팀 수혜자 지정은 "migrate(0233) 필요" 안내로 잠긴다.
3. 커미션 화면 **Ctrl+Shift+R** → 상단 `build b0928adj`.

```bash
R=https://raw.githubusercontent.com/sebastianham26-art/Refatrix/main; N="?nc=$(date +%s)"
curl -s "$R/refatrix-api/src/routes/commissionRoutes.js$N" | grep -c "pendingAdjustments"          # >0
curl -s "$R/refatrix-api/src/routes/commissionRoutes.js$N" | grep -c "commission_user_id"          # >0
curl -s -o /dev/null -w "%{http_code}\n" "$R/refatrix-api/migrations/0233_team_commission_beneficiary.sql$N"  # 200
curl -s "$R/refatrix-commission.html$N" | grep -c "b0928adj"                                        # >0
```

## ⑤ 운영 확인 (5분)

1. 커미션 → **palomino** → 9월 4건(매출 3% ≈ $732) · **Armando** → Maria 가 등록한 2건 포함.
2. **커미션 설정** → 맨 위 「팀 커미션 수혜자」에서 `06_Tele = Maria` 확인.
3. 고객 1곳을 06_Tele 팀으로 옮기고 그 고객 매출이 **Maria** 로 보이는지(고객 담당자 목록에서는 빠짐). 확인 후 필요하면 되돌림.
4. (NC 가 생기면) 해당 인보이스 매출 칸에 `NC −… 차감` 표시.

## ⑥ 참고

- 이미 **확정·스냅샷된 성과급(Bono)** 은 이후 NC·삭제로 재계산하지 않는다(종전과 동일). 필요하면 후속.
- 팀 수혜자는 **팀 단위**다. 06_Tele 안에서 Clarisa 등과 나눠야 하면 고객별 수혜자 또는 분배율이 필요 — 후속 과제.
- 월 확정 합계(배치)는 차액을 포함하지 않는다. 차액은 지급 패널에서 사원별로 정산된다.
