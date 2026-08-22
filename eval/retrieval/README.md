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
