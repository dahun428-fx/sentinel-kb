# T-013: retrieval eval 러너 + 골든셋 30
refs: specs/05-test-strategy.md (Eval 1)
M: M2 | deps: T-012, T-009

STATUS: BLOCKED
사유: 실제 임베딩 provider 자격증명이 없어 Acceptance 1(`Recall@5 >= 0.8`)을 **측정 자체가 불가능**하다.
실패 로그:
  - `FakeEmbedder`는 해시 기반이라 서로 다른 텍스트 간 cosine ≈ 0이다(T-006 F-8, 실측 mean −0.00007).
  - T-012 검증자가 그 귀결을 실증했다: 벡터 경로를 융합에서 제거해도 통합 테스트 11개가 전부 통과하고,
    응답 19건 중 `vectorRank`·`textRank`가 동시에 non-null인 hit이 **0건**이다(RRF가 교대 배치로 퇴화).
  - 즉 지금 골든셋을 만들어 재면 지표가 검색 품질이 아니라 BM25 단독 성능을 잰다.
필요한 결정: **임베딩 provider 자격증명 주입**(`EMBEDDING_PROVIDER`+API 키). 
  `specs/05`가 "실제 모델 호출은 eval 계층에서만"으로 이미 경계를 그어 뒀고, 이 태스크가 그 경계다.
  더불어 아래 `## ⚠️ 착수 전 결정 필요`의 `seedBatch` 마커도 함께 결정해야 한다 —
  그것 없이 골든셋 30건을 만들면 `--reset` 한 번에 통째로 무효화된다.

**M2의 나머지(T-010·T-011·T-012)는 자격증명 없이 전부 완료됐다.**
`mongodb-atlas-local` 컨테이너가 `$vectorSearch`·`$search`를 지원해 인덱스·검색·라우트는 로컬에서
판정 가능하다(specs/05 정정분). 경계는 "Atlas 유무"가 아니라 **"의미 있는 임베딩 유무"**이고,
이 태스크가 그 경계 바깥에 있는 유일한 M2 태스크다.

## Scope
- `eval/retrieval/`: 골든셋 로더(eval_cases) → /v1/search 호출 → Recall@5, MRR 계산
- 리포트 `eval/reports/{date}-retrieval.json` + 콘솔 요약
- `pnpm eval:retrieval`, 기준선 파일 `eval/baselines.json`과 비교해 하락 시 exit 1
- 골든셋 30건 작성 (시드에서 파생, 각 케이스 `approvedBy: "human"`)

## Out of scope
- generation eval

## Acceptance
- [ ] Recall@5 >= 0.8 (M2 기준선)
- [ ] 기준선보다 낮으면 exit 1 하는 회귀 가드 동작 테스트
- [ ] 리포트 JSON이 specs/05의 스키마와 일치
- [ ] `pnpm verify` 그린

## Context budget
- 읽기: specs/05, eval/**, packages/api/**

## Findings (T-006에서 미리 넘김)

- **`FakeEmbedder`로는 Recall@5·MRR을 측정할 수 없다.** 해시 벡터에는 의미 유사도가 없어
  골든셋 쿼리가 정답 record를 끌어올 확률이 무작위다. 지표가 측정 자체를 못 한다.
  specs/05대로 **실제 모델 호출은 eval 계층에서만** — 이 태스크가 그 경계다.
- **`CHUNK_MAX_CHARS`를 스윕하면 기준선을 재수립해야 한다**(T-005 F-8).
  청크 경계→임베딩→랭킹이 전부 바뀐다. CLAUDE.md의 "eval 기준선을 낮추는 커밋 금지"와
  충돌할 수 있으므로 스윕 시 갱신 절차를 명시할 것.

## ⚠️ 착수 전 결정 필요 (T-009 G5 지적)

**골든셋이 `--reset` 한 번에 통째로 무효화된다.**
`specs/05:20`·`specs/02`가 골든셋을 `expectedRecordIds: ObjectId[]`로 규정하는데,
`scripts/seed.ts`가 `POST /v1/records`로 시드를 넣으므로 **`--reset`을 돌릴 때마다
전 레코드의 ObjectId가 새로 발급된다.** 골든셋 30건을 만든 뒤 시드를 다시 넣으면 전부 죽는다.

해소 수단은 하나뿐이다 — **`RecordSchema`에 안정적 시드 마커(`seedBatch`) 추가**.
같은 변경이 T-009 F-6(`--reset`이 동명 사용자 레코드를 지움)과
T-024(시드 divergence와 실제 도그푸딩 기록을 구분 못 함)도 함께 해소한다.
`.strict()`라 **contracts 재개방 = G3 인간 승인**이 필요하다.

**골든셋을 만들기 전에 결정하라.** 만든 뒤에 결정하면 30건을 다시 매핑해야 한다.

## 시드 다양성 (T-009 실측 — 이 태스크에 유리한 조건)
고유 태그 **263개**, 1회만 등장하는 태그 **221개(84%)**,
태그 Jaccard ≥ 0.2인 쌍이 1225쌍 중 **6쌍**(최대 0.33).
**221개 단일 태그 주제에서 30건을 뽑으면 무모호 케이스만으로 채울 수 있다.**

모호 위험이 있는 클러스터는 소수다 — BGP 전역 장애(PUB-08·13·14·11),
Mongo "연결 안 됨"(INC-04·05·07), 파괴적 스크립트(PUB-02·03·18·10),
임계값 무음(INC-18·SELF-01). `expectedRecordIds`가 배열이므로 클러스터 전원을 열거하면 해소된다.

## Findings (T-010·T-011에서 넘김)

- **⚠️ `lucene.standard`는 한국어 형태소 분석을 하지 않는다 (T-010 F-6).**
  "스트리밍이"가 한 토큰이라 질의 "스트리밍"으로 매칭되지 않는다. 영문·식별자
  (`nginx`, `proxy_buffering`, 스택트레이스)는 잘 걸린다.
  **이 태스크가 그 손실을 처음 수치로 측정하는 지점이다.** `specs/02`의 분석기를 바꾸는 결정
  (`lucene.cjk` / nori)은 여기서 나온 수치를 근거로 해야 한다 — 그래서 T-011은 스펙을 고치지 않고
  "텍스트 경로가 한국어 서술형에 약하다"를 전제로 설계했다.
  → **골든셋을 짤 때 한국어 서술형 질의와 식별자 질의를 구분해 집계하라.** 섞어서 하나의
    Recall@5로 뭉치면 어느 경로가 무너졌는지 알 수 없고, 분석기 교체 판단의 근거가 안 된다.

- **⚠️ `SIMILARITY_THRESHOLD=0.62`의 근거가 없다 (T-011 F-2).**
  Atlas의 `vectorSearchScore`는 `(1+cos)/2` 정규화 값이고 retriever가 `2s−1`로 원시 cosine으로
  환산해 돌려준다(T-018 Findings F-A에 실측표). 즉 T-018은 원시 cosine 척도로 비교한다.
  **그러나 0.62라는 숫자 자체가 실측으로 뒷받침된 적이 없다.**
  이 태스크가 임계값을 스윕할 첫 지점이다 — 무관 질의 5개가 전부 `found:false`가 되는
  (`specs/05` Eval 2-c) 최소 임계값과, Recall@5를 깎지 않는 최대 임계값 사이를 재라.

- **후보 오버페치·후보 단계 상한이 다양성에 편향을 줄 수 있다 (T-011, G5 지적).**
  `capByRecordId`는 후보 단계에서 record당 상한을 걸어 장문 레코드의 슬롯 독점을 막는다
  (T-005 F-3 해소). 벡터 단독 경로에서는 무손실이지만, **경로 간 순위 역전이 있으면**
  (한 청크가 벡터에서 record 3위인데 텍스트에서 1위) 상한이 융합 점수를 바꿔
  record 내 선택 2개가 무제한 융합과 달라질 수 있다.
  재현율 손실이라기보다 다양성 편향이고, **이 태스크의 Recall@5·MRR이 측정할 지점이다.**
  `RETRIEVAL_CANDIDATE_OVERFETCH`·`RETRIEVAL_MAX_CHUNKS_PER_RECORD`를 스윕 대상에 넣어라.

- **⚠️ atlas-local의 동점 벡터 점수는 순서 보장이 없다 (T-011 F-9).**
  같은 cosine을 갖는 청크가 여럿이면 `$vectorSearch` 후보 순서가 실행마다 달라진다.
  T-011 구현자가 이걸 어겨 테스트 하나가 간헐 실패했고 **뮤테이션 3건을 가짜로 kill했다.**
  **eval 픽스처도 같은 함정에 걸린다** — 점수를 일부러 어긋나게 심거나, 동점 그룹을
  지목하지 말고 집합으로 단언하라. 간헐 실패하는 eval은 기준선 자체를 무의미하게 만든다.

- **컨테이너 부팅 헬퍼는 `packages/core/src/testing/atlas-local.ts`가 단일 소스다 (T-011 F-8).**
  2단계 부팅 게이트(healthcheck → mongot 응답)가 들어 있다. 복붙하지 말고 그대로 써라.
  어느 배럴에도 export되지 않고 vitest가 수집하지도 않는다.
