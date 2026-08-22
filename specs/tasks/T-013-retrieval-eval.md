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
