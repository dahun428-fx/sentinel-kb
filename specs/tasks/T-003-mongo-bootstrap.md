# T-003: Mongo 연결·인덱스 부트스트랩
refs: specs/02-data-model.md
M: M1 | deps: T-002

## Scope
- `core/src/db/client.ts`: 싱글턴 커넥션, graceful shutdown
- `core/src/db/indexes.ts`: records/jobs/feedbacks 일반 인덱스 생성(멱등)
- `pnpm db:indexes` 스크립트
- `/health`에 mongo 연결 상태 반영할 수 있는 `ping()` export

## Out of scope
- Atlas Search/Vector 인덱스 (T-010)

## Acceptance
- [ ] 통합 테스트: 인덱스 생성 2회 실행해도 에러 없음(멱등)
- [ ] 연결 실패 시 명확한 에러 코드로 종료하는 테스트
- [ ] `pnpm verify` 그린

## Context budget
- 읽기: specs/02, packages/core/src/db/**

## Findings

### 스펙 수정 (인간 사후 비준 대상)
- **S-1 `specs/02`에 `## jobs` 도큐먼트 블록 추가.** 원래 jobs는 인덱스만 명시되고 형상이 없었다(T-002 F-3).
  형상 없이는 T-008의 원자적 클레임·재시도를 계약으로 잠글 수 없다.
  발명 필드는 `lastError`(dead 원인 추적)와 `updatedAt` 둘이며, 나머지는 specs/03 §1과 DB-DESIGN에서 유도했다.
- **S-2 `specs/02` §인덱스에 `chunks {recordId,section,seq,embeddingVersion} unique` 추가.**
  DB-DESIGN §3과 specs/03 §1-3이 요구하는데 이 목록만 빠뜨리고 있었다.
  **T-010이 이 목록을 읽으므로** 지금 메우지 않으면 벡터 인덱스 태스크가 불완전한 카탈로그를 보게 된다.
- **S-3 `.env.example`에 `MONGODB_SERVER_SELECTION_TIMEOUT_MS` 추가.** specs/03 §6(튜닝 파라미터 env화).
  기본값을 짧게 두지 않으면 오설정이 30초씩 매달려 연결 실패 테스트가 못 돌아간다.

### 채택한 규칙 — 스코프 산문보다 인덱스 카탈로그를 따랐다
T-003 Scope 산문은 "records/jobs/feedbacks 일반 인덱스"라 적었지만,
`specs/02` §인덱스와 `docs/design/DB-DESIGN.md` §3 두 카탈로그를 기준으로 삼았다.
그 결과 **feedbacks는 만들지 않았고 chunks unique는 만들었다.** 같은 규칙의 일관된 적용이다.

### 후속 태스크가 반드시 알아야 할 것
- **F-1 feedbacks 인덱스 미생성 — T-022가 이걸 필요로 하게 된다.**
  두 카탈로그 어디에도 feedbacks 인덱스가 없어 **만들 키의 근거가 0**이라 추측 인덱스를 만들지 않았다.
  추측으로 만드는 게 더 해롭다: `{recordId:1,query:1}` non-unique로 먼저 만들어두면
  T-022가 unique로 바꾸려는 순간 `IndexOptionsConflict`로 **부트스트랩 자체가 깨진다.**
  다만 T-022 Acceptance 3("같은 (recordId, query) 중복 피드백은 upsert")은 동시 요청에서
  중복 문서를 막으려면 `{project:1, recordId:1, query:1}` **unique**가 필수다.
  **T-022는 인덱스 없이 upsert를 짜지 말 것.** 스펙에 인덱스를 먼저 추가하고 구현하라.
  `indexes.int.spec.ts`가 "feedbacks 컬렉션이 생성조차 되지 않음"을 잠가 뒀으므로,
  추가 시 그 테스트가 스펙 갱신을 강제한다.
- **F-2 `JobSchema`가 `.strict()`다.** T-008이 리스/소유자 필드(`claimedBy`, `leaseExpiresAt`)를
  넣으려면 **contracts 재개방 = 인간 승인 경로**가 강제된다. 미리 알고 들어가라.
- **F-3 크래시 회수 경로가 없다.** `findOneAndUpdate`의 문서 단위 원자성으로 "동시 워커 중복 처리 없음"은
  충족되지만, `running` 상태로 죽은 워커의 잡은 **영구 좀비**가 된다.
  `{status:1, createdAt:1}` 폴링이 그 잡을 다시 집지 않기 때문이다. T-008 Acceptance에 없어 차단하지 않았다.
- **F-4 `failed` → `pending` 재큐잉 주체가 미정의다.** specs/03에도 새 jobs 블록에도 없다. T-008에서 결정.
- **F-5 `EMBED_JOB_MAX_ATTEMPTS`가 `.env.example`에 없다.** specs/03 §1-4의 "3회"가 코드 상수로 굳으면
  §6(하드코딩 금지) 위반이다. T-008에서 env화할 것.
- **F-6 CI의 `MONGODB_TEST_URI`는 존재하지 않는 시크릿이다.** 빈 문자열이 주입된다.
  integration은 자체 메모리 서버를 띄우므로 무해하지만 오해를 부르는 죽은 설정이다. 별도 정리 필요.
- **F-7 pnpm 10이 `mongodb-memory-server` postinstall을 차단한다.** 바이너리는 첫 `create()` 시점에
  지연 다운로드되어 동작은 하나 CI 첫 실행이 66MB 다운로드로 느려진다.
  `onlyBuiltDependencies` 추가와 CI 바이너리 캐시를 검토할 것.
- **F-8 `MONGODB_SERVER_SELECTION_TIMEOUT_MS` 기본값 5000이 `client.ts`와 `.env.example` 두 곳에 있다.**
  드리프트 여지.
- **F-9 인덱스 정의 변경 시 마이그레이션 경로가 없다.** 실 mongod 7.0.24로 확인한 동작:
  같은 이름·다른 키 → `IndexKeySpecsConflict`, 같은 키·다른 옵션 → `IndexOptionsConflict`.
  **이름을 명시해도 옵션 변경은 여전히 깨진다.** 즉 앞으로 어떤 인덱스든 `unique` 등을 바꾸면
  `pnpm db:indexes`가 영구히 실패하고 재배포가 막힌다. drop 후 재생성하는 경로가 별도로 필요하다.
- **F-10 `getDb()`가 `getClient()`와 별도로 `readDbConfig()`를 다시 읽는다.**
  런타임에 env가 바뀌면 클라이언트와 DB명이 드리프트할 수 있다.
- **F-11 연결 검증 ping이 `admin()` 대상이라 실제 타깃 DB 접근 권한은 확인하지 않는다.**
  Atlas에서 DB 단위 권한이 막혀 있어도 부트스트랩은 성공한 것처럼 보인다.
