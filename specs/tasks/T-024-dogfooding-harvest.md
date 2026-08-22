# T-024: 도그푸딩 연결 + /harvest 커맨드
refs: CLAUDE.md 도그푸딩 프로토콜, specs/07
M: M5 | deps: T-017

## Scope
- `.claude/commands/harvest.md`: 최근 divergence 레코드를 조회해 패턴을 뽑고,
  CLAUDE.md·스킬 수정 **태스크 스펙 초안**을 `specs/tasks/`에 생성
- 주 1회 실행 루틴 문서화
- 도그푸딩 계측: 주별 기록 건수·검색 적중 건수를 `eval/reports/dogfood-{week}.json`으로 집계

## Out of scope
- 자동 CLAUDE.md 수정 (초안 생성까지만, 적용은 사람 승인)

## Acceptance
- [ ] /harvest 실행 시 divergence 5건 이상 입력에서 태스크 초안 1개 이상 생성
- [ ] 생성된 초안이 태스크 스펙 포맷(Scope/Acceptance/Context budget) 준수
- [ ] 집계 스크립트가 주간 리포트 JSON 출력
- [ ] `pnpm verify` 그린

## Context budget
- 읽기: CLAUDE.md, .claude/commands/**, specs/tasks/README.md

## Findings

- **F-1 (Acceptance 1은 판정 불가).** MCP 서버가 배포돼 있지 않아 `search_knowledge`를 부를 수
  없다. "divergence 5건 이상 입력에서 초안 1개 이상 생성"은 실행으로 판정되지 않았고, 지어내지
  않았다. 기계로 확인한 것은 **입력 조건**뿐이다 — 시드의 divergence가 10건이고
  (`tools/harvest-docs.spec.ts`가 5건 이상을 단언), 그중 3건(SELF-03·SELF-05·DIV-01)이 커맨드
  §3의 기준으로 실제 클러스터를 이룬다는 것까지. 초안 생성 자체는 미판정.
- **F-2 (`pnpm dogfood:report` 별칭 미추가).** 루트 `package.json` 수정을 피했다 — 이 태스크의
  작업 범위가 `.claude/`·`docs/`·`specs/tasks/T-024-*`·`tools/`로 한정됐고 병렬 브랜치가 같은
  파일을 건드리고 있다. 문서는 `pnpm exec tsx tools/dogfood-report.cli.ts`로 안내한다.
  별칭 추가는 별건으로 다룬다.
- **F-3 (리포트 보존 정책이 세 문서에서 어긋난다).** `.gitignore`는 `eval/reports/*`를 무시하고,
  `.claude/skills/eval-runner/SKILL.md`는 "리포트는 커밋한다 — 시계열이 곧 포트폴리오 자산"이라
  적었으며, `packages/core/seed/self/SELF-04.json`은 "보존 기간 있는 저장 수단에 장기 자산을
  두지 않는다"를 교정으로 남겼다. 셋이 서로 다른 말을 한다. 도그푸딩 리포트도 같은 처지다.
  **이것이 정확히 `/harvest`가 잡아야 할 종류의 이격이다** — 이번 태스크에서 고치지 않았다.
- **F-4 (`spec-drift-check.sh`가 빌드를 막지 않는다).** `.github/workflows/ci.yml:33`이
  `./scripts/spec-drift-check.sh || echo "::warning::…"`로 부른다. SELF-05의 `correction`은
  "CI로 상시 검사한다"인데 경고는 상시 검사가 아니다. `docs/dogfooding.md` §6이 이것을 워크드
  예시의 "부분 적용" 근거로 인용하고, 가드가 이 상태를 잠갔다 — 고쳐지는 날 가드가 빨개진다.
- **F-5 (성공 지표의 "적중"이 정의되지 않았다).** `specs/00-product.md`의 지표 행은 4주에
  기록 30건·적중 5건만 적고 적중이 무엇인지 말하지 않는다. 이 태스크는 FR-07을 근거로
  `give_feedback(helped: true)`로 해석했다 — "결과가 돌아온 검색"으로 읽으면 기록 30건에
  적중 5건이라는 비율이 성립하지 않기 때문이다. 리포트는 두 값을 모두 싣되 목표 판정은
  `hits`로 한다. 스펙에 정의 한 문장이 필요하다.
- **F-6 (`eval/reports/.gitkeep`을 새로 만들었다).** `.gitignore`에 `!eval/reports/.gitkeep`
  예외가 이미 있는데 정작 파일이 없어 디렉터리가 존재하지 않았다. 문서가 그 경로를 인용하므로 채웠다.
- **F-7 (자기 사건 — divergence 후보).** 뮤테이션 실험에서 `git checkout -- <파일>`로 뮤테이션을
  되돌렸는데, 그 파일이 **아직 커밋되지 않은 작업분**을 담고 있어 이번 태스크의 재작성이 통째로
  날아갔다(`.claude/commands/harvest.md`). 게다가 같은 실행의 뒤 11개 뮤테이션 결과가 전부
  오염됐다 — 첫 복원 실패가 남긴 상태를 다음 뮤테이션들이 물려받아 같은 단언에서 죽었고,
  표면상 "전건 KILLED"로 보였다. 교정: **뮤테이션 테스트는 커밋 이후에만 한다.** 추적되지 않는
  파일에 `git checkout`은 복원 수단이 아니고, 매 뮤테이션은 직전 결과가 아니라 기준선에서 시작한다.
- **F-8 (초안 템플릿의 사소한 모양 차이).** prettier가 템플릿의 `# T-0xx:` 다음에 빈 줄을 넣어
  실제 태스크 스펙(2행이 `refs:`)과 한 줄 어긋난다. 가드가 잠근 세 헤딩은 동일하다.
- **F-9 (뮤테이션 생존 1건을 보강했다).** 초안 템플릿에서 `harvested-from:` 줄만 지운 뮤테이션이
  가드를 통과했다 — 가드가 파일 **전체**에서 그 문자열을 찾고 있었고, 커맨드 §4 산문이 같은
  문자열을 언급하기 때문이다. "산문이 언급한다"와 "템플릿이 그 줄을 갖는다"는 다른 일이다.
  ` ```markdown ` 펜스 안쪽만 보도록 좁히고 `## 근거` 절까지 함께 잠갔다. 재적용 시 전건 사망.
