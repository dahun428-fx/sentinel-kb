# T-013: retrieval eval 러너 + 골든셋 30
refs: specs/05-test-strategy.md (Eval 1)
M: M2 | deps: T-012, T-009

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
