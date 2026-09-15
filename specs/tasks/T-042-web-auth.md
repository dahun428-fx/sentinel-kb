STATUS: BLOCKED
사유: compose가 `WEB_BASIC_AUTH_FILE:?`를 요구하는 순간 T-027 가드가 `infra/deploy/deploy.sh`
수정을 강제한다 — Context budget에도 Scope에도 없는 파일이다.

실패 로그:
```
FAIL |unit| tools/deploy-contract.spec.ts
  > compose 가 `:?` 로 요구하는 env 를 deploy.sh 가 전부 렌더한다 (T-027 F-4)
  > `WEB_BASIC_AUTH_FILE` 가 .env 로 렌더된다
AssertionError: WEB_BASIC_AUTH_FILE 을 deploy.sh 가 렌더하지 않는다: expected false to be true
  ❯ tools/deploy-contract.spec.ts:163:66
```

필요한 결정: **프로덕션에서 htpasswd "내용"을 무엇이 배달하는가.**

- Scope는 compose·`.env.example`의 "htpasswd 파일 **주입 경로**"까지만 연다. 그런데 경로를
  주입하는 순간 그 경로에 **파일을 놓는 주체**가 필요해지고, 그건 `infra/deploy/deploy.sh`다
  (+ 목록 동치를 강제하는 `infra/variables.tf`). 둘 다 Scope·budget 밖이다.
- 게다가 `infra/deploy/deploy.sh:103-106`이 SSM→.env 렌더 방식의 한계를 스스로 적어 뒀다:
  "개행이 필요한 시크릿(예: PEM)이 생기면 이 방식으로는 안 되고 **그때 다시 설계해야 한다**."
  htpasswd는 사용자가 둘 이상이면 여러 줄이다 — 기존 전달 경로에 그대로 얹히지 않는다.
- 사람이 답해야 할 것:
  (a) web 자격증명을 **단일 사용자 1줄**로 못박고 SecureString `WEB_HTPASSWD` 하나를 추가한다
      → `infra/deploy/deploy.sh` + `infra/variables.tf` 수정 승인이 필요하다. 또는
  (b) 다중 사용자를 지원하려 전달 경로를 다시 설계한다 → 별도 태스크다.
- ⚠️ `:?`를 `:-`(조용한 기본값)으로 바꾸면 가드는 침묵하고 `pnpm verify`는 초록이 된다.
  **그건 해결이 아니다.** 프로덕션에 파일이 없는 채로 배포가 통과하고, `/`는 열리는 게 아니라
  500으로 죽는다. 가드가 옳게 울고 있어서 끈 것이 아니라 멈춘 것이다.

진행 상태: nginx·compose·specs/06·RTM·계약 테스트는 구현 완료(브랜치 `feat/T-042-web-auth`).
Acceptance 1~4는 충족, 5(`pnpm verify` 그린)만 위 한 건으로 빨갛다.

---

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
- [x] nginx 설정상 `/`, `/records`, `/articles`가 인증을 요구한다 (설정 파싱 테스트)
- [x] `/health`는 인증 없이 도달 가능함을 단언
- [x] htpasswd 내용이 레포에 **없다** (`.env.example`에도 실값 금지)
- [x] `specs/06`에 "프로젝트별 키 미구분"이 명시돼 있다
- [ ] `pnpm verify` 그린 ← **BLOCKED** (위 STATUS 참조)

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

## Findings (T-042 구현 중 발견, 스코프 밖)

- **F-1. Context budget이 `infra/deploy/**`를 빠뜨렸다 (이 태스크를 막은 원인).**
  compose에 `:?` 변수를 하나라도 추가하면 `tools/deploy-contract.spec.ts`가 즉시
  `infra/deploy/deploy.sh` 수정을 강제한다. "compose를 고치는 태스크"는 전부 이 커플링을
  밟는다. 태스크 생성 규약에 "compose 수정 시 `infra/deploy/**`·`infra/variables.tf`를
  budget에 포함"을 넣는 것이 근본 조치다 (task-loop SKILL.md 5항 계열).
- **F-2. `docker/nginx-entrypoint.d/`에 htpasswd 존재 가드가 없다.** 파일이 없으면 nginx는
  `/`에 500을 낸다(닫히는 방향이라 안전은 하다). `20-select-server-conf.sh`가
  `DOMAIN_NAME`에 대해 하는 것처럼 exit 78로 원인을 말하고 죽는 편이 낫다.
  Acceptance에 없어 넣지 않았다 — `docker/**`는 budget 밖이다.
- **F-3. `docker/README.md`에 새 마운트(`/etc/nginx/secrets/htpasswd`)가 반영되지 않았다.**
  budget 밖이라 손대지 않았다.
- **F-4. web `/` 인증은 Next.js 서버 액션의 CSRF/오리진 검증을 대체하지 않는다.**
  basic auth 뒤에 있는 사용자의 브라우저는 자격증명을 자동 첨부하므로, `/articles`의
  발행 액션은 여전히 "인증된 사용자의 의도치 않은 요청"에 열려 있다. B-2와 함께
  볼 항목이다.
