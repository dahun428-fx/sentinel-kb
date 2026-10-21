# T-047: 문서 리뷰 반영 — 진입점 연결 + 해소된 차단 사유 정정
refs: docs/analysis/DOCUMENTATION-REVIEW-2026-10-21.md, docs/plan/UPLIFT-PLAN.md
M: - | deps: -

## 배경

2026-10-21에 실사용 전환 플랜(`docs/plan/UPLIFT-PLAN.md`)을 쓰고, 같은 날 문서 리뷰
(`docs/analysis/DOCUMENTATION-REVIEW-2026-10-21.md`)가 그 플랜과 기존 문서를 대조했다.
리뷰 지적 8건과 정리 사항 3건의 근거 위치 13곳을 다시 확인했고 전부 사실이었다.

문제는 세 갈래다.

1. **플랜 자체가 틀렸거나 느슨하다.** Q-1이 "회사 문서가 맥북 밖으로 나가지 않는다"고 썼지만
   `packages/core/src/embedder/voyage.ts:131`은 청크 원문을 `api.voyageai.com`으로 보낸다.
   품질 기준은 `specs/00`(Recall@5 ≥ 0.85, 도구 선택 ≥ 0.9)이 아니라 `EXECUTION-PLAN`(0.80 / 0.85)을
   옮겼다. P2는 Critical도 "태스크 등재"만으로 통과한다. P4는 hit 한 건이면 통과한다.
   P8의 "검색 적중"은 `tools/dogfood-report.ts:61`의 정의(`give_feedback(helped: true)`)와 다르다.
2. **해소된 문제가 차단 사유로 남아 있다.** `seedBatch` 마커는 커밋 `02899c2`(`seedManifest` 장부 +
   제자리 PATCH)로 대체 구현됐는데 `docs/DECISIONS-PENDING.md` §3, `eval/retrieval/golden-set.ts`
   머리 주석, `eval/retrieval/README.md`가 여전히 선행 결정으로 안내한다. `docs/analysis/SRS.md`
   CON-02는 atlas-local 정정(`specs/05:7–12`) 이전 문장이다. `DECISIONS-PENDING` §0 PR 스택은
   PR #22 `integration/m3`로 머지됐다.
3. **진입점이 없다.** `docs/README.md`가 UPLIFT를 안내하지 않고, `EXECUTION-PLAN`·`WBS`에는
   역할 표시가 없다.

## Scope
- `docs/plan/UPLIFT-PLAN.md` 개정: 데이터 외부 전송 경로, 품질 기준 3층(중간 / 승인 / 회귀),
  리뷰 지적 심각도 정의와 단계 진입 규칙, 단계별 `선행 조건 / 완료 증거 / 중단 조건 / 후속`,
  P5 앞 적재 도구 단계, 첫 화면 요약.
- `docs/DECISIONS-PENDING.md` §0·§3, `eval/retrieval/golden-set.ts` 머리 주석,
  `eval/retrieval/README.md`, `docs/analysis/SRS.md` CON-02에 해소 표시. 원문은 지우지 않는다.
- `docs/README.md` 상단에 문서 역할 표. `docs/EXECUTION-PLAN.md`·`docs/plan/WBS.md` 상단에 역할 표시.
- `specs/tasks/T-044-dead-second-defenses.md` 14행의 NUL 바이트를 텍스트 `\u0000`으로 교체.
- `docs/plan/WBS.md` 9번 하위 번호(8.1~8.4 → 9.1~9.4).
- `CLAUDE.md` 명령어 표의 존재하지 않는 `pnpm eval`을 실제 스크립트로 교체.
- 이 태스크 등재: `specs/tasks/README.md` 표·추가 이력, README 지표 재생성(`pnpm sync:readme`).

## Out of scope
- **`eval/retrieval/golden-set.ts`의 `goldenSetWarnings` 0건 경고 문구(T-047 반영 후 94행).** 같은 해소 전 내용이지만
  `golden-set.spec.ts:57`·`run.spec.ts:184`가 그 문구를 단언한다. 코드와 테스트를 함께 바꾸는 일이라
  문서 태스크에 넣지 않는다 (Findings F-1).
- 코드·스펙(`specs/00~08`)·contracts 변경. 품질 기준의 수치 자체는 바꾸지 않는다.
- 골든셋 작성, 자격증명, 배포.

## Acceptance
1. `tr -cd '\000' < specs/tasks/T-044-dead-second-defenses.md | wc -c` → `0`, 그리고
   `git diff --no-index --numstat /dev/null specs/tasks/T-044-dead-second-defenses.md`가 숫자(`-` 아님)를 보고한다.
   (`grep -c $'\x00'`은 셸이 NUL을 빈 문자열로 만들어 모든 줄에 걸리므로 판정에 쓰지 않는다.
   HEAD 대비 `git diff --numstat`는 이전 판이 바이너리라 이 커밋에서는 `-`가 나온다.)
2. `grep -nE 'pnpm eval( |$)' CLAUDE.md` → 출력 없음.
3. `grep -c 'plan/UPLIFT-PLAN.md' docs/README.md docs/EXECUTION-PLAN.md docs/plan/WBS.md` → 각 1 이상.
4. `grep -n '해소' docs/DECISIONS-PENDING.md | grep -E '§0|§3|0\.|3\.'` 및
   `grep -c '02899c2' eval/retrieval/golden-set.ts eval/retrieval/README.md docs/DECISIONS-PENDING.md` → 각 1 이상.
5. `pnpm sync:readme && git diff --exit-code README.md` (재생성 후 추가 변경 없음).
6. `pnpm lint && pnpm typecheck && pnpm test` 그린. 통합 테스트는 CI `verify`에서 판정한다.

## Context budget
- 읽기: `docs/analysis/DOCUMENTATION-REVIEW-2026-10-21.md`, `docs/plan/UPLIFT-PLAN.md`,
  `docs/DECISIONS-PENDING.md`, `docs/README.md`, `docs/EXECUTION-PLAN.md`, `docs/plan/WBS.md`,
  `docs/analysis/SRS.md` CON 표, `specs/00-product.md` 성공 지표, `specs/05-test-strategy.md`,
  `eval/retrieval/{golden-set.ts,README.md}`, `scripts/seed.ts` 머리 주석, `CLAUDE.md`, `package.json` scripts,
  `specs/tasks/{README.md,T-044-dead-second-defenses.md}`
- 근거 대조용(수정하지 않음): `packages/core/src/embedder/voyage.ts`, `packages/core/src/retriever/retrieve.ts`,
  `packages/core/src/llm/anthropic.ts`, `packages/mcp/src/tools/suggest-resolution.ts`,
  `tools/dogfood-report.ts`, `docs/dogfooding.md`, `packages/contracts/src/record.ts`

## Findings
- **F-1** `eval/retrieval/golden-set.ts`의 `goldenSetWarnings` 0건 경고(94행)가 "seedBatch 마커, G3가 선행 조건"이라고 출력한다.
  `--reset`은 `02899c2` 이후 `_id`를 보존하므로(`scripts/seed.int.spec.ts:335`) 사실이 아니다.
  남은 선행 조건은 실 임베딩 자격증명과 골든셋 작성이다. 문구와 `golden-set.spec.ts:57`·`run.spec.ts:184`
  단언을 함께 고치는 후속 태스크가 필요하다. 테스트만 고쳐 통과시키는 것이 아니라 요구사항이 바뀐 것이므로
  태스크 근거에 이 Finding을 인용한다.
- **F-2** `golden-set.int.spec.ts:104`의 주석도 같은 내용이다. F-1과 같이 처리한다.
