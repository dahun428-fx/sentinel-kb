# T-028: 포트폴리오 패키징
refs: 전체
M: M6 | deps: 전체

STATUS: PARTIAL — Acceptance 1·3 PASS, 2는 **재실행 가능하되 그릴 데이터가 0건**,
4(녹화)는 **미이행**. 판정 불가 항목을 통과로 적지 않았다. 근거는 아래 `## Findings`.

## Scope
- README 서사는 docs/portfolio/PORTFOLIO-WEAVE.md의 6단 구조(문제→결정→전환→사고→지표→재귀)를 따른다
- PR 본문의 결정 ID 참조(refs: ADR-x, 감사 x) 관례를 CONTRIBUTING에 명문화
- README: 문제 → 설계 결정 → 트레이드오프 → 지표 서사, 아키텍처·RAG 파이프라인 다이어그램
- eval 리포트 전/후 비교 그래프 (retrieval, tool-selection, generation)
- 루프 계측 회고: 자동 완결률, BLOCKED 사유 분포, "어떤 스펙 서술이 성공률을 올렸나"
- divergence 데이터 패턴 분석 글 초안
- 3분 데모 영상 스크립트: 서로 다른 프로젝트 2곳의 에이전트가 같은 지식으로 문제 해결

## Acceptance
- [x] README에 설계 결정 5개 이상이 트레이드오프와 함께 기술됨 — **9건**(§3)
- [~] eval 리포트 그래프 3종 생성 스크립트가 재실행 가능 — 스크립트는 돌지만 **리포트가 0건이라
      그릴 데이터가 없다.** 지어내지 않고 exit 78로 거절한다. F-1
- [x] 루프 계측 JSONL에서 지표가 산출되고 README에 인용됨 — 가드가 재계산해 대조한다
- [ ] 데모 시나리오가 실제로 재현됨(녹화) — **미이행.** 스크립트만 있다. F-2

## Context budget
- 읽기: eval/reports/**, specs/**, README.md

---

## 변경 파일

| 파일 | 무엇 |
| --- | --- |
| `README.md` | 전면 재작성. 6단 서사 + mermaid 3종 + 측정/미측정 분리 |
| `docs/portfolio/METRICS.md` | 신규 — 루프 계측 회고 |
| `docs/portfolio/DIVERGENCE-PATTERNS.md` | 신규 — divergence 10건 패턴 분석 초안 |
| `docs/portfolio/DEMO-SCRIPT.md` | 신규 — 3분 데모 + 재현 가능성 표 |
| `docs/CONTRIBUTING.md` | 신규 — 결정 ID 참조 관례 |
| `docs/DECISIONS-PENDING.md` | 갱신 — §2 해소 표시, §12·13 신설 |
| `docs/README.md` | 갱신 — 포트폴리오 절 추가 |
| `tools/portfolio-metrics.ts` | 신규 — 루프 지표 산출 + eval 시계열 + SVG 렌더 (순수 함수) |
| `tools/portfolio-report.cli.ts` | 신규 — 재실행 가능한 생성 스크립트 |
| `tools/portfolio-docs.spec.ts` | 신규 — 다이어그램·지표·미측정 가드 (23 테스트) |

`packages/**`는 건드리지 않았다.

---

## Findings

### F-1 ⚠️ Acceptance 2("eval 리포트 **전/후 비교** 그래프")는 전제가 성립하지 않는다

`eval/reports/`에는 `.gitkeep` 하나뿐이고 **리포트가 한 건도 없다.**
retrieval·tools·generation·injection 러너는 전부 자격증명이 없어 `exit 78`로 거절한다
(T-013 BLOCKED / T-016 BLOCKED / T-020 판정 불가 / T-021 F-3).

"전/후 비교"는 **최소 두 시점의 측정**을 요구하는데 시점이 0개다. 선택지는 셋이었다:

1. 그래프를 0으로 그린다 → **재서 0이 나온 것과 구별되지 않는다.** 이 태스크에서 가장 나쁜 선택.
2. Acceptance를 못 지킨다고만 적는다 → 스크립트가 없으면 자격증명이 열려도 아무것도 안 나온다.
3. **스크립트를 완성하되 데이터가 없으면 거절한다.** ← 택했다.

`tools/portfolio-report.cli.ts`는 루프 지표를 항상 내고, 그래프 3종은
**"측정된 리포트 0건 / 0점이 아니라 미측정이다"를 SVG에 그린 뒤 `exit 78`**로 끝난다.
`pnpm eval:tools`·`eval:generation`·`eval:injection`과 **같은 종료 코드**를 쓴 이유는
이 레포에서 78이 "잴 수 없으면 거절한다"의 정본 신호이기 때문이다.

가드가 양방향을 잠근다: 리포트 0건이면 실제 프로세스가 78로 죽는지, 픽스처 리포트 2건을 주면
**실제로 `<polyline>`을 그리는지**를 둘 다 단언한다. 거절 경로만 있는 스크립트가 아니다.

**판정: 재실행 가능 = PASS, 전/후 비교 = 판정 불가.** 통과로 적지 않는다.

### F-2 ⚠️ Acceptance 4(녹화)는 미이행이다 — 그리고 지금 찍으면 안 되는 장면이 있다

`docs/portfolio/DEMO-SCRIPT.md`를 썼으나 **녹화하지 않았다.** 그보다 중요한 발견:

데모의 핵심 장면(§3 "A는 '60초에 끊김', B는 '1분 뒤 끊깁니다' — 표현이 달라도 찾는다")은
**하이브리드 검색이 실제로 동작해야 성립한다.** 지금 `FakeEmbedder`는 서로 다른 텍스트 간
cosine ≈ 0이고(실측 평균 −0.00007), **벡터 경로를 융합에서 제거해도 통합 테스트 11개가 전부
통과한다.** 즉 지금 화면에 나오는 것은 하이브리드가 아니라 **BM25 단독**이다.

그것을 찍어 "하이브리드 검색"이라 부르면 이 레포가 내내 지킨 규칙을 데모에서 깨는 것이다.
스크립트 §4에 **단계별 재현 가능성 표**를 넣고, "아니오"인 단계를 찍지 말라는 지시를
녹화 체크리스트 마지막 항목으로 박았다.

지금 정직하게 찍히는 것: 로컬 compose, nginx 경유 MCP 연결·도구 5개(integration이 매번 확인),
SSE 청크 도착, 키가 `project`를 정한다, `record_knowledge` + `sanitizeFlags`.

### F-3 🚨 오케스트레이터 지시에 **이 레포에 존재하지 않는 수치**가 들어 있었다

태스크 착수 지시의 "측정된 것들" 목록에 **`T-026: nginx p95 43.34ms(로컬 스택)`**이 있었다.
쓰기 전에 대조했고, **레포 어디에도 없다:**

```
$ grep -rn "43\.34" --include="*.md" --include="*.ts" --include="*.json" .   → 0건
$ git grep -n "43\.34" $(git rev-list --all --max-count=200)                  → 0건
$ git grep -nE "p95[^0-9]{0,20}[0-9]+\.[0-9]+ ?ms" <모든 로컬 브랜치>          → 0건
```

`specs/tasks/T-026-compose-nginx.md`에는 **p95 수치가 아예 없다.** 그 파일이 p95에 대해 적은
것은 오히려 반대 방향이다 — F-10이 "autocannon의 백분위 집합에 **95가 없고**(실측),
p97.5를 p95라 적으면 **지어낸 수치**"라고 못박고 있다. 부하 스크립트(`tools/loadtest.ts`)는
nearest-rank로 p95를 내지만 **리포트가 커밋된 적이 없다.**

같은 지시의 "SSE 도착 분산"도 수치가 없다(도착시각 테스트는 초록/빨강으로만 보고된다).
`T-021 제외 18/18`도 레포 전체에서 0건이다 — 방어선 2는 "플래그된 청크 **전부 제외**,
프롬프트 도달 0"으로 **정성적으로만** 기록돼 있다.
`T-004 성능 178 → 97ms`도 정확하지 않다: 실측 쌍은 **183ms → 97ms**이고(포스트모템 §4.5,
폐기용 사본 A/B), `178ms`는 **낡은 주석과 실측의 괴리를 지적한 문장**에서 나온 수다(T-004:519).

**셋 다 README에 쓰지 않았다.** 기록해 두는 이유는 이것이 이 태스크의 실패 모드를 그대로
보여주기 때문이다 — **미측정 수치는 악의 없이, 인용의 인용을 거치며 들어온다.**
`tools/portfolio-docs.spec.ts`의 미측정 지표 가드가 이 경로를 기계로 막는다.

### F-4 다이어그램 가드는 산문이 아니라 **기계가 강제하는 규칙**에 댔다

의존 방향 다이어그램을 `specs/01`의 산문("`web/mcp/api → core → contracts`")에 대는 것도
가능했으나 그러지 않았다. **그 산문은 `worker`를 빠뜨리고 있다.** 대신
`eslint.config.js`의 `import/no-restricted-paths` zone을 파싱해 **금지 간선 21개**를 뽑고
다이어그램의 간선이 거기 하나도 걸리지 않는지 본다.

구현 중 실제로 방향을 뒤집어 잡았다 — `no-restricted-paths`에서 `target`은 **import하는 쪽**,
`from`은 **import당하면 안 되는 쪽**이라 금지 간선은 `target -> from`이다. 처음에 반대로 짰고
`web --> core`가 위반으로 잡히면서 드러났다. 그래서 파서 회귀 테스트에
`contracts->core`는 `true`, **`core->contracts`는 `false`**를 둘 다 박았다 —
방향이 다시 뒤집히면 가드가 정반대를 검사하게 되기 때문이다.

같은 이유로 "간선이 실제로 있다"를 따로 단언한다. **빈 그래프는 어떤 위반도 그리지 않아
공허하게 통과한다** — T-003·T-014의 자기충족 테스트와 같은 함정이다.

아키텍처 다이어그램은 `docker-compose.yml`의 서비스 6종에 양방향으로 댄다(빠뜨림도, 발명도 금지).
RAG 다이어그램이 인용한 파라미터 이름은 전부 `.env.example`에 실재해야 한다.
초기 구현에서 라벨 안의 `chunks[vector]`가 노드 id로 오인돼 실패했다 — 라벨 문자열을 먼저 지운다.

### F-5 README의 지표 표는 손으로 유지되지 않는다

`<!-- loop-metrics:begin/end -->` 블록은 `renderLoopMetricsTable()`의 출력과
**한 글자도 다르지 않아야** 한다. 가드가 `eval/loop-log.jsonl`에서 재계산해 비교하므로
**로그가 늘면 README가 낡고, 낡으면 `pnpm verify`가 빨개진다.**

자기충족이 아니다 — README는 정적 텍스트이고 가드는 원천에서 다시 계산한다.
같이 움직이는 경로가 없으므로 상수를 바꿔 통과시키는 길이 없다.

### F-6 "어떤 스펙 서술이 성공률을 올렸나"는 이 표본으로 **인과를 주장할 수 없다**

Scope가 요구한 항목이다. 로그에는 눈에 띄는 패턴이 있다 — **G5(스펙 정합) 실패 5건이 전부
`task-loop` budget 자동 포함 5항을 명문화하기 전에 있고, 이후 12개 태스크에서는 0건이다.**

그러나 같은 기간에 최소 셋이 함께 바뀌었다: 태스크 성격(기반 → 응용), 검증 프로토콜(축 인계 요구),
구현자가 읽는 파일 수(중앙값 11 → 18 이상). **25개 표본에서 이들을 가를 수 없다.**
README §6-1과 `docs/portfolio/METRICS.md` §4-1에 **관측된 공기(co-occurrence)로만** 적고
"인과로 읽지 마라"를 본문에 박았다.

대신 **메커니즘에 근거해 말할 수 있는 것 하나**를 적었다(METRICS §4-2):
T-004 포스트모템이 "Acceptance를 **케이스 수**로 쓰면 구현과 검증이 둘 다 그 수에 최적화된다"를
같은 파일 안의 대조군(비가시 문자 축)과 함께 논증했다. 이건 표본이 아니라 구조의 논증이다.

### F-7 로그의 상태 어휘가 규약 밖으로 샜다 (계측 결함 4건)

집계기가 기계로 잡은 것: `T-001`에 `planLines`·`filesRead`가 없고(2건),
`T-019`·`T-039`가 규약에 없는 `status: "done"`을 쓴다(2건).

**조용히 GREEN으로 접지 않고 `anomalies`에 실었다.** 접으면 그 불일치가 영영 안 보인다.
로그에 필드가 없어 기계가 못 잡는 것 셋(파일 STATUS와의 불일치 / budget 준수 여부 /
`approachChanges`)은 `docs/DECISIONS-PENDING.md` §12로 올렸다.

### F-8 `CLAUDE.md`가 안내하는 `pnpm eval`이 `package.json`에 없다 (범위 밖)

`CLAUDE.md` 명령어 절이 `pnpm eval        # RAG eval (retrieval + generation)`을 적고 있으나
`package.json`에는 `eval:retrieval`·`eval:generation`·`eval:tools`·`eval:injection`만 있고
`eval`은 없다. **문서가 없는 명령을 안내하는 축**(SELF-03·SELF-05와 같은 패턴)의 또 한 사례다.

`tools/connect-docs.spec.ts`가 `docs/connect.md`에 대해 하는 대조를 `CLAUDE.md`에도 걸면 잡힌다.
이 태스크의 범위(`README.md`·`docs/**`·`tools/`)가 `CLAUDE.md`와 `package.json`을
**수정 대상으로 열어 주지 않아** 손대지 않았다. README에는 실재하는 명령만 적었고,
그 사실은 새 가드가 `README.md`에 대해 강제한다.

### F-9 `eval/reports/`는 `.gitignore` 대상이라 이 스크립트의 산출물도 커밋되지 않는다

`docs/dogfooding.md` §4가 이미 지적한 것과 같은 자리다(T-024 F-3).
`tools/portfolio-report.cli.ts`의 기본 출력 위치가 거기이므로,
**시계열을 포트폴리오 자산으로 남기려면 커밋 정책이 따로 필요하다** —
감사 A-4가 "아티팩트는 90일 후 소멸한다"로 이미 같은 결론에 도달했고 nightly 워크플로에는
커밋 스텝이 붙었으나, 지금 리포트가 0건이라 **그 스텝이 커밋한 적이 없다.**

### F-10 `docs/portfolio/PORTFOLIO-WEAVE.md` 채널 4의 3부작 중 1편만 초안이 나왔다

`DIVERGENCE-PATTERNS.md`가 3편("이격 리포트")에 해당한다.
1편(SELF-01 케이스 스터디)과 2편("문서가 코드를 배신하는 세 가지 방식")은 쓰지 않았다 —
M7 파이프라인(T-029~T-034)의 소재이고, 그쪽이 아직 `GET /v1/articles`에서 막혀 있다(T-029 PARTIAL).
2편의 소재는 이미 `docs/dogfooding.md` §6이 클러스터로 뽑아 뒀다.

### F-11 `sanitize.property.spec.ts`의 성능 단언이 경계에 있다 — 부하에 따라 뒤집힌다

`pnpm verify`를 여러 번 돌리는 중 `sanitize — 프로퍼티 > 상한 크기 입력을 이메일 마스킹까지 켜고
선형 시간에 처리한다`가 **두 번 실패했다.** 한 번은 `expected 1212.06 to be less than 500`,
한 번은 5초 테스트 타임아웃이다. **같은 파일을 단독 실행하면 750ms로 통과**하고,
유닛 전체를 연속 3회 돌려도 전부 통과한다(그때 2,130–2,271ms).

이 태스크가 유닛에 **+23 테스트**를 얹었고 그중 하나가 자식 프로세스(`node --import tsx`)를
띄우므로 병렬 실행 중 CPU 경합을 조금 늘린다. 그래서 "무관하다"고 적지 않는다 —
**기여했을 수 있다.** 다만 원인은 그쪽이 아니라 단언 자체의 성질에 있다:
64KB 입력의 벽시계 시간을 절대값 500ms로 재는 단언은 **머신 부하에 종속**이고,
T-004 F-11이 남긴 `collectEdits` 이차 곡선이 그 아래 그대로 있다.

**테스트를 고치지 않았다.** 기준을 늘리거나 타임아웃을 키우는 것은 CLAUDE.md 원칙 4의 경계선이고,
이 단언은 실제 성능 회귀를 잡으라고 있는 것이다. 최종 `pnpm verify`는 **exit 0**이다
(unit 2,006 / integration 342 + 1 skipped). 관측만 기록하고 판단은 넘긴다 —
고친다면 방향은 "절대 벽시계"가 아니라 **입력 크기 대비 기울기**를 재는 쪽이어야 한다.

---

## 인간 비준 대기

1. **완결률의 정의** — `DECISIONS-PENDING` §13. 세 정의가 24.0% / 72.0% / 76.0%로 갈리고
   목표 70% 달성 여부가 뒤집힌다. **분모를 계측된 25개로 볼 것인가 백로그 41개로 볼 것인가**도 포함.
2. **루프 로그 규약 3건** — `DECISIONS-PENDING` §12.
3. **`eval/reports/` 커밋 정책** — F-9.
4. **`CLAUDE.md`의 `pnpm eval` 문면** — F-8. 스크립트를 만들 것인가, 문면을 고칠 것인가.
5. **데모 녹화 시점** — F-2. 임베딩 자격증명 이후로 미루는 것을 권고한다.
