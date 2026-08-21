# T-002: contracts — Zod 스키마 단일 소스
refs: specs/02-data-model.md, specs/04-api.md
M: M1 | deps: T-001

## Scope
- `RecordSchema`(discriminated union: incident | divergence), `ChunkSchema`, `FeedbackSchema`, `EvalCaseSchema`
- 요청/응답 스키마: CreateRecord, PatchRecord, SearchRequest/Response, AnswerRequest/Response, FeedbackRequest
- `z.infer` 타입 export, zod-to-openapi 등록
- 공통 에러 스키마 `{error:{code,message,details?}}`

## Out of scope
- 서버 구현, DB 접근

## Acceptance
- [ ] incident에 divergence 전용 필드를 넣으면 파싱 실패하는 테스트
- [ ] divergence에서 expected/actual 누락 시 실패하는 테스트
- [ ] `pnpm --filter contracts openapi` 가 유효한 OpenAPI 3.1 JSON 출력
- [ ] `pnpm verify` 그린

## Context budget
- 읽기: specs/02, specs/04, packages/contracts/**

## Findings

### 스펙 수정 (인간 사후 비준 대상)
G5 리뷰에서 스펙-코드 불일치가 드러나 스펙을 고쳤다. CLAUDE.md 원칙 1에 따라 비준이 필요하다.

- **S-1 `specs/02` chunks에 `seq: number` 추가.** specs/03:9의 유니크 키
  `{recordId, section, seq, embeddingVersion}`와 T-005가 요구하는데 specs/02가 누락했었다.
  `seq` 없이는 1200자 초과 섹션의 2번째 청크가 1번째를 upsert로 덮어써 **본문이 조용히 소실된다.**
- **S-2 `specs/04:8` "바디 값 무시" → "바디에 `project`가 오면 400 거부".**
  조용한 무시는 confused deputy를 만든다. 클라이언트가 `project:"B"`로 보내면 201과 함께 A에 저장되고
  요청자는 B에 썼다고 믿는다. 오배치는 `chunks.meta.project`(벡터 인덱스 필터 필드)까지 오염시키며
  specs/02 마이그레이션 규칙이 인플레이스 갱신을 금지해 정정 비용이 크다. `T-007` 스펙 문구도 함께 맞췄다.
- **S-3 `specs/02` records `context?` → `context`.** 입력이 `.default({})`라 저장 시 항상 실체화된다.
- **S-4 `specs/02` `_id` 주석.** contracts는 DB를 모르므로 24자 hex 문자열로 표현하며,
  ObjectId↔string 매핑은 DB 경계(T-003/T-007)의 책임임을 명시.
- **S-5 `specs/02` records에 `summary: string` 추가.** specs/04:19가 "summary는 서버가 생성
  (첫 2문장 또는 LLM 요약 캐시)"이라 규정하고 T-007이 이를 만들도록 지시하는데, 정작 담을 필드가 없었다.
  목록·검색이 본문 대신 이걸 싣는 것이 NFR-03의 기반이다.
- **S-6 `specs/04:13`** answer 행에 `stream` 플래그와 `{found:false, message, suggestRecord:true}` 형상 명시.

### 계약 결함 (수정 완료)
- **B-1** `AnswerResponse`의 found:false가 `{found:false, suggestion}`이었다. specs/03·07·T-018 셋 다
  `{found:false, message, suggestRecord:true}`를 쓴다. `suggestRecord`는 산문이 아니라 **MCP 에이전트를
  `record_knowledge`로 유도하는 기계 판독 신호**다. 자유 문자열로 바꾸면 도그푸딩 루프의 자동 유도가 끊긴다.
- **B-3** `CreateRecordInput`에 `status`가 없어 모든 레코드가 draft로 생겼다. specs/03 §1-1은
  "published로 저장되면 embed job 삽입"이라 **POST→PATCH 2단계 없이는 영원히 임베딩되지 않는** 상태였다.
- **B-4** `ListRecordsResponse`가 레코드 본문 전체를 실었다. MCP 도구가 감싸면 NFR-03 즉시 위반.
  `RecordSummary`로 분리하고 `.strict()`로 본문 필드 재유입을 막았다.
- **B-6** `openapi`가 배럴에 있어 `import { Severity }` 한 줄이 mcp/api/web 전부에
  zod 전역 패치와 문서 생성기를 끌고 왔다. `"./openapi"` 서브패스로 분리.

### 미해결 — 후속 태스크에서 결정
- **F-1 `incident`의 `symptom`/`resolution` 필수 여부.** 구현은 필수, specs/02는 optional이다.
  `resolution` 필수는 **아직 해결 못 한 진행 중 장애를 기록할 수 없게** 만든다.
  "미해결 인시던트를 기록 대상으로 볼 것인가"는 제품 판단이라 보류했다. FR-09(포스트모템 위저드) 시점에 결정.
- **F-2 `PatchRecordInput`에 종류 교차 방어가 없다.** 평면 partial이라 incident 레코드에
  `expected`를 PATCH하는 것이 계약 레벨에서 통과한다. `RecordSchema`로 다시 읽히지 않는 문서가 만들어진다.
  판별 유니온 partial 또는 `superRefine`이 필요하다. **T-007에서 반드시 막아야 한다.**
- **F-3 `jobs` 컬렉션 스키마가 contracts에 없다.** specs/02는 인덱스(`{status:1, createdAt:1}`)만
  언급하고 도큐먼트 형상을 정의하지 않는다. T-008이 요구하므로 T-003 또는 T-008에서 정의 필요.
- **F-4 `scripts/gen-openapi.ts`가 `tsc -b` 밖이다.** `include`가 `["src"]`뿐이라
  Acceptance 3은 `pnpm verify`로 보장되지 않고 수동 실행에만 의존한다.
- **F-5 `sanitizeFlags`를 `z.enum`으로 닫았다.** 새니타이저(T-004)가 3번째 플래그를 내면
  기존 레코드 파싱이 깨진다. T-004에서 플래그 종류를 확정할 때 함께 볼 것.
- **F-6 `POST /v1/records`의 201 응답 형상이 스펙 근거 없이 정해졌다.** openapi는 201 → `Record` 전문으로
  등록했는데, `docs/design/INTERFACE-SPEC.md`와 specs/07 §3은 `{recordId, sanitizeFlags[], warning?}`를
  요구한다. **`warning`이 갈 곳이 계약에 없다** — specs/07이 "마스킹이 발생하면 무엇이 마스킹됐는지
  알려준다(조용히 삼키지 않음)"고 못박았으므로 T-007에서 반드시 결정해야 한다.
- **F-7 `docs/design/INTERFACE-SPEC.md`가 낡았다.** 이 태스크가 만든 문제가 아니라 드러낸 것이다.
  `SearchResponse.degraded?`는 `.strict()`가 거부하고, answer 응답 형상은 판별 유니온과 다르며,
  PATCH의 `409 VERSION_CONFLICT`는 openapi에 없다. 문서 동기화가 필요하다.
