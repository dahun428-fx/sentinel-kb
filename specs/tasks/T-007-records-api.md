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
