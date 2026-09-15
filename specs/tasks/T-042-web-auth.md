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

## 결정 2 — 자격증명 전달은 base64다 (인간 승인 완료, 1차 BLOCKED 해소)

1차 구현이 BLOCKED로 멈췄다. compose에 `:?` 변수를 하나 넣는 순간 T-027 가드가
`infra/deploy/deploy.sh` 수정을 강제했는데 그 파일이 budget 밖이었고, 더 깊게는
`infra/deploy/deploy.sh:103-106`이 SSM→`.env` 렌더가 **개행 있는 값을 담지 못한다**고
스스로 적어 뒀다. htpasswd는 사용자가 둘 이상이면 여러 줄이다.

**해소: SSM에 htpasswd를 base64로 넣고 컨테이너 기동 시 디코딩해 파일로 쓴다.**

- (a) 기존 스칼라 경로(`--output text`)에 **그대로 얹힌다** — 개행 없는 단일 값이 된다.
- (b) 다중 사용자를 지금 포기하지 않는다. "단일 사용자 1줄" 안은 재설계를 미래로
  미루는 것이라 **기각됐다.**
- 디코딩은 `docker/nginx-entrypoint.d/10-render-htpasswd.sh`가 기동 시 한 번 한다.
  **디코딩 결과를 로그에 찍지 않는다** — 컨테이너 로그는 CloudWatch로, 배포 로그는
  SSM `get-command-invocation`을 거쳐 GH Actions로 간다. 새면 회수할 수 없다.

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
- [x] `pnpm verify` 그린

## Context budget
- 읽기: `nginx/**`, `docker-compose*.yml`, `specs/06`, `specs/00` NFR-04,
  `docs/analysis/RTM.md`, `.env.example`, `tools/compose-contract.int.spec.ts`,
  `tools/nginx-streaming.int.spec.ts`
- **읽기·수정 (2차 확장, 인간 승인):** `infra/deploy/deploy.sh`, `infra/variables.tf`,
  `docker/**`

  이 셋이 왜 필요한가 — **compose에 `:?` 변수를 추가하는 것은 배포 배선과 커플링돼 있다.**
  `tools/deploy-contract.spec.ts:162`가 "compose가 `:?`로 요구하는 env를 deploy.sh가 전부
  렌더한다"를 강제하고, `infra/variables.tf`의 `secure_parameter_names`는 deploy.sh의
  `SECURE_PARAMETERS`와 **글자 그대로 같아야** 한다(같은 파일 166행). 즉 compose 한 줄이
  세 파일을 동시에 움직인다. 1차 budget이 이 사슬을 빠뜨려 태스크가 BLOCKED로 멈췄다.
  `docker/**`는 자격증명을 파일로 쓰는 주체(엔트리포인트)가 거기 살기 때문이다.

  **일반화**: 앞으로 compose를 수정하는 태스크는 budget에 `infra/deploy/**`와
  `infra/variables.tf`를 기본 포함해야 한다.

## Findings (인계)

- **⚠️ `tools/compose-contract.int.spec.ts`·`nginx-streaming.int.spec.ts`는 docker 없는
  머신에서 skip된다**(감사 B §7: 72건 skip 중 27건이 이 둘). 즉 여기에만 단언을 두면
  로컬 verify는 **공허하게 통과**한다. **설정 파일을 직접 파싱하는 유닛 테스트를
  반드시 하나 두어라** — docker 없이도 죽어야 한다.
- **B-2(아티클 `project` 스코프 부재)는 이 태스크가 닫지 않는다.** basic auth를 통과한
  사용자는 여전히 남의 project 아티클을 발행할 수 있다. 별도 비준 대기 항목이다.
  **"인증을 넣었으니 NFR-04 충족"이라고 쓰지 마라** — 그건 절반이다.

## Findings (T-042 구현 중 발견)

- **F-1. Context budget이 `infra/deploy/**`를 빠뜨렸다 (1차를 막은 원인). → 해소됨.**
  compose에 `:?` 변수를 하나라도 추가하면 `tools/deploy-contract.spec.ts:162`가 즉시
  `infra/deploy/deploy.sh` 수정을 강제한다. "compose를 고치는 태스크"는 전부 이 커플링을
  밟는다. 2차에서 budget이 확장됐고, 일반 규약은 위 Context budget 절에 적었다
  (task-loop SKILL.md 5항 계열).
- **F-2. 엔트리포인트에 자격증명 가드가 없었다. → 이번에 닫았다.**
  `docker/nginx-entrypoint.d/10-render-htpasswd.sh`가 값 부재·base64 실패·형식 불일치
  세 경우에 각각 이름을 대고 exit 78로 죽는다. nginx의 500은 원인을 말하지 않는다.
  판정은 `tools/nginx-contract.spec.ts`가 **스크립트를 실제로 실행해서** 한다.
- **F-3. `docker/README.md` 미반영. → 이번에 닫았다.** 로컬 기동 절차에 자격증명 생성
  단계를, 구조 절에 `auth-basic.conf`와 엔트리포인트 표를 추가했다.
- **F-4. web `/` 인증은 Server Action의 CSRF를 다루지 않는다 — 단, 이건 미확인 항목이다.**
  1차 보고에서 "여전히 열려 있다"고 단정했는데 **근거가 없었다.** Next.js는 Server Action에
  대해 Origin/Host 대조를 기본 수행하므로 그 단정은 과대평가일 수 있다.
  **확인하지 않았다** — `packages/web`이 budget 밖이라 Next 버전도 `serverActions.allowedOrigins`
  설정도 보지 않았다. 확인하려면 (1) `packages/web/package.json`의 next 버전, (2)
  `next.config`의 해당 설정, (3) 교차 출처 POST 재현이 필요하다. 그 전까지 이 항목은
  **취약점이 아니라 미측정 항목**이다.
