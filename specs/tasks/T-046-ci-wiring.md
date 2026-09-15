# T-046: CI 배선 복구 + 파생 문서 재동기화
refs: specs/05-test-strategy.md, specs/06-deployment.md
M: M6 | deps: -

## 배경

### 1. `nightly-eval.yml`은 한 번도 동작한 적이 없다

```yaml
      - run: pnpm eval:retrieval        # 시크릿 없음 → 78 → 잡 즉시 실패
      - run: pnpm eval:generation       # 도달 못 함
      - run: pnpm eval:tools            # 도달 못 함
      - run: pnpm eval:injection
        env:                            # ← env 가 이 스텝 하나에만 붙어 있다
          MONGODB_URI: ${{ secrets.MONGODB_TEST_URI }}
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

YAML `env:`는 **그 스텝 하나**에만 적용된다. 앞 세 스텝이 자격증명 없이 돌아 78로 죽고
잡은 거기서 끝난다. 추가로 **`VOYAGE_API_KEY`는 파일 어디에도 없고**(retrieval이 요구한다),
**`eval:style`은 목록에 아예 없다**.

그리고 커밋 스텝:
```yaml
git add eval/reports/    # .gitignore:23 `eval/reports/*` 에 걸려 아무것도 추가되지 않는다
```
`git ls-files eval/reports` → `.gitkeep` 하나뿐. 주석이 선언한
*"리포트 시계열은 포트폴리오 자산이므로 저장소에 커밋한다"*는 **성립한 적이 없다.**

**`.github/workflows/` 중 테스트가 있는 것은 `deploy.yml` 하나뿐**이다
(`tools/deploy-contract.spec.ts:31`). `ci.yml`과 `nightly-eval.yml`은 **어떤 단언도 보지 않는다.**
그래서 이 결함들이 아무에게도 안 보였다.

### 2. `pnpm test:e2e`가 존재하지 않는다

CLAUDE.md가 문서화하고 `packages/web/e2e/{read-path,article-path}.spec.ts`가 실재하는데
루트 `package.json`에 스크립트가 없고, 어느 CI 잡도 playwright를 돌리지 않는다.

### 3. 파생 문서가 상류를 앞지른다

- `docs/portfolio/METRICS.md` §2가 **"완결률의 정의가 스펙에 없다"**고 말한다 — 이제 거짓이다
  (`specs/00`에 공식 정의가 들어갔다, 커밋 `9439cf6`).
- `docs/DECISIONS-PENDING.md`:
  - §6이 `limit` 근거로 인용하는 토큰 표는 `format.ts:17-30`이 **"2.6배 틀린 추정기 위의 값이라
    철회했다"**고 명시적으로 폐기한 수치다. **등록부가 철회된 근거로 미결 항목을 서술한다.**
  - §10의 두 고아(`/v1/openapi.json`, `postmortem-interview`)는 **해소됐는데 미해소로 남아 있다.**
  - §12가 인용하는 수치가 T-028 시절 값이다(백로그 41 / 로그 25 → 실제 42 / 28).
- `tools/*.ts` 4개가 베이스에서 이미 `prettier --check`에 걸린다. `pnpm verify`에 prettier가 없다.

## Scope
- `nightly-eval.yml`: `env:`를 **잡 레벨**로 올리고 `VOYAGE_API_KEY` 추가, `eval:style` 스텝 추가.
- **워크플로 계약 테스트**: `deploy-contract.spec.ts`의 선례를 따라
  `nightly-eval.yml`·`ci.yml`을 파싱해 단언한다. 최소한 —
  eval 스텝이 요구하는 환경변수가 **그 스텝에서 실제로 보이는 스코프**에 있는지.
- `package.json`: `test:e2e` 스크립트 추가 (CLAUDE.md 문면과 일치시킨다).
- `docs/portfolio/METRICS.md` §2 정정, `docs/DECISIONS-PENDING.md` §6·§10·§12 재동기화.
- `pnpm verify`에 prettier 편입 여부 판단 + 근거 기록 (편입한다면 `tools/*.ts` 4개 포맷).

## Out of scope
- **`.gitignore:23` vs `specs/05:33` 충돌 해소 — 인간 비준 대기 항목이다.**
  `.gitignore`도 `specs/05`도 고치지 마라. 커밋 스텝이 무력하다는 **사실만** 워크플로 주석과
  Findings에 남기고, 어느 쪽으로 갈지는 사람이 정한다.
- eval 기준선·러너 로직 (78 거절 설계는 감사가 **정직하다고 판정**했다 — 건드리지 마라)
- E2E 테스트 자체를 CI에 넣는 것 (스크립트만 만든다. 브라우저 러너는 별도 결정)
- `DECISIONS-PENDING.md`에 **신규 항목 등재** (비준 목록 정리는 별도)

## Acceptance
- [ ] `nightly-eval.yml`의 모든 eval 스텝이 필요한 시크릿을 **보는 스코프**에 있다
- [ ] 그 사실을 단언하는 테스트가 있고, `env:`를 스텝 레벨로 되돌리면 **죽는다** (뮤테이션 확인)
- [ ] `pnpm test:e2e`가 존재하고 실행 가능하다 (브라우저 부재 시 명확히 실패해도 됨 —
      **조용히 0을 내지는 않아야 한다**)
- [ ] `METRICS.md` §2에 "정의가 없다"는 문장이 남아 있지 않다
- [ ] `DECISIONS-PENDING.md` §10의 해소된 두 항목이 닫혀 있고, §6이 철회된 수치를 인용하지 않는다
- [ ] `pnpm verify` 그린

## Context budget
- 읽기: `.github/workflows/**`, `tools/deploy-contract.spec.ts`, `package.json`,
  `docs/portfolio/METRICS.md`, `docs/DECISIONS-PENDING.md`,
  `packages/mcp/src/tools/format.ts` 헤더(철회 근거), `specs/05`, `.gitignore`,
  `packages/web/e2e/**`

## Findings (인계)

- **⚠️ 시크릿 실값을 워크플로에 쓰지 마라.** `${{ secrets.* }}` 참조만 쓴다 (CLAUDE.md 금지사항).
  **어느 시크릿이 필요한지 이름을 적는 것은 괜찮다** — 값이 문제다.
- **`ci.yml`이 `REQUIRE_DOCKER: "1"`로 integration skip을 하드 실패로 승격하는 설계는 옳다.**
  건드리지 마라. 다만 그 잡 자체를 검증하는 테스트가 없다는 것이 이 태스크의 대상이다.
- `git push`가 들어 있는 스텝을 다룬다. **실제로 푸시를 실행하지 마라** — 파일만 고친다.
- **`.gitignore` 충돌을 "겸사겸사" 고치고 싶어질 것이다. 하지 마라.** 그건 specs/05가 요구하는
  것을 레포 설정이 차단하는 **스펙 대 설정 모순**이고, 어느 쪽을 접을지는 사람이 정한다.

## Findings (구현 후 — T-046)

### F-1. `pnpm verify`에 prettier를 **넣지 않았다** (Scope의 판단 항목)

Scope는 "편입한다면 `tools/*.ts` 4개 포맷"을 전제했는데 **전제가 틀렸다.**
`pnpm exec prettier --check .`의 실제 결과는 **291개 파일**이다(`tools/` 밑만 13개,
나머지는 `specs/**`·`docs/**`·`packages/**` 전반). 편입하면 이 태스크의 diff가 291파일
리포맷이 되고, 그건 **CI 배선 복구라는 이 PR의 판정 가능성을 통째로 파괴한다.**

더 구체적인 위험이 하나 있다. 이 레포의 계약 테스트들은 **워크플로·스크립트의 문자열을
그대로 대조한다** — 예를 들어 `deploy-contract.spec.ts:493`은
`expect(deployWorkflow).toContain('curl -fsS --max-time 20 --retry 5 --retry-delay 5 \\')`다.
전면 리포맷은 이런 단언을 무작위로 깨뜨리고, 그 시점에 구현자는 **가드를 통과시키려고
단언을 고치는** 자리에 서게 된다. 정확히 `deploy-contract.spec.ts`의 `stripShellComments`
주석이 경고하는 실패 양식이다.

**권고**: prettier 편입은 `--write` 전면 적용 + 계약 테스트 재검을 하는 **독립 태스크**여야
한다. 이 PR에서는 `pnpm format`이 수동 경로로 남는다. 새 파일
`tools/workflow-contract.spec.ts`는 기존 `tools/*.spec.ts`의 서식 관행에 맞춰 썼다.

### F-2. env 스코프를 고쳐도 nightly는 **아직 아무것도 재지 못한다** (별도 태스크)

이 태스크는 "자격증명이 스텝에 보이는가"를 닫았다. 그 **다음** 벽이 셋 남아 있다:

1. **`eval:retrieval`·`eval:generation`은 살아 있는 core-api를 요구한다.** 둘 다 HTTP로
   `EVAL_CORE_API_URL`(기본 `localhost:3001`)에 질의하는데 **워크플로가 아무것도 띄우지
   않는다.** 자격증명이 다 있어도 EX_UNAVAILABLE(69)로 끝난다. compose 기동 + `db:seed` +
   `db:search-indexes`가 선행돼야 하고, 그건 배선이 아니라 **잡 설계**다.
2. **`eval:style`은 기준선이 없다.** `eval/baselines.json`에 `style` 키가 없어
   BASELINE_MISSING → 78이다. 러너 서두가 설명하듯 **그 거절이 옳다**(기준선 없이 낸 판별
   정확도는 고장 난 실행일수록 좋게 나온다). 기준선을 쓰는 것은 사람의 몫이다.
3. **잡이 fail-fast다.** 한 eval이 죽으면 뒤의 eval도 `upload-artifact`도 실행되지 않는다.
   `if: ${{ !cancelled() }}`를 붙이면 다섯을 전부 돌리고 리포트를 보존할 수 있지만, Scope가
   "env 승격 · VOYAGE 추가 · style 추가" 셋으로 못박혀 있어 **손대지 않았다.**

즉 **nightly가 초록이 되는 것은 이 PR의 Acceptance가 아니다.** 이 PR이 바꾼 것은
"배선이 틀려서 못 잰다"가 "자격증명·환경이 없어서 못 잰다"로 **사유가 이동한 것**이고,
그 이동은 A-1이 T-016에서 한 것과 같은 종류의 진전이다.

### F-3. `.gitignore:23` vs `specs/05:33` — **고치지 않았다** (인간 비준 대기)

`specs/05:33`은 `eval/reports/YYYY-MM-DD-retrieval.json` 커밋을 요구하는데
`.gitignore:23`의 `eval/reports/*`가 그것을 차단한다. 그래서 워크플로의 `git add
eval/reports/`는 **언제나 빈 스테이지를 만들고**, `git diff --cached --quiet`가 참이 되어
커밋도 푸시도 일어나지 않는다. `git ls-files eval/reports` → `.gitkeep` 하나뿐.
워크플로 주석이 선언한 "리포트 시계열은 포트폴리오 자산"은 **성립한 적이 없다.**

지시대로 **어느 쪽도 고치지 않았다.** 대신 둘을 했다:
- 워크플로 주석에 무력하다는 사실과 그 이유를 적었다(다음 사람이 배선 버그로 오해하지 않게).
- `workflow-contract.spec.ts`가 **모순이 아직 있다는 사실 자체를 고정한다.** 한쪽이 바뀌면
  그 테스트가 빨개지고, 그때 테스트를 지우면 된다.

**필요한 결정**: `.gitignore`를 열 것인가(리포트가 레포에 쌓인다), 아니면 `specs/05`의 커밋
요구를 접고 `upload-artifact` 보존(기본 90일)으로 갈 것인가. 후자를 고르면 "시계열"은
포기된다.

### F-4. `sanitize.property.spec.ts`의 벽시계 단언이 부하에서 흔들린다

`pnpm verify` 1회차에서 "상한 크기 입력을 선형 시간에 처리한다"가 995ms > 500ms로 실패했고,
단독 실행에서는 1,048ms 걸리고도 통과했다(측정 방식이 다르다). 2회차 verify는 그린.
**T-045가 등재된 바로 그 현상**이라 고치지 않고 기록만 한다. 이 태스크의 변경과 무관하다.

### F-5. `docs/portfolio/METRICS.md`의 H1이 "28줄"이라고 말한다

로그는 이 PR 이후 **32줄 / 태스크 29건**이다(작성 당시엔 31줄 / 28건이었다).
"28"은 그때의 태스크 수와는 맞고 줄 수와는 틀렸으며, 이제는 둘 다와 틀리다.
제목 문구라 기계 대조 대상이 아니고 Acceptance에도 없어 **건드리지 않았다.**
§6-1 표처럼 기계가 재계산하는 자리가 아니면 이런 수는 계속 낡는다.
