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

STATUS: TODO
