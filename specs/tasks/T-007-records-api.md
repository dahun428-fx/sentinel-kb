# T-007: records CRUD API
refs: specs/04-api.md, FR-01
M: M1 | deps: T-003, T-004

## Scope
- Fastify 앱 + Bearer 인증 훅(키→project 클레임)
- POST/GET/PATCH `/v1/records`, GET 목록(cursor 페이지네이션)
- 저장 시 sanitizer 통과, `project`는 **키에서 주입**(바디에 `project`가 오면 400 거부 — specs/04)
- published로 **저장 또는 전환** 시 `jobs`에 embed job 삽입
  (T-002 이후 생성 기본값이 published다 — 전환만 걸면 대부분의 레코드가 임베딩되지 않는다)
- `summary` 자동 생성(첫 2문장)

## Out of scope
- 검색, 생성, 워커

## Acceptance
- [ ] 통합 테스트: 생성→조회→수정→목록 플로우
- [ ] 바디에 `project`를 넣으면 **400 + 에러 코드**로 거부됨을 검증
      (T-002 S-2로 specs/04를 "무시" → "400 거부"로 고쳤다. 이 줄이 옛 문면으로 남아 있었다.
       조용한 치환은 클라이언트가 B에 썼다고 믿는데 A에 저장되는 confused deputy를 만든다.)
- [ ] 다른 project 키로 **남의 레코드를 수정**하려 하면 거부됨을 검증
      (specs/04 규약: `project` 크로스 **조회**는 허용, **쓰기는 자기 project로만**)
- [ ] 인증 없음/잘못된 키 → 401, 스키마 위반 → 400 + 에러 코드
- [ ] 시크릿 포함 본문 저장 시 sanitizeFlags 기록 + 응답에 경고 포함
- [ ] `pnpm verify` 그린

## Context budget
- 읽기: specs/04, specs/02, packages/api/**, packages/core/src/sanitizer/**

## Findings (T-006·T-008에서 미리 넘김)

- **⚠️ PATCH가 `record.embeddingVersion`을 보존해야 한다.** 이 필드는 "마지막으로 온전히 임베딩된
  세대" 워터마크이고 **올리는 주체는 인제스트 워커 단독**이다(specs/02).
  T-007은 **생성 시 `0`으로 초기화**하는 것까지만 담당한다(필수 필드라 반드시 쓴다).
  **도큐먼트를 통째로 `$set`하거나 재검증 후 전체 치환하면 워터마크가 0으로 되돌아가
  이미 임베딩된 record가 미임베딩으로 오인된다.** `PatchRecordInput`이 `.strict()`라
  클라이언트 주입은 막히지만 **서버 내부의 전체 치환은 막는 장치가 없다.** 부분 `$set`을 쓸 것.
- **`summary`도 서버 생성 필드다**(specs/02, T-002 S-5). 클라이언트 입력은 `.strict()`가 거부한다.
- **T-002 F-2: `PatchRecordInput`에 종류 교차 방어가 없다.** 평면 partial이라 incident 레코드에
  `expected`를 PATCH하는 것이 계약 레벨에서 통과하고, `RecordSchema`로 다시 읽히지 않는 문서가 만들어진다.
  **T-007에서 반드시 막아야 한다.**
- **T-002 F-6: `POST /v1/records`의 201 응답에 `warning`이 갈 곳이 없다.**
  specs/07 §3은 "마스킹이 발생하면 무엇이 마스킹됐는지 알려준다(조용히 삼키지 않음)"고 못박았다.
  현재 openapi는 201 → `Record` 전문으로 등록돼 있다. 응답 형상을 결정해야 한다.
- **T-004 F-1: `sanitize()`가 마스킹 종류와 규칙 id를 버린다. (T-004 해제됐고 이 항목은 미해결로 넘어왔다)**
  공개 계약이 `{text, flags}`뿐이라 위 `warning`을 채울 수단이 없다.
  본문 라벨 재파싱이나 API 계층 재조립은 둘 다 나쁘다 —
  **core 내부에서 `SanitizeResult`를 `{text, flags, masked, injectionRules}`로 확장하는 것이 답이다.**
  contracts 변경이 아니므로 G3가 아니다.
- **T-008 F-6: `packages/worker`가 `mongodb`·`@sentinel/contracts`에 직접 의존한다.**
  record/chunk 리포지토리를 `@sentinel/core/db`로 승격할지는 **T-007이 같은 매핑을 다시 쓰게 되므로
  이 시점에 판단하는 게 맞다.** 소비자가 둘이 되는 시점이 추상화의 올바른 시점이다.
- **⚠️ 길이 상한은 이미 core에 있다. 새로 만들지 말고 에러를 번역하라.**
  `sanitize()`가 `SANITIZE_MAX_INPUT_CHARS`(기본 **65536**)를 넘는 입력에
  **`SanitizeInputTooLargeError`(code `SANITIZE_INPUT_TOO_LARGE`)를 던진다.** 자르지 않는다 —
  조용한 절단은 "검사되지 않은 시크릿을 호출자가 모르고 저장"하는 경로이기 때문이다.
  T-007은 이걸 **잡아서 4xx로 번역**해야 한다. 잡지 않으면 500이 난다.
  **상한이 `sanitize()` 호출 단위라는 점이 중요하다** — 섹션별로 부르면
  5섹션 × 65536 = 327KB 요청이 게이트를 통과한다. "요청 본문 상한"으로 착각하면 방어가 성립하지 않는다.
  상한을 올릴 때는 반드시 성능을 재측정하라 — 겹침 해소가 **이차**라 256KB 부근에서 다시 초 단위가 된다
  (64KB 실측 57ms).
  **미결(인간 비준 대상):** 이 제약이 `specs/04`에도 `packages/contracts`에도 문면화돼 있지 않다.
  400인지 413인지, 필드 단위인지 요청 단위인지, contracts에 `.max()`를 둘지(→ G3) 결정이 필요하다.

## Findings (T-007 구현·리뷰)

### G5가 잡은 머지 차단 2건 — 수정 완료
- **`PendingEmbedJob`이 contracts 타입을 재정의하고 있었다.** 독스트링은 "`JobSchema`에서
  파생한다 — 형상을 다시 적지 않는다(CLAUDE.md)"라고 적어 놓고 바로 아래에서 손으로 다시 적었다.
  → `Omit<JobSchema, "_id"|"recordId"|"lastError"|"status"> & {recordId: ObjectId; status:"pending"}`로 파생.
- **`packages/api`가 `@sentinel/worker`를 devDependency + tsconfig 참조로 끌어왔다.**
  내가 "job 형상 계약을 잠그는 유일한 방법"이라고 지시했는데 **그게 틀렸다.**
  → 제거하고 **더 강한 잠금**으로 교체했다: 저장된 잡을 `JobSchema`로 실제 파싱한다.
  **뮤테이션으로 증명됨** — `JobSchema`에 `leaseExpiresAt`(specs/02가 예고한 필드)을 추가하면
  새 방식은 **테스트가 죽고 컴파일도 깨지는데**, 크로스 패키지 방식은 **둘 다 조용히 통과하고
  워커만 잡을 못 집는다.** 엣지가 막으려던 바로 그 사고를 엣지가 못 막았다.

### G5가 잡은 게이트 구멍 1건 — 수정 완료
- **F-4 `tags`가 길이 합계를 우회했다.** 태그는 마스킹하지 않는다(`{tags:1}` 인덱스와
  `meta.tags` 필터의 **정확 일치 키**라 마스킹이 비가역이고 조회를 조용히 깬다).
  그런데 합계에서도 빠져 있었고, contracts의 `tags: z.array(z.string()).max(20)`에
  **개당 길이 제한이 없다**는 점과 겹쳐 `tags: ["<900KB>"]` 하나가 게이트를 통째로 지나
  `chunks.meta.tags`를 거쳐 검색·MCP 응답까지 전파됐다.
  → **마스킹과 계량은 별개다.** `countOnly` 경로를 추가해 길이만 센다.
  **시크릿 검출 여부는 여전히 미결** — 아래 R-4.

### 인간 비준이 필요한 스펙 수정 (R-1~R-7)
| # | 대상 | 내용 | 시한 |
|---|---|---|---|
| **R-1** | contracts + specs/04 (**G3**) | `warning` 자리. `CreateRecordResponse = Record & {warning?}` 신설, openapi 201 교체. **`RecordSchema`가 `.strict()`가 아니라 규칙대로 파싱하는 클라이언트는 이 필드를 떨어뜨린다** — 즉 계약을 지킨 T-015가 못 읽는다 | **T-015(M3) 이전 필수** |
| **R-2** | specs/04 + openapi | 상한 초과 = **413** `SANITIZE_INPUT_TOO_LARGE`, 단위는 **요청당 새니타이즈 대상 텍스트 합계**. openapi 413 등록 | T-012 이전 |
| **R-3** | specs/04 PATCH 행 (F-3) | 재임베딩 트리거에 **`title` 추가**(청크 텍스트가 `"[{title}] ({section}) {body}"` — specs/03 §1-2). `severity`·`tags` 변경 시 `chunks.meta` 갱신 경로 신설 + **담당 태스크 배정**(지금은 그 경로가 없어 메타가 영구히 낡는다) | T-011 이전 |
| **R-4** | specs/00 FR-06 또는 specs/04 | 새니타이즈 게이트의 **대상 필드 목록** 명문화. `tags`에 시크릿이 있으면 **400 거부**가 답일 수 있다(마스킹과 달리 정확 일치가 보존된다). contracts에 태그 개당 길이 제한(→G3) | T-009 이전 권고 |
| **R-5** | specs/04 §규약 또는 specs/07 §1 | `summary` 최대 길이를 **NFR-03에서 유도**해 명시. 현 구현 400자는 근거가 없고, `limit=5` 기준 한국어 400자 ≈ 1250–2000 토큰으로 **NFR-03(≈800 토큰)을 2배 초과**한다 | T-012 이전 |
| **R-6** | specs/tasks/T-007 | Out of scope("워커")와 Findings(T-008 F-6 승격 위임)의 문면 충돌 정정 | 사후 |
| **R-7** | 미배정 갭 | specs/04 §OpenAPI의 `/v1/openapi.json` 서빙이 **어느 태스크에도 없다** | 사후 |

### 남은 것
- **F-3** 제목·태그·severity 변경이 재임베딩·메타 갱신을 트리거하지 않는다(R-3).
  **다만 벡터 인덱스 필터는 어긋나지 않는다** — `vec_idx` filter는 `meta.type`·`meta.project`·
  `embeddingVersion` 셋뿐이고 앞 둘은 PATCH로 바뀌지 않는다(전자는 서버 소유, 후자는 `TYPE_IMMUTABLE`).
  실제 문제는 `chunks.meta.{severity,tags,sanitizeFlags}`가 record와 갈라지는 정합성이다.
  T-009 시드는 PATCH를 하지 않으므로 M1–M2 구간의 실제 오염은 없다.
- **F-5** PATCH의 `sanitizeFlags`는 단조 증가한다(손대지 않은 섹션의 플래그를 지울 근거가 없다).
  시크릿을 지우는 수정을 해도 `secret-masked`가 남는다.
- **F-6** 목록에 총계가 없다(cursor 방식). T-023 웹 UI가 페이지 번호를 요구하면 충돌한다.
- **F-7** `/health`가 `readEmbedderConfig()`를 쓰지 않아 "임베딩 설정이 깨졌는데 health는 ok"가 가능하다.
  워커 헬스체크가 따로 필요하다.
- **F-8** `/v1/search`·`/v1/answer`·`/v1/feedback`·`/v1/openapi.json`은 404다.
  **openapi 문서에는 이미 등록돼 있어** 문서와 구현이 어긋난 창이 T-012/T-019/T-022까지 열려 있다.
- `setNotFoundHandler`가 경로 404에도 `RECORD_NOT_FOUND`를 쓴다 — 코드 분리 권고.
- `/health/`(후행 슬래시)는 401. 사소.

### 검증이 잡은 커버리지 공백 4건 — 수정 완료
뮤테이션 31종 중 **6종이 생존**했고, 그중 4종이 실제 공백이었다(2종은 등가 뮤턴트).
**코드는 전부 옳았고 지키는 테스트가 없었다.**

- **S1 (보안) PATCH의 summary 재생성 경로에 테스트가 없었다.** Acceptance 5는 POST만 덮는다.
  원문에서 생성하면 **마스킹된 시크릿이 `summary`를 타고 목록·검색 응답으로 샌다.**
  → 회귀 추가(저장 문서 + 목록 응답 양쪽 단언). 뮤턴트 1 failed.
- **R13 PATCH가 summary를 아예 재생성하지 않아도 아무도 몰랐다.** 요약이 본문과 조용히 어긋난다.
  → 회귀 추가. 뮤턴트 2 failed.
- **MT3·MT4 F-4 수정의 라우트 배선이 무테스트였다.** 단위 테스트는 `sanitizeFields(countOnly)`
  **함수**만 검증하고, 라우트가 실제로 태그를 넘기는지는 아무도 안 봤다.
  → POST·PATCH 통합 회귀 추가. 뮤턴트 1 failed.
- **N1 "project는 키에서만"을 클라이언트 헤더 주입으로 시험하는 테스트가 없었다.**
  바디 거부(Acceptance 2)와는 다른 축이다. → `x-project`·`x-forwarded-project` 회귀 추가.

**추가 수정: `relations[].note`도 길이 합계에 넣었다.** 개당 500자 × 최대 50개 = 25K로
본문 상한을 우회하는 두 번째 경로였다(F-4와 같은 축). **마스킹 여부는 여전히 미결** —
note는 자유 텍스트라 태그와 달리 마스킹해도 깨지는 조회가 없다. R-4에서 함께 결정한다.

### 검증에서 확인된 것 (결함 없음)
프로브 56종 실측: **워터마크 우회 10종 전부 400**(`__proto__`·`constructor`·`$set`·`embeddingVersion.x` 포함),
**project 헤더 주입·경로 우회 전부 차단**, 종류 교차 8조합 전부 400 + 저장된 문서가 `RecordSchema.parse()` 통과,
cursor 동일 `createdAt` 20건 완주(중복·누락 0), 위조 cursor 5종 4xx, `offset`/`skip`/`page`/`sort` 전부 400.

**`JobSchema` 파생이 실제로 계약을 잠근다** — `leaseExpiresAt`을 필수로 추가하면
`pnpm typecheck` **exit 2**(TS2322)이고 통합 테스트 3건이 죽는다. **컴파일·테스트 양쪽**이다.
워커 엣지 제거는 **순증**이다 — 구 방식이 잡던 것(약칭 잡, 날짜를 ISO 문자열로)도 유지되고
(`z.date()`가 coerce가 아닌 게 결정적) 새로 "계약에 필드가 추가되는" 사고까지 잡는다.

### 남은 구멍 (기록)
- **api가 넣은 잡을 워커의 `claimNextJob` 쿼리가 집는지 검증하는 테스트가 레포에 없다.**
  결합은 `JobSchema` 한 겹뿐이라 **워커 쿼리가 바뀌면**(예: `claimedBy` 필터 추가) api 쪽은 조용하다.
  검증자가 쿼리를 인라인 복제해 오늘 시점에는 실제로 집힌다는 것을 확인했다.
  크로스 패키지 E2E를 원하면 워크스페이스 밖(`tests/integration/`)에 두는 것이 답이다.
- **`context` PATCH는 전체 치환이다.** `{model}`만 보내면 `tool`·`framework`가 조용히 사라진다.
  스펙에 문면이 없고 테스트가 그 형태를 고정하고 있다 — 의도라면 명문화 필요.
- **태그 시크릿은 목록 응답으로 샌다**(`RecordSummary.tags`). R-4가 미결로 잡아 둔 사안.
- cursor에 서명이 없어 형식이 맞는 위조 cursor는 200을 낸다. specs/04가 서명을 요구하지 않으므로 위반은 아니다.
