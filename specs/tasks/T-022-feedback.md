# T-022: feedback API + MCP give_feedback
refs: FR-07, specs/02 (eval_cases 규칙)
M: M4 | deps: T-007

## Scope
- POST `/v1/feedback` + MCP `give_feedback` 연결
- helped=true인 피드백을 `eval_cases` **후보**로 적재(approvedBy 미설정)
- 승인 CLI `pnpm eval:approve` — 사람이 검토 후 골든셋 승격

## Out of scope
- 자동 승격 (금지 사항)

## Acceptance
- [ ] 피드백 저장 후 후보 목록에 나타남
- [ ] 승인 없이는 eval 러너가 그 케이스를 사용하지 않음을 검증
- [ ] 같은 (recordId, query) 중복 피드백은 upsert
- [ ] `pnpm verify` 그린

## Context budget
- 읽기: specs/02, specs/04, packages/api/**, packages/mcp/**

## Findings

### 이번 구현이 덮은 범위
`packages/api`의 `POST /v1/feedback`과 그 저장 경로(`feedbacks` upsert + `eval_cases` 후보 적재)만
구현했다. Scope의 나머지 두 항목은 **손대지 않았다**(아래 F-1, F-2).

- **F-1 MCP `give_feedback` 미연결.** 오케스트레이터 지시로 `packages/mcp`를 건드리지 않았다
  (T-015가 다른 브랜치에서 같은 파일을 수정 중). 이 브랜치의 `packages/mcp/src/index.ts`에는
  아직 도구가 하나도 없어 **T-015가 이 라우트에 무엇을 기대하는지 코드로 확인할 수 없었다.**
  두 브랜치가 만나는 지점의 계약은 다음 세 가지다:
  1. `POST /v1/feedback`, 바디는 contracts `FeedbackRequest` 그대로, `project`는 **바디에 넣으면 400**.
  2. 성공 응답은 **204 No Content(본문 없음)**. contracts에 피드백 응답 스키마가 없어서 본문을 만들면
     계약 밖 형상이 생긴다. T-015의 도구가 JSON 바디를 파싱한다면 **contracts에 응답 스키마를
     추가하는 인간 승인 경로**가 필요하다 — 라우트가 임의로 본문을 만들어선 안 된다.
  3. 인증은 Bearer 키. MCP 서버가 자기 키로 부르면 그 키의 project로 저장된다.
- **F-2 승인 CLI(`pnpm eval:approve`) 미구현.** Scope에 있지만 오케스트레이터가 범위를
  "`/v1/feedback` 라우트와 그 저장 경로"로 좁혔고, CLI는 루트 `package.json`과 `scripts/`를
  수정해야 해 Context budget(`packages/api/**`) 밖이다. **승격 경로가 아직 없다** —
  후보는 쌓이지만 사람이 골든셋으로 올릴 도구가 없다. 후속 태스크가 반드시 채워야 한다.
  구현할 때 쓸 것: `packages/api/src/feedback.ts`의 `EVAL_CASE_CANDIDATE_FILTER`(후보 목록),
  `APPROVED_EVAL_CASE_FILTER`(골든셋). 승인 = `approvedBy: "human"`을 **사람이** 채우는 것 하나뿐이다.

### 후속 태스크가 반드시 알아야 할 것
- **F-3 `feedbacks` unique 인덱스는 여전히 없다(T-003 F-1의 미해결).** T-003은
  "T-022는 인덱스 없이 upsert를 짜지 말 것, 스펙에 인덱스를 먼저 추가하고 구현하라"고 했지만,
  스펙 변경은 인간 승인 경로이고 `packages/core`·`specs/02`는 이 태스크의 budget 밖이다.
  대신 **중복 제거 키를 `_id`에 실었다** — `_id`는 어느 컬렉션에나 이미 unique이므로
  `(project, recordId, query)`에서 유도한 `_id`가 동시 삽입 창까지 닫는다.
  보조 인덱스가 필요하다는 판단이 서면 그때 specs/02 §인덱스에 추가하면 되고,
  그 시점에 `indexes.int.spec.ts`의 "feedbacks에는 인덱스를 만들지 않는다"도 함께 갱신해야 한다.
- **F-4 `recordId` 존재 확인을 하지 않는다.** specs/04에 근거가 없어 넣지 않았다.
  결과적으로 없는 레코드를 가리키는 후보가 생길 수 있다. 사람 승인 단계(F-2)가 걸러야 한다.
- **F-5 `query`를 정규화하지 않는다.** 공백·대소문자가 다르면 다른 후보가 된다.
  정규화 규칙은 골든셋 정의에 속하므로 eval 태스크(T-013)와 함께 정해야 한다.
- **F-6 피드백 철회 경로가 없다.** `helped: true` 뒤에 `false`를 보내면 피드백 문서는 갱신되지만
  이미 만들어진 후보의 `expectedRecordIds`에서는 빠지지 않는다. 스펙에 규정이 없다.
- **F-7 컬렉션 접근자가 `packages/api`에 있다.** `recordsCollection`은 `packages/core/src/db`에 있는데
  `feedbacksCollection`·`evalCasesCollection`은 budget 때문에 api에 뒀다. eval 러너·승인 CLI가
  같은 접근자를 필요로 하는 순간 core로 옮겨야 한다.
- **F-8 Zod 실패 → 400 변환이 라우트마다 따로다.** `records.ts`에는 모듈 사설 `validationError`가
  있고 `feedback.ts`는 같은 변환을 인라인으로 한다(`records.ts`를 고치지 않기 위해).
  바디 `project` 거부 검사도 두 파일에 각각 있다. 세 번째 라우트가 생기면 `errors.ts`로 올릴 것.
