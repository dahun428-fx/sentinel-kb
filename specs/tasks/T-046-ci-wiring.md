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
