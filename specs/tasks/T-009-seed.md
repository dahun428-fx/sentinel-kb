# T-009: 시드 데이터 50건 + db:seed
refs: FR-10, specs/05
M: M1 | deps: T-007, T-008

## Scope
- `packages/core/seed/`: incident 40건(실사례 20 + 공개 포스트모템 요약 20), divergence 10건
- **자기 시드 편입**: `seed/self/SELF-01~05.json` (이 프로젝트 설계 과정의 실사건 — PORTFOLIO-WEAVE 채널 2)을 시드에 포함하고, 이후 감사·개발 중 사건을 여기에 누적
- 공개 포스트모템은 **원문 복제 금지** — 자기 문장으로 요약하고 출처 URL을 `tags`/`prevention`에 표기
- divergence 시드는 실제 겪은 이격 위주(환각 API, 버전 가정 오류, 스펙 드리프트 등)
- `pnpm db:seed` (idempotent, `--reset` 옵션)

## Out of scope
- 골든셋 (T-013)

## Acceptance
- [ ] seed 2회 실행해도 레코드 수 동일
- [ ] 50건 전부 published + chunks 생성 완료(워커 대기 후 검증)
- [ ] divergence 10건 모두 `context.model`과 `correction` 채워짐
- [ ] `pnpm verify` 그린

## Context budget
- 읽기: specs/02, packages/core/seed/**

## Findings (T-007·T-008에서 미리 넘김)

- **⚠️ 기존 `seed/self/SELF-*.json`이 `CreateRecordInput`과 맞지 않는다.**
  다섯 파일 모두 `project` 필드를 갖고 있는데, T-002가 `.strict()`로 막았고
  specs/04는 **바디에 `project`가 오면 400 거부**로 정정됐다(T-002 S-2).
  또 서버 생성 필드(`summary`·`sanitizeFlags`·`relations`·`status`·`embeddingVersion`·
  `createdAt`·`updatedAt`)가 전부 없다.
  → 시드 스크립트가 (a) HTTP API를 거치면 `project`를 **빼고** 보내야 하고,
     (b) DB에 직접 넣으면 서버 생성 필드를 **직접 채워야** 한다.
     어느 쪽이든 시드 JSON의 형상을 그대로 쓸 수 없다. 형상을 맞추든 변환 계층을 두든 결정이 필요하다.
- **⚠️ 시드 CLI의 패키지 배치를 먼저 정해야 한다.**
  Acceptance 2가 "chunks 생성 완료(**워커 대기 후** 검증)"를 요구하는데,
  Scope는 시드를 `packages/core/seed/`에 둔다. **`@sentinel/core`는 `@sentinel/worker`를 import할 수 없다** —
  그건 진짜 의존 역행이다(specs/01). 따라서 `runOnce()`로 큐를 비우는 방식은 core 안에서 성립하지 않는다.
  → 시드 CLI를 core 밖(루트 `scripts/` 또는 별도 패키지)에 두거나, 워커 프로세스를 별도로 기동해야 한다.
     `runOnce()`가 공개 API로 노출된 것은 이 용도에 유용하다(무한 루프 없이 드레인 가능).
- **멱등성은 문제없다.** 재시드로 job이 다시 들어와도 upsert가 멱등하고 고아 삭제가 세대 안에 갇혀 있다.
- **T-006 F-8: `EMBEDDING_PROVIDER=fake`로 시드하면 안 된다.** fake 벡터는 서로 다른 텍스트 간
  cosine ≈ 0이라 `SIMILARITY_THRESHOLD` 게이트가 항상 `found:false`를 낸다.
  시드는 **실제 임베딩**으로 넣어야 T-013(retrieval eval)이 의미를 갖는다.

## Findings (T-009 수행 중)

- **F-1. 시드 CLI를 루트 `scripts/`에 두려면 루트가 워크스페이스 패키지를 명시 의존해야 한다.**
  pnpm은 각 패키지의 선언된 의존만 그 패키지의 `node_modules`에 링크한다. 루트는 자동으로
  아무것도 받지 않으므로 `scripts/seed.ts`의 `import ... from "@sentinel/api"`가
  `ERR_MODULE_NOT_FOUND`로 죽는다. 루트 `package.json` devDependencies에
  `@sentinel/{api,contracts,core,worker}: workspace:*`를 추가해 해결했다(+ `mongodb`,
  `mongodb-memory-server`는 통합 테스트용). 상대 경로 import로 우회하지 않았다 — 그러면
  패키지의 `exports` 경계가 사라진다. 이 사건 자체를 시드 INC-16으로 기록했다.
- **F-2. 루트 `scripts/`는 tsconfig 프로젝트로도 등록해야 typecheck가 검사한다.**
  `tsc -b`는 루트 tsconfig의 references만 훑는다. `scripts/tsconfig.json`을 만들고
  루트 references에 추가했다. `vitest.config.ts`의 두 프로젝트 include에도
  `scripts/*.spec.ts` / `scripts/*.int.spec.ts`를 넣어야 통합 테스트가 수집된다.
  eslint의 TS resolver `project` 목록에도 추가했다. **네 곳을 전부 손대야 한다** —
  `ensure-indexes.cli.ts`가 "scripts/에 두면 typecheck가 검사하지 않는다"고 남긴 경고의
  정확한 내용이 이것이다.
- **F-3. SELF-06 초안의 자격증명 예시를 형태 서술로 바꿨다(초안과의 유일한 차이).**
  `docs/analysis/T-004-POSTMORTEM.md` §5.1은 `mongodb://user:pass@host/db` 꼴 리터럴 세 개를
  본문에 담고 있다. 그대로 넣으면 (a) CLAUDE.md 금지 사항(시크릿 하드코딩)과
  `postmortem-schema` 스킬("시크릿을 넣지 않는다. 새니타이저가 잡지만 의존하지 않는다")에
  걸리고, (b) 지금의 fail-closed 마스킹 규칙이 그 세 줄을 `[MASKED:...]`로 바꿔 **지식을
  담은 예시가 저장 시점에 소실된다.** 세 축(물음표 포함 비밀번호 / 골뱅이·샵 포함 비밀번호 /
  콜론 없는 사용자명)을 문장으로 서술해 유지했다. 나머지 본문은 초안 그대로다.
  초안이 자인한 "RecordSchema 적합성 미검증"은 해소됐다 — `CreateRecordInput`으로 파싱되고
  API를 거쳐 저장·임베딩까지 통과한다. `severity: "SEV1"`은 초안 제안값을 그대로 뒀다
  (이 레포에 SEV 기준 문서가 여전히 없다 — 인간 비준 대상).
- **F-4. T-002 F-1의 지시 내용과 레포 기록이 어긋난다.** 인계 지시는 T-002 F-1을
  "`AnswerResponse` 형상 불일치"로 지목했으나, `specs/02-data-model.md:17`의 미결 블록은
  같은 번호를 "contracts가 symptom·resolution을 필수로 둠"에 붙이고 있다. `AnswerResponse`
  (`packages/contracts/src/api.ts:127`)는 현재 `.strict()` 판별 유니온으로 정상이고 미결 표시가
  없다. 시드 DIV-01은 **실제로 읽은 것**(specs/02의 미결 블록)에 근거해 썼다. 어느 쪽이
  진짜 F-1인지는 T-002 태스크 파일을 봐야 갈린다 — Context budget 밖이라 확인하지 않았다.
- **F-5. 멱등 키를 `{project, title}`로 정하면 "저장된 title = 시드 title"이 전제가 된다.**
  새니타이저가 title을 고치면(마스킹 라벨 삽입) 다음 실행의 조회가 그 레코드를 못 찾아
  **매 실행마다 새로 삽입한다.** 조용한 중복은 T-013 골든셋까지 오염시키므로 fail-closed로
  만들었다: 적재 후 모든 시드 title이 조회되는지 확인하고 하나라도 없으면
  `SEED_TITLE_REWRITTEN`으로 던진다. 통합 테스트가 이 경로를 합성 픽스처로 직접 친다.
- **F-6. `--reset`의 필터는 멱등 키와 정확히 같아야 한다.** `{project, title: {$in: 시드}}`.
  따라서 사용자가 시드와 **똑같은 title**로 기록한 레코드는 `--reset`이 지운다 — 멱등 키가
  "같은 레코드"라고 판정하는 것과 같은 기준이라 원리적으로 구분할 수 없다. 안정적인
  시드 마커(예: `seedBatch` 필드)를 두면 해소되지만 `RecordSchema`가 `.strict()`라
  contracts 재개방(인간 승인)이 필요하다. 현재는 시드 title이 모두 서술형 문장이라
  충돌 확률이 실질적으로 0이다.
- **F-7. `pnpm db:seed`는 인덱스를 만들지 않는다.** `pnpm db:indexes`를 먼저 돌려야
  chunks 유니크 인덱스가 있는 상태에서 적재된다. 시드 CLI가 `ensureIndexes`를 부르는 편이
  안전하지만 T-003의 책임이라 스코프 밖으로 뒀다 — 실행 순서를 CLI 헤더 주석에 적었다.

### 검증이 잡은 것 — 수정 완료
- **F-8 CLI가 자기 exit code 계약을 어겼다.** `readSanitizeOptions()`·`readEmbedderConfig()`·
  `createEmbedder()`가 `asConfig()` **밖**에 있어 env 오설정이 `EX_CONFIG(78)`이 아니라
  일반 exit 1로 나갔다. CLI 헤더가 "설정 오류는 78로 갈라 **자동화가 재시도할지 사람을 부를지 정한다**"고
  선언했으므로 계약 위반이다. → 셋 다 `asConfig()`로 감쌌다.
  실측: `EMBEDDING_DIM` 누락 → 78, `API_KEYS` 누락 → 78.

### 검증에서 확인된 것
- **시드 구성이 Scope와 정확히 일치한다** — 실사례 20(INC 18 + SELF-incident 2) + 공개 20(PUB) +
  이격 10(DIV 6 + SELF-divergence 4) = incident 40 / divergence 10.
  **구현 보고의 분류 문장이 틀렸을 뿐 데이터는 맞다**(`self/`는 incident 6이 아니라 divergence 4 + incident 2).
- 계약 파싱 50/50, 금지 키 0건, 중복 title 0건, 원문 복제 없음(PUB 20/20이 출처 URL + 자기 문장 요약).
- 멱등: 2회 실행 시 `_id` 100% 보존(delete+insert 아님), chunks 190 유지.
- `--reset`: 시드만 삭제하고 사용자 레코드 생존, chunks·jobs 함께 정리, 고아 0.
- divergence 품질(`postmortem-schema` 기준) 표본 3건 전부 통과 — 재현 조건에 파일 경로까지 있고
  correction이 "무엇을 명시했는지"까지 적혀 있다.

### `SELF-06`의 자격증명 리터럴 제거 판단 — **옳다. 다만 구조적 문제를 드러낸다**
검증자가 실제 새니타이저를 돌려 확인했다:
```
mongodb://appuser:Str0ngPass?x@…   → [MASKED:db-credentials]   (N-10 예시가 소실)
mongodb://svc:P@ss#w0rdLong@…      → [MASKED:db-credentials]   (N-12 예시가 소실)
mongodb://tokenonly_abcdef123456@… → 무변경, flags=[]          (N-13: 평문 영구 저장)
```
**양방향으로 문제다.** N-10·N-12는 저장 시점에 지식이 소실되고, N-13은 반대로
자격증명 모양 문자열이 **평문으로 영구 저장**된다(CLAUDE.md 시크릿 금지 위반).

**이건 시스템이 자기 지식을 삼키는 구조다** — 시크릿 마스킹 사례를 기록하려는데 마스킹이 그 사례를 지운다.
FR-06(마스킹 게이트)과 FR-01(지식 기록)이 정면충돌하는 지점이며, 이 레포의 도그푸딩 프로토콜이
"에이전트 산출물이 의도와 벌어졌으면 divergence로 기록"을 요구하는 이상 **반드시 다시 만난다.**
→ **인간 비준 대상 R-8**: 마스킹 예외 경로(예: 코드 펜스 안, 또는 `example`/`FAKE` 마커가 붙은 값)를
   둘 것인가, 아니면 "형태 서술로만 기록한다"를 규약으로 못박을 것인가.

### 남은 것
- **F-9 `context.model`이 전부 `"claude"`로 모델 버전이 없다.** 스킬의 "재현 조건"을 문자적으로는
  만족하나 6개월 뒤 재현 가능성이 낮다. 시드·위저드 양쪽에서 버전 표기 규약이 필요하다.
- **F-10 `SELF-06`의 correction에서 `@`·`:`·`#`를 "골뱅이"·"콜론"·"샵"으로 바꿨다.**
  마스킹 회피에 불필요했을 수 있고 검색어(`@`) 적중률을 떨어뜨린다.
- **F-11 SELF-01/03/05의 `correction`이 2~3문장으로 스킬의 "3~10문장" 하한에 걸친다.**
  T-009가 만든 파일이 아니라 기존 파일이므로 이번 회귀는 아니다.
- **F-7 재확인**: 인덱스 없이 `db:seed`를 돌리면 **조용히 성공한다**(exit 0).
  chunks 유니크 인덱스 부재가 아무 신호도 내지 않는다. 멱등성은 records 레벨에서 보장되므로
  실해는 없지만 CLI 헤더 주석에만 의존하는 상태다.
