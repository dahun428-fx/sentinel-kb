# T-042: web 표면 인증 (nginx basic auth)
refs: specs/00-product.md NFR-04, specs/06-deployment.md, specs/08-publishing.md §7
M: M6 | deps: T-026

## 배경

감사 B-1이 실측했다: `packages/web/src` 전체에 인증 관련 문자열이 **0건**이다.

```
$ grep -rln "Authorization|getServerSession|requireAuth|middleware" packages/web/src
(빈 출력)
```

`nginx/snippets/routes.conf:47`이 `/` → `web:3000`을 무조건 통과시키고,
`specs/06:7`이 SG를 443 전체 개방으로 둔다. 웹은 서버 사이드 단일 키
(`packages/web/src/lib/env.ts:20` `CORE_API_KEY`)로 core-api를 호출한다.

귀결 — 도메인에 도달하는 **누구나** 전 프로젝트 레코드를 열람하고
**아티클을 편집·발행**할 수 있다(`packages/web/src/app/articles/actions.ts:43,77`).

`actions.ts:73`의 주석은 "**사람이 이 버튼을 눌러야만 실행된다**"고 쓴다. 그건 사실이다.
다만 강제되는 것은 "사람이 눌렀다"이지 "**권한 있는** 사람이 눌렀다"가 아니다.
specs/08 §7의 "사람 승인"이 승인자 무관 상태로 구현돼 있다.

`docs/analysis/RTM.md:19`는 NFR-04의 검증 수단을 "T-007, T-014 | 인증 테스트"로 적었는데
둘 다 HTTP·MCP 표면이다. **web 표면은 NFR-04 검증 대상에서 통째로 빠져 있다.**

## 결정 (인간 승인 완료)

**nginx basic auth**로 닫는다. 코드 변경이 최소이고 web 전체가 한 번에 닫힌다.
다른 세 갈래(Next middleware 세션 / specs/00에 예외 명문화 / 쓰기만 닫기)는 기각됐다.

**이 방식의 한계를 숨기지 마라**: basic auth는 **프로젝트별 키를 구분하지 못한다.**
NFR-04의 "프로젝트별 키"는 web 표면에서 **부분 충족**이다.
그 한계를 `specs/06`에 명시하는 것이 이 태스크의 산출물에 포함된다.

## Scope
- `nginx/`: `/` location에 basic auth 적용. `.htpasswd` 경로는 환경변수/마운트로 주입.
- **`/health`는 인증 밖에 남긴다** — 모니터가 닿아야 한다. `routes.conf:34-44` 참조.
- `.env.example`·compose: htpasswd 파일 주입 경로 추가. **시크릿 하드코딩 금지**(CLAUDE.md).
- `specs/06-deployment.md`: 라우팅표에 인증 열 추가 + "프로젝트별 키 미구분" 한계 명시.
- `docs/analysis/RTM.md`: NFR-04 검증란에 web 표면 행 추가.
- 계약 테스트: nginx 설정을 파싱해 `/`가 auth 뒤에 있고 `/health`가 앞에 있음을 단언.

## Out of scope
- Next.js middleware / 세션 / OAuth
- 프로젝트별 키 구분 (basic auth로는 불가 — 별도 태스크)
- `specs/00` NFR-04 문면 변경 (부분 충족을 specs/06에 적는 것으로 갈음)

## Acceptance
- [ ] nginx 설정상 `/`, `/records`, `/articles`가 인증을 요구한다 (설정 파싱 테스트)
- [ ] `/health`는 인증 없이 도달 가능함을 단언
- [ ] htpasswd 내용이 레포에 **없다** (`.env.example`에도 실값 금지)
- [ ] `specs/06`에 "프로젝트별 키 미구분"이 명시돼 있다
- [ ] `pnpm verify` 그린

## Context budget
- 읽기: `nginx/**`, `docker-compose*.yml`, `specs/06`, `specs/00` NFR-04,
  `docs/analysis/RTM.md`, `.env.example`, `tools/compose-contract.int.spec.ts`,
  `tools/nginx-streaming.int.spec.ts`

## Findings (인계)

- **⚠️ `tools/compose-contract.int.spec.ts`·`nginx-streaming.int.spec.ts`는 docker 없는
  머신에서 skip된다**(감사 B §7: 72건 skip 중 27건이 이 둘). 즉 여기에만 단언을 두면
  로컬 verify는 **공허하게 통과**한다. **설정 파일을 직접 파싱하는 유닛 테스트를
  반드시 하나 두어라** — docker 없이도 죽어야 한다.
- **B-2(아티클 `project` 스코프 부재)는 이 태스크가 닫지 않는다.** basic auth를 통과한
  사용자는 여전히 남의 project 아티클을 발행할 수 있다. 별도 비준 대기 항목이다.
  **"인증을 넣었으니 NFR-04 충족"이라고 쓰지 마라** — 그건 절반이다.
