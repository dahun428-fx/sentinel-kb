# eval/generation — 답변 품질 eval (specs/05 Eval 2, T-020)

```bash
pnpm eval:generation                        # 케이스 15건을 core-api에 던지고 리포트를 쓴다
pnpm eval:generation --allow-fixture-judge  # 판정 없이 파이프라인만 확인 (종료 코드 78)
pnpm eval:generation:check <report.json>    # 기존 리포트를 현재 기준선으로 다시 판정
```

## 무엇을 재는가

| 지표 | 출처 | 기준선 | 어떻게 재는가 |
|---|---|---|---|
| `citationRuleCheck` | specs/05 Eval 2(a) | **1.0 (100%)** | 답변의 주장 문장마다 유효한 `[REC-...#...]`이 있고 그 ID가 실제 컨텍스트에 있었는가 |
| `faithfulness` | specs/05 Eval 2(b) | 4.0 | LLM-as-judge 1–5 |
| `usefulness` | specs/05 Eval 2(b) | 3.5 | LLM-as-judge 1–5 |
| (진단) 임계값 시나리오 | specs/05 Eval 2(c) | — | 무관한 쿼리 5건이 전부 `found:false`인가 |

기준선은 `eval/baselines.json`의 `generation` 절이고 **이 태스크가 쓴 값이 아니다.**
하향도 상향도 사람이 결정한다(eval-runner 스킬).

## 인용 룰체크는 프로덕션 검증기를 그대로 쓴다

`verifyAnswerCitations`는 `packages/core/src/generator/citation.ts`의 함수이고,
`/v1/answer`의 생성 파이프라인이 **응답을 내보내기 전에** 부르는 바로 그 함수다.
eval이 자기 판정기를 따로 들면 둘이 갈라지는 순간 **eval은 초록인데 프로덕션이 새는**
상태가 만들어진다. 그래서 여기서는 재구현하지 않는다.

허용 인용 집합은 `AnswerResponse.citations`(= 컨텍스트에 실제로 들어간 청크)에서
`citationFor`로 되돌려 만든다. 형식을 여기서 다시 적지 않는 이유도 같다.

## 잴 수 없으면 재지 않는다 (exit 78)

셋이 모두 있어야 성립한다. 하나라도 없으면 **아무것도 재지 않고 78로 끝난다.**

1. **실 임베딩** — `EMBEDDING_PROVIDER=fake`면 거절한다. 해시 벡터는 서로 다른 텍스트 간
   cosine ≈ 0이라 grounded 케이스가 전부 임계값 게이트에 걸리고(시드 INC-18이 그 사건이다),
   그때의 `citationRuleCheck`는 "인용을 잘 붙였다"가 아니라 "잴 것이 없었다"이다.
   retrieval eval과 달리 **우회 플래그를 두지 않았다** — fake로 낸 generation 리포트는
   케이스 전부가 같은 한 갈래로 떨어져 진단 가치조차 없다.
2. **떠 있는 core-api + 시드된 DB** — 답변 경로가 없으면 잴 것이 없다.
3. **judge 모델** — `ANTHROPIC_API_KEY` + `EVAL_JUDGE_MODEL`(없으면 `ANTHROPIC_MODEL`).

`--allow-fixture-judge`는 파이프라인이 도는지만 본다. 그 리포트는 `judge.trusted:false`이고
회귀 판정을 하지 않으며 **종료 코드도 0이 아니라 78이다.**

종료 코드: `0` 통과 / `1` 기준선 하락(G4, 머지 금지) / `69` 호출 실패 / `78` 판정 불가.

## 케이스

`cases.json`에 15건 — grounded 10, irrelevant 5. **정답 답변은 없다.** 있으면 그것이 곧
프롬프트 튜닝의 표적이 되고 골든셋이 오염된다. 케이스 추가·수정은 별도 태스크로만 한다.

`kind: "irrelevant"` 다섯은 Eval 2(c)다. 같은 성질의 판정을 T-019가
`packages/api/src/answer.int.spec.ts`의 "무관한 쿼리 (Acceptance 2)"에서 이미 통과시켰지만,
그쪽은 **fake 임베딩 위에서 게이트 배선이 살아 있는가**를 재고 이쪽은 **실 임베딩·실 코퍼스
위에서 의미적으로 무관한 질의가 실제로 임계값에 걸리는가**를 잰다. 후자는 그 통합 테스트가
스스로 "판정하지 못한다"고 밝힌 부분이다.

## 리포트

`eval/reports/{date}-generation.json`으로 쓰고 커밋한다 — 시계열이 곧 포트폴리오 자산이다.
**답변 본문은 리포트에 들어가지 않는다**(길이·판정·위반 건수만). 커밋되는 파일에 답변
전문을 실으면 파일이 부풀고, 질의에 섞인 텍스트가 리포트 경유로 샌다.
