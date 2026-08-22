# T-037: `parseApiKeys`를 `@sentinel/core`로 승격 (인증 복제 회수)
refs: specs/01-architecture.md, specs/07-mcp.md
M: M3 | deps: T-014

## 배경

T-014가 `packages/api/src/auth.ts`의 Bearer 인증 파싱을 `packages/mcp/src/auth.ts`로 **복제**했다.
`mcp → api`는 형제 간선이고 `specs/01`의 의존 방향(`web/mcp/api/worker → core → contracts`)에 어긋나기
때문이다. 복제가 갈라지는 것을 막으려고 `auth.spec.ts`가 두 파일을 디스크에서 읽어 함수 본문을
직접 대조하는 **드리프트 감시기**를 두었다.

**G5 판정: 임시 방어선으로는 충분하나 영구 대책으로는 불충분하다.** 그리고 **T-015 착수 전에
회수해야 한다** — 미루면 MCP 도구 5개가 복제된 인증 위에 올라가고 회수 비용이 커진다.

감시기의 한계(T-014 검증자 실측):
- 감시 대상이 `parseApiKeys`·`extractBearerKey` **둘뿐**이다. 판정 본체(`resolveProject` vs `resolveAuth`)는
  시그니처가 달라 대조 불가이고 양쪽 행동 테스트로만 잠긴다.
- 감시기는 "갈라졌다"만 알리고 **어느 쪽이 옳은지 판정하지 않는다** — 사람이 매번 개입해야 한다.
- **디코이 주석으로 무력화된다.** `extractFunction`이 원문에서 `indexOf("function parseApiKeys(")`
  첫 매치를 잡으므로, 실제 함수 위에 원본 본문을 담은 주석이 있으면 감시기가 그 예시를 비교한다.
  의도적 공작이 필요하지만, **JSDoc `@example`에 시그니처를 적는 평범한 문서 작업으로도
  사고성 발화가 죽는다.**

## Scope
- `API_KEYS` 파싱·Bearer 헤더 추출을 `@sentinel/core`로 옮긴다. **이건 HTTP 지식이 아니라 문자열 파싱이다** —
  core에 두는 것이 의존 방향에 맞다.
- `packages/api`·`packages/mcp`가 그 하나를 쓰도록 바꾼다.
- **드리프트 감시기(`packages/mcp/src/auth.spec.ts`의 대조 테스트)를 회수한다.** 복제가 없어지면
  감시할 대상이 없다. 감시기를 남겨두면 항상 참인 죽은 테스트가 된다.

## Out of scope
- 인증 **정책** 변경 (401 무오라클 응답, 키→project 매핑 규칙은 그대로 유지한다)
- stdio 부팅 거부 동작 변경

## Acceptance
- [ ] `parseApiKeys`·`extractBearerKey`가 `@sentinel/core`에 **한 벌만** 존재한다(grep으로 판정)
- [ ] `packages/api`·`packages/mcp` 어디에도 복제본이 없고, 드리프트 감시기가 제거됐다
- [ ] **기존 인증 동작이 하나도 바뀌지 않았다** — 401 응답 4개 실패 모드의 바이트 동일성,
      키→project 매핑, 중복 키 거부, stdio 부팅 거부가 전부 그대로다(기존 테스트가 증인)
- [ ] `pnpm verify` 그린

## Context budget
- 읽기: specs/01, packages/{api,mcp,core}/src/auth*, packages/core/src/index.ts, eslint.config.js

## Findings (T-014에서 넘김)

- **`http.cli.ts`의 잔여 노출이 이 태스크에서 닫힌다.** `API_KEYS`가 형식 오류일 때 에러 메시지가
  원문 세그먼트를 싣는데, T-014에서는 고칠 수 없었다 — 그 텍스트가 `packages/api`에서 상속된 것이라
  드리프트 감시기가 문자 동일성을 강제했기 때문이다. **복제가 사라지면 양쪽을 함께 손볼 수 있다.**
  노출되는 것이 동작하는 자격증명이 아니라 잘못 입력한 설정 문자열이라 긴급하진 않지만, 닫을 수 있을 때 닫아라.
- **형제 간선 zone이 이미 있다**(T-014 신설). `mcp → api`를 다시 열어 해결하려 하면 lint가 막는다.
  그게 의도다 — 해법은 core로 올리는 것뿐이다.
- **`scripts/`는 zone의 target이 아니다.** `scripts/seed.cli.ts`가 `@sentinel/api`에서 `parseApiKeys`를
  import하고 있다. 옮기면 그쪽 import도 따라가야 한다 — **깨뜨리지 마라.**
