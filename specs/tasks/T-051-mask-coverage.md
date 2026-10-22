# T-051: 시크릿 마스킹 범위 보강 (P1 보안 리뷰 S1)
refs: specs/00-product.md FR-06, specs/03-rag-pipeline.md, specs/tasks/T-004-sanitizer.md (F-5, F-10), docs/plan/UPLIFT-PLAN.md §4-2·§5
M: M1 | deps: T-004

## 배경

P1 보안 리뷰 S1 (Critical). 마스킹 규칙이 7종(mongo URI, Bearer, `api_key=`, `sk-`/`pa-`, AWS 키 2종,
40자 base64)뿐이라 다음이 **평문으로 저장되고 청크 원문으로 Voyage, 생성 문맥으로 Anthropic에 나갔다**
(UPLIFT §5). 리뷰가 sanitizer를 직접 호출해 확인했다.

- postgres·mysql·redis URI 자격증명, `https://user:pass@`
- PEM·OpenSSH 개인키 블록
- 앵커 없는 JWT, `Cookie: session=eyJ…`
- `DB_PASSWORD=`, `JWT_SECRET=`, `PASSWORD:`, `token=`, `curl -u`, `Authorization: Basic`
- GitHub·GitLab·Slack·Google·Stripe·npm 토큰, `API_KEYS=`(복수형)
- `비밀번호는 hunter2Secret 입니다`

T-004 F-5·F-10이 일부(ghp_, JWT, postgres/redis)를 알려진 공백으로 적어 두었다.
UPLIFT P4(실 임베딩)·P5(실데이터 적재) 전에 막아야 한다.

## Scope
- `masking.ts`: 종류 4개 추가(`url-credentials`, `private-key`, `jwt`, `credential`), 규칙 추가,
  DB 스킴 확대(같은 경계 파서 재사용), `api[_-]?keys?`.
- 치환 단계를 선형으로: 뒤에서부터 매번 문자열을 복사하던 루프를 조각 결합으로 바꾼다.
  짧은 시크릿 수천 개가 든 64K 입력에서 459ms → 111ms (실측).
- `sanitize.coverage.spec.ts`: 잡아야 할 27건 + 잡으면 안 되는 17건.

## Out of scope
- 검색어·피드백 마스킹 (T-052).
- 숫자·기호 없는 영단어 비밀번호의 한국어 문장 표기(`비밀번호는 correcthorse`) — 오탐과 맞바꾼 한계.
- `mongodb://user:pass word@` 같은 공백 포함 비밀번호 (T-004 기존 한계).

## Acceptance
1. `pnpm vitest run --project unit packages/core/src/sanitizer` 그린 (기존 414 + 신규 44).
2. 뮤테이션: `MASK_RULES`에서 `collectJwt` 또는 `collectKoreanCredential`을 빼면 해당 사례가 실패한다.
3. 선형성: T-045의 CPU 시간 비 단언(`c764f0a` 판 `sanitize.property.spec.ts`)이 이 코드에서 그린.
4. `pnpm verify` 그린.

## Context budget
- 읽기: `packages/core/src/sanitizer/{masking.ts,sanitize.ts,sanitize.spec.ts,sanitize.property.spec.ts}`,
  `specs/tasks/T-004-sanitizer.md`(F-5·F-10), `specs/00-product.md`(FR-06)

## Findings
- **F-1** 같은 입력에서 main 코드도 `Bearer ` 반복 64K에 예열 전 921ms가 걸린다. 이 태스크 후 342ms.
  main의 `< 500ms` 벽시계 단언은 부하에서 이 태스크와 무관하게 실패한다 — T-045가 고친다.
- **F-2** `mongodb://` 반복 입력은 여전히 64K에서 약 150ms다. 경계 파서(`findUserinfoEnd`)의 줄 단위
  스캔이 원인으로 보이며 기존 동작이다. 선형성 단언은 통과한다.

STATUS: GREEN
