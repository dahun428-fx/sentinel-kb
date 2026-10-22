# T-059: record_knowledge·give_feedback 입력 오류 처리
refs: docs/plan/UPLIFT-PLAN.md §4-2 (A3 (Major), A5-a (Major), A6 (Minor), A7 (개선))
M: M3 | deps: T-015,T-022

## 배경

2026-10-22 P1 AI 리뷰(UPLIFT §4-2) 지적. 근거 위치는 리뷰가 코드에서 확인했고, 주요 건은 재확인했다.

- A3: `rootCause: ""`·`prevention: ""`가 생성 입력 검증(`contracts/src/record.ts:47-49`, min 없음)을 통과한 뒤 저장 스키마(`:123,125`,
  min 1)에서 실패한다. API는 "마스킹 라벨이 길이 제약을 넘겼을 수 있다(예: 제목 200자)"라는 엉뚱한 400을 내고(`records.ts:117-127`),
  MCP는 `details`를 버린다(`mcp/src/tools/result.ts:31-34`). 도구 설명이 "모르면 비운다"고 안내하므로 에이전트가 흔히 이렇게 보낸다.
- A5-a: 존재하지 않는 recordId 피드백도 204로 받고, `helped:true`면 `eval_cases` 후보 정답에 들어간다(`feedback.ts:180-195`).
- A6: limit을 생략해도 SDK가 기본값 5를 채워 매번 "limit=5를 요청했지만 3건만 냈다" 문단이 붙는다(`search-knowledge.ts:74,102-128`).
- A7: `CORE_API_URL=""`를 미설정으로 보지 않는다(`mcp/src/config.ts:40`). stdio 모드가 모든 프로젝트 키(`API_KEYS`)를 요구한다.

## Scope
- 빈 문자열·공백을 `undefined`로 취급(MCP 핸들러와 API 양쪽), 또는 생성 입력에 `.min(1)`. 4xx `details[].path`를 도구 오류에 싣는다.
- 피드백 저장 전 `findOne({_id})`, 없으면 404 `RECORD_NOT_FOUND`.
- limit 미지정과 5를 구분해 명시적으로 3 초과를 요청했을 때만 안내문.
- `CORE_API_URL` 빈 값은 기본값으로.

## Acceptance
1. `rootCause: ""`로 `record_knowledge`를 부르면 저장되거나, 필드 이름을 대는 오류가 난다.
2. 없는 recordId 피드백이 404다.
3. 기본 `search_knowledge` 응답에 limit 안내문이 없다.
4. `pnpm verify` 그린.

## Context budget
- 읽기: `packages/contracts/src/record.ts`, `packages/api/src/{records.ts,feedback.ts}`, `packages/mcp/src/tools/{record-knowledge.ts,give-feedback.ts,search-knowledge.ts,result.ts}`, `packages/mcp/src/config.ts`, `specs/07-mcp.md`

## 처리 메모
- P7 전에 처리한다. 계약 변경(`.min(1)`)을 고르면 G3.

## 결과 (2026-10-22)

- **A3**: MCP `record_knowledge`와 API `POST /v1/records` 양쪽에서 선택 텍스트(`rootCause`, `prevention`)의 빈 값·공백을
  미지정으로 정규화. 계약(`.min(1)` 추가)은 바꾸지 않았다(G3 불필요). 4xx `details`의 issue 경로를 도구 오류에
  "문제 필드: …"로 싣는다(값은 싣지 않는다).
- **A5-a**: 존재하지 않는 레코드에 대한 `helped:true`는 피드백만 저장하고 골든셋 후보에 올리지 않는다. 404로 바꾸는 안은
  `/v1/feedback` 계약(specs/04) 변경이라 하지 않았다(Findings F-1). 피드백 테스트 fixture에 두 레코드를 추가했다 — 단언은 그대로.
- **A6**: MCP 입력에서 계약의 `.default(5)`를 떼어 생략은 생략으로 받는다. 생략 시 3건 요청, 안내문 없음.
- **A7**: `CORE_API_URL=""`·공백은 기본 주소. (stdio가 전 키를 요구하는 문제는 Findings F-2)
- 테스트: MCP 통합 3, MCP 단위 2, API 통합 2. 빈 값 건너뛰기·후보 가드를 되돌리면 2건 실패.

## Findings
- **F-1** 없는 recordId 피드백을 404로 거부할지는 specs/04 개정 결정이다. 지금은 후보 오염만 막는다.
- **F-2** stdio 모드가 자기 키를 찾으려고 `API_KEYS` 전체를 요구한다. 1인 사용에서는 무해하고, 사내 확장(P9) 전에
  `SENTINEL_KB_PROJECT` 또는 core-api 조회로 바꾸는 것이 좋다.

STATUS: GREEN
