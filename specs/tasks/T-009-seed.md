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
