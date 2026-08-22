# retrieval eval 러너 (T-013)

specs/05 "Eval 1: Retrieval" 구현. **골든셋 데이터는 아직 없다** — 아래 `## 자격증명이 생겼을 때`를 읽어라.

## 무엇이 있나

| 파일 | 역할 |
|---|---|
| `golden-set.ts` | `eval_cases`에서 **승인된**(`approvedBy:"human"`) 케이스만 읽는 로더 |
| `query-kind.ts` | 질의를 한국어 서술형 / 식별자로 분류 (T-010 F-6 분해 집계용) |
| `metrics.ts` | record 단위 랭킹 → Recall@5, MRR, 동점 모호성 탐지 |
| `search-client.ts` | `POST /v1/search` 호출 (라이브러리가 아니라 **HTTP 경로**를 잰다) |
| `run.ts` | 케이스 × 검색 → `RetrievalReport` |
| `report.ts` | 리포트 zod 스키마 + `eval/reports/YYYY-MM-DD-retrieval.json` 규약 |
| `baselines.ts` | `eval/baselines.json` **읽기 전용** (쓰기 경로가 없다) |
| `baseline-guard.ts` | 기준선 대조 → 종료 코드 0 / 1 / 78 |
| `run.cli.ts` | `pnpm eval:retrieval` |
| `check-baseline.cli.ts` | `pnpm eval:retrieval:check <report>` — 가드만 단독 실행 |

## 종료 코드

| 코드 | 뜻 |
|---|---|
| 0 | 판정했고 기준선 이상 |
| 1 | **기준선 하락** — specs/05 G4, 머지 금지 |
| 69 | EX_UNAVAILABLE — DB·core-api에 닿지 못함 |
| 78 | EX_CONFIG — **잴 수 없음**(fake 임베딩, 케이스 0건, 인자·env 오설정, 리포트 손상) |

78과 0을 가른 것이 요점이다. "판정 불가"를 0으로 끝내면 자격증명 없이 돌린 CI가 통과로 읽힌다.

## 지금 상태 (2026-08-23)

- `Recall@5 >= 0.8`은 **측정 불가**다. `EMBEDDING_PROVIDER=fake`면 러너가 78로 거절한다.
  해시 벡터는 서로 다른 텍스트 간 cosine ≈ 0이고(T-006 F-8, 실측 −0.00007), T-012 검증이
  그 귀결을 실증했다 — 벡터 경로를 융합에서 제거해도 통합 테스트 11개가 전부 통과했다.
  지금 재면 검색 품질이 아니라 **BM25 단독 성능**이 나온다.
- **골든셋 30건은 만들지 않았다.** `scripts/seed.ts`가 `POST /v1/records`로 시드를 넣어
  `--reset`마다 ObjectId가 새로 발급되므로, 지금 만든 `expectedRecordIds`는 다음 리셋에 통째로 죽는다.
- `eval/baselines.json`은 **건드리지 않았다.** 측정하지 않은 숫자를 기준선으로 쓰지 않는다.

## 자격증명이 생겼을 때 — 무엇을 하면 되나

1. **`seedBatch` 마커를 결정한다 (G3, 인간 승인).**
   `RecordSchema`가 `.strict()`라 contracts 재개방이다. 이게 먼저다 — 골든셋을 만든 뒤에
   결정하면 30건을 다시 매핑해야 한다. 같은 변경이 T-009 F-6, T-024도 함께 해소한다.
2. **자격증명을 주입한다.** `EMBEDDING_PROVIDER=voyage`, `VOYAGE_API_KEY=…`(.env.example 참조).
3. **실제 임베딩으로 시드를 적재한다.** `pnpm db:indexes && pnpm db:search-indexes && pnpm db:seed`
   (`--allow-fake-embeddings` 없이. 시드 CLI가 fake를 이미 거절한다.)
4. **골든셋 30건을 `eval_cases`에 넣는다.** 각 문서는 `approvedBy:"human"`이어야 한다.
   - T-009 실측: 고유 태그 263개, 1회만 등장하는 태그 221개(84%). **그 221개에서 뽑으면
     무모호 케이스만으로 30건을 채울 수 있다.**
   - 모호 클러스터(BGP 전역 장애 PUB-08·13·14·11 / Mongo "연결 안 됨" INC-04·05·07 /
     파괴적 스크립트 PUB-02·03·18·10 / 임계값 무음 INC-18·SELF-01)를 쓸 거라면
     **클러스터 전원을 `expectedRecordIds`에 열거하라.** 지표는 "그중 하나라도 top-5"로 센다.
   - **한국어 서술형과 식별자를 둘 다 넣어라.** 한쪽만 넣으면 러너가 경고를 낸다 —
     분해 집계가 무의미해지고 `lucene.standard` 교체 판단의 근거가 안 된다.
5. **`pnpm dev`로 core-api를 띄우고 `pnpm eval:retrieval`을 돌린다.**
   리포트가 `eval/reports/YYYY-MM-DD-retrieval.json`에 떨어지고 **커밋한다**.
6. **기준선을 확정한다 — 사람이.** 첫 리포트의 수치를 보고 `eval/baselines.json`의
   `retrieval`을 유지할지 조정할지 결정한다. 에이전트는 리포트만 낸다(eval-runner 스킬).

## 관계 확장 on/off 비교 (T-035, specs/03 §2.5 / ADR-07 §5)

> specs/03 §2.5: "on/off 플래그로 두고 eval에서 효과를 비교한다 — **지표가 오르지 않으면
> 확장하지 않는다.**" ADR-07 §5: "확장이 지표를 올리지 못하면 단계 1로 가지 않는다."

### ⚠️ 지금 이 비교는 **판정 불가**다 — 재지 않았다

관계 확장(`RELATION_EXPANSION`)의 **기본값은 `off`**이고, 그 이유는 "효과가 없다고 판정했기
때문"이 **아니라 "잴 수 없어서 판정하지 못했기 때문"**이다. 위 `## 지금 상태`와 같은 원인이다:

- `EMBEDDING_PROVIDER=fake`면 러너가 78로 거절한다. 해시 벡터로는 검색 품질이 아니라 BM25
  단독 성능이 측정된다 — 그 위에서 잰 on/off 차이는 **확장의 효과가 아니라 잡음**이다.
- 골든셋 30건이 아직 없다. 분모가 없으면 Recall@5의 차이를 계산할 수 없다.

**그러므로 "관계 확장이 검색 품질을 올린다/내린다"는 어느 쪽 주장도 이 레포에 아직 근거가
없다.** 기본값을 `on`으로 바꾸는 커밋은 아래 절차로 낸 **두 리포트를 근거로 첨부해야 한다.**

### 자격증명이 생겼을 때 — 비교 절차

위 `## 자격증명이 생겼을 때` 1–4단계(시드 + 골든셋)를 **먼저** 끝낸 상태를 전제한다.
확장은 `retriever`가 하므로 플래그는 eval CLI가 아니라 **core-api 프로세스의 env**에 준다.

```bash
# 1) off 기준선
RELATION_EXPANSION=off pnpm dev            # core-api 재기동 (env는 프로세스 시작 시 읽힌다)
pnpm eval:retrieval                        # → eval/reports/YYYY-MM-DD-retrieval.json
mv eval/reports/YYYY-MM-DD-retrieval.json \
   eval/reports/YYYY-MM-DD-retrieval-relations-off.json

# 2) on 비교군 — 골든셋·시드·임베딩 세대는 **그대로 두고** 플래그만 바꾼다
RELATION_EXPANSION=on pnpm dev
pnpm eval:retrieval
mv eval/reports/YYYY-MM-DD-retrieval.json \
   eval/reports/YYYY-MM-DD-retrieval-relations-on.json

# 3) 두 리포트를 같은 가드로 각각 판정하고 수치를 나란히 읽는다
pnpm eval:retrieval:check eval/reports/YYYY-MM-DD-retrieval-relations-off.json
pnpm eval:retrieval:check eval/reports/YYYY-MM-DD-retrieval-relations-on.json
```

> **파일명을 바꾸는 단계를 빼지 마라.** 리포트 경로는 `YYYY-MM-DD-retrieval.json`이라
> 같은 날 두 번 돌리면 **두 번째가 첫 번째를 덮어쓴다.** 비교군이 사라진 채로 "on이 이랬다"만
> 남으면 그건 비교가 아니다.

generation eval도 같은 방식이다(`pnpm eval:generation`, `eval/reports/*-generation.json`).
`suggest_resolution`은 `/v1/answer`를 부르고 그 안의 retriever가 같은 플래그를 읽으므로,
core-api를 어느 쪽으로 띄웠는지가 곧 실험군/대조군이다.

### 무엇을 보고 판단하나

| 지표 | 어디 | 확장이 **효과 있다**면 |
|---|---|---|
| `Recall@5` | retrieval 리포트 | 오른다 (관계 대상 레코드가 top-5에 들어온다) |
| `MRR` | retrieval 리포트 | 최소한 내려가지 않는다 |
| `byQueryKind.korean-prose` | retrieval 리포트 | 여기서 특히 오를 것으로 기대된다 — 텍스트 경로가 약한 쪽을 관계가 메운다는 것이 ADR-07 G2의 가설이다 |
| 인용 grounding 위반율 | generation 리포트 | **늘지 않아야 한다.** 늘면 확장이 근거를 흐린 것이다 |
| 응답 토큰 | 아래 NFR-03 항목 | 800 상한은 지켜지되 **답변 산문이 줄어든다** |

**주의: 확장은 검색 결과를 최대 3건 늘린다.** 골든셋의 `expectedRecordIds`가 관계 대상
레코드를 포함하지 않으면, 확장은 Recall을 올리지 못한 채 **정밀도만 떨어뜨린 것처럼 보인다.**
비교 전에 골든셋에 재발 사슬(`recurrence_of`) 케이스가 실제로 들어 있는지 확인하라 —
없으면 이 실험은 "효과 없음"이 아니라 **또 한 번의 판정 불가**다.

### NFR-03 예산 실측 (T-035, 이 레포에서 잰 값)

확장은 `suggest_resolution` 응답의 **인용 건수를 최대 +3** 늘린다. 인용 머리줄은 산문 예산과
무관하게 항상 나가므로(`renderAnswer`), 늘어난 고정비만큼 **답변 산문 예산이 줄어든다.**

| finalK | 확장 | 인용 수 | 고정비(토큰) | 산문 예산 | 실제 출력 | 800 초과 |
|---|---|---|---|---|---|---|
| 5 | off | 5 | 153 | 647 | 800 | 아니오 |
| 5 | on | 8 | 248 | 552 | 796 | 아니오 |
| 8 | off | 8 | 248 | 552 | 796 | 아니오 |
| 8 | on | 11 | 343 | 457 | 768 | 아니오 |

**상한은 어떤 조합에서도 넘지 않는다**(`renderAnswer`의 하드 클램프). 대신 대가가 있다:
인용 3건당 산문 예산이 **95토큰 줄고**, 그 경계에서 실제로 답변이 잘린다 — 짧은 답변(요구량
72토큰)이 finalK=8·off에서는 온전히 나가지만 **on에서는 절단됐다.**
즉 "예산이 넘치면 확장이 아니라 축소가 일어난다"는 설계 요구는 **충족되지만, 축소되는 것이
확장 청크가 아니라 답변 본문**이다. 이 교환이 남는 장사인지는 위 비교 리포트가 판정한다.

생성 컨텍스트(LLM 프롬프트)는 NFR-03의 대상이 아니지만 비용이다: 같은 픽스처에서
finalK=5는 **+42~67%**, finalK=8은 **+43%** 커졌다(`estimateTokens` low..high 기준).

## 그다음에 재야 할 것 (인계된 Findings)

- **`byQueryKind`의 korean-prose vs identifier 격차.** 이 수치가 `specs/02`의 분석기를
  `lucene.cjk`/nori로 바꿀지 판단하는 근거다. T-011은 스펙을 고치지 않고
  "텍스트 경로가 한국어 서술형에 약하다"를 전제로 설계했다 — 그 전제를 여기서 처음 수치화한다.
- **`SIMILARITY_THRESHOLD=0.62`의 근거** (T-011 F-2). 무관 질의 5개가 전부 `found:false`가 되는
  (specs/05 Eval 2-c) 최소 임계값과 Recall@5를 깎지 않는 최대 임계값 사이를 재라.
  `POST /v1/search` 로그의 `maxVectorScore`(원시 cosine)가 실측 분포의 원천이다.
- **`RETRIEVAL_CANDIDATE_OVERFETCH` · `RETRIEVAL_MAX_CHUNKS_PER_RECORD` 스윕** (T-011 G5).
  후보 단계 상한이 경로 간 순위 역전이 있을 때 융합 점수를 바꾼다. `--limit`으로 최종 K를,
  env로 두 파라미터를 흔들며 같은 골든셋을 재라.
- **`CHUNK_MAX_CHARS` 스윕은 기준선 재수립을 부른다** (T-005 F-8). 청크 경계 → 임베딩 → 랭킹이
  전부 바뀐다. CLAUDE.md의 "기준선을 낮추는 커밋 금지"와 충돌할 수 있으니 별도 태스크로 하고
  갱신 절차를 스펙에 명시하라.
- **`ambiguousTieCount`가 0이 아니면 그 골든셋으로는 기준선을 만들지 마라.** atlas-local은
  같은 점수 후보의 순서를 보장하지 않는다(T-011 F-9). 흔들리는 케이스를 무모호 케이스로 교체하라.
