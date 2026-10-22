# T-049: 골든셋 0건 경고 문구를 실제 선행 조건에 맞춘다
refs: specs/tasks/T-047-doc-sync-uplift.md (Findings F-1·F-2), specs/05-test-strategy.md, docs/plan/UPLIFT-PLAN.md
M: M2 | deps: T-047

## 배경

`eval/retrieval/golden-set.ts`의 `goldenSetWarnings`는 골든셋이 0건이면
"T-013의 `⚠️ 착수 전 결정 필요`(seedBatch 마커, G3)가 선행 조건이다"라고 출력했다.
커밋 `02899c2`가 `--reset`을 제자리 PATCH + `seedManifest` 장부로 바꿔 `_id`를 보존하므로
(`scripts/seed.int.spec.ts:335`) 그 선행 조건은 해소됐다. `pnpm eval:retrieval`을 돌리는 사람은
해소된 결정을 기다리라는 안내를 받는다.

문서와 머리 주석은 T-047에서 고쳤다. 이 문구는 `golden-set.spec.ts`·`run.spec.ts`가 단언하고
있어 T-047 범위에서 뺐다. **테스트를 고쳐 통과시키는 일이 아니라, 요구사항(안내해야 할 선행
조건)이 바뀌어 단언을 함께 고치는 일이다.** 근거는 T-047 Findings F-1이다.

## Scope
- `goldenSetWarnings` 0건 문구: 남은 선행 조건(실 임베딩 자격증명, 골든셋 작성)을 안내한다.
- 단언 갱신: `golden-set.spec.ts`(자격증명·골든셋 작성 포함, `seedBatch` 미포함),
  `run.spec.ts`(0건 리포트 경고에 자격증명 포함).
- `golden-set.int.spec.ts:104` 주석(T-047 F-2), `golden-set.ts` 머리 주석의 후속 처리 표시.

## Out of scope
- 경고 외 로더·러너 로직. 골든셋 작성. `EXPECTED_GOLDEN_SET_SIZE`.

## Acceptance
1. `pnpm vitest run --project unit eval/retrieval` 그린.
2. 뮤테이션: `golden-set.ts`를 main 판으로 되돌리면 2건 실패한다.
3. `grep -n "seedBatch" eval/retrieval/golden-set.ts` → 머리 주석의 당시 기록(6·15행)만 남는다.
4. `pnpm verify` 그린.

## Context budget
- 읽기: `eval/retrieval/{golden-set.ts,golden-set.spec.ts,golden-set.int.spec.ts,run.spec.ts,README.md}`,
  `specs/tasks/T-047-doc-sync-uplift.md`

STATUS: GREEN
