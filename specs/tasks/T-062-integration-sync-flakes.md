# T-062: 통합 테스트의 외부 프로세스 동기화 플레이크
refs: specs/05-test-strategy.md, specs/tasks/T-045-test-timeout-flakes.md (결과 절)
M: M7 | deps: T-045

## 배경

T-045 결과 절의 고병렬 75회에서 T-045 처방 밖의 실패 4회가 나왔다. 전부 통합 계층이고 타임아웃이 아니라 동기화 문제다.

1. **atlas-local vector 인덱스 반영 지연.** `packages/core/src/retriever/retrieve.int.spec.ts`(cosine 척도 2건, `maxVectorScore`가 0),
   `packages/core/src/db/search-indexes.int.spec.ts`(`$vectorSearch`가 기대와 다른 문서). 인덱스가 READY여도 방금 넣은 문서가
   mongot에 반영되기 전에 질의가 나간다.
2. **MongoMemoryServer 기동.** `packages/api/src/records.int.spec.ts`가 `beforeAll`에서 실패해 파일 전체(57건)가 건너뛰어졌다. 로그를 남기지 못했다.
3. **nginx 스트리밍 ECONNRESET.** `tools/nginx-streaming.int.spec.ts` "`text/event-stream`으로 응답한다".

## Scope
- 1: 문서 삽입 후 **그 문서가 질의에 보일 때까지** 폴링하는 헬퍼(예: `_id` 필터로 `$vectorSearch`/`$search` 결과에 나올 때까지, 상한 있음).
  READY 대기만으로 끝내지 않는다.
- 2: 재현 시 `beforeAll` 오류를 남기도록 하고 원인 확인. 포트 경합이면 MongoMemoryServer 인스턴스 공유 또는 재시도.
- 3: 업스트림 준비 확인 후 요청, 또는 연결 재설정 1회 재시도를 테스트 하네스에만.

## Out of scope
- 단언 완화, skip, 재시도로 단언 실패를 덮는 것 (CLAUDE.md 원칙 4).

## Acceptance
1. 고병렬 `npx vitest run` 40회 이상 반복, 실패 0건. 실행 횟수·환경을 이 파일에 기록.
2. `pnpm verify` 그린.

## Context budget
- 읽기: `packages/core/src/testing/atlas-local.ts`, `packages/core/src/retriever/retrieve.int.spec.ts`, `packages/core/src/db/search-indexes.int.spec.ts`,
  `packages/api/src/records.int.spec.ts`(beforeAll), `tools/nginx-streaming.int.spec.ts`, `vitest.config.ts`

## 결과 (2026-10-22)

측정은 로컬 맥북 Docker Desktop, `npx vitest run` 반복. 회차마다 실패 로그 전체를 남겨 원인을 확인했다.

| 회 | 조건 | 실패 | 확인된 원인 |
|---|---|---|---|
| 1 | 수정 일부, 로컬 스택 실행 중 + 다른 작업 병행 | 4/40 | MongoMemoryServer `Port "50232" already in use`, 단위(mermaid) 5s 초과, Docker BuildKit 중단·atlas unhealthy, 필터 테스트 색인 지연 |
| 2 | 로컬 스택 중지, 병행 작업 없음 | 5/40 | 단위·통합 동시 실행으로 atlas 컨테이너 unhealthy·mermaid 초과, 다른 색인 지연 테스트, nginx ECONNRESET, nginx 타이밍 단언(435ms vs 434ms) |
| 3 | 아래 수정 전부 | **0/40** | — |

수정:
- **실행 순서**: `vitest.config.ts`에 `sequence.groupOrder`(unit 0, integration 1). `npx vitest run`도 `pnpm verify`처럼 단위 다음에 통합을 돈다.
- **MongoMemoryServer 포트 경합**: `@sentinel/core/testing/memory-server`의 `startMemoryServer()` — 포트 충돌일 때만 다시 띄운다. 11개 파일 적용.
- **색인 반영**: `waitForIndexedDocuments()` — 넣은 문서가 `$vectorSearch`·`$search` 양쪽에 전부 보일 때까지 대기. retrieve·search-indexes int에 적용,
  필터 테스트 두 곳은 기대 문서가 보일 때까지 대기. 단언은 바꾸지 않았다.
- **atlas-local `unhealthy`**: 끝 상태가 아니므로 제한 시간까지 회복을 기다린다.
- **nginx 하네스**: `/health` 연속 2회 응답(본문 소비)을 준비로 본다. "첫 바이트가 끝보다 먼저"는 `totalMs − firstAt`로 재 연결 수립 시간을 뺀다.

## Findings
- **F-1** `nginx-streaming.int.spec.ts`의 `/mcp` 설정 대조군은 `proxy_buffering on`에서도 통과한다(원래 단언·새 단언 모두, 각 1~2회 확인).
  테스트 주석의 "그 줄을 지우면 이 테스트만 빨개진다"는 지금은 사실이 아니다. 오리진 프레임 간격·크기에서 nginx가 버퍼링해도 바로
  흘려보내는 것으로 보인다. 버퍼링을 실제로 드러내는 계기(큰 프레임 또는 `proxy_buffer_size`보다 작은 간격)를 다시 설계할 후속 태스크가 필요하다.

STATUS: GREEN
