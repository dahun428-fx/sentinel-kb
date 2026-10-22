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

STATUS: TODO
