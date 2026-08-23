# T-041: 자기충족 단언 감사

refs: specs/05 (CI·Eval 1·2·3), specs/00 (NFR-01·NFR-03·성공 지표), specs/03 §2·§5·§6,
specs/tasks/T-003-mongo-bootstrap.md, specs/tasks/T-014-mcp-skeleton.md,
specs/tasks/T-031-writing-pipeline.md, specs/tasks/T-039-llm-provider.md
M: M7 | deps: T-031

## 배경

**단언이 자기가 고정해야 할 상수를 기대값으로 쓰면, 그 상수를 바꾸는 것이 게이트를 통과하는
가장 싼 길이 된다.** 테스트는 초록인 채로 계약만 사라진다.

이 레포에서 같은 형태가 **세 번** 게이트를 무력화했고, 셋 다 **뮤테이션을 돌렸기 때문에**
드러났다. 돌리지 않았으면 지금도 통과하고 있을 것이다.

| 사건 | 형태 | 결과 |
|---|---|---|
| T-003 | 인덱스 테스트가 `DB_INDEX_SPECS`를 기대값으로 사용 | `jobs.createdAt: 1 → -1`(LIFO 기아) 뮤턴트가 테스트 3개를 전부 통과 |
| T-014 | 도구 상한 테스트가 `MAX_TOOLS`를 기대값으로 사용 | `MAX_TOOLS = 999`로 올리면 게이트 통과 |
| T-031 | `expect(model.calls).toHaveLength(1 + MAX_REWRITES)` | 재작성 상한 무시 뮤턴트가 **생존** |

세 번 반복됐다는 것은 개별 실수가 아니라 **형태**라는 뜻이다. 이 태스크는 그 형태를
레포 전체에서 전수 조사하고, 재발을 기계가 잡게 만든다.

## 판정 기준 — 상수를 기대값으로 쓰는 것이 항상 결함은 아니다

`toHaveLength(DIM)`에서 `DIM`이 **테스트 파일 안에서 정의된 픽스처**면 자기충족이 아니다.
입력과 기대값이 같은 것뿐이고, 리터럴로 바꿔도 잡히는 것이 늘지 않는다.
**가짜 양성을 고치면 노이즈만 는다.**

한 사이트가 **진짜 결함**이려면 넷을 **전부** 만족해야 한다.

1. **C1 (외부 출처)** 기대값이 **구현·하네스 코드에서 import한** 상수다.
   테스트 파일 안의 픽스처(`*.fixture.ts` 포함)는 해당 없다.
2. **C2 (크기이지 이름이 아니다)** 그 상수가 **수치 한도·임계값·개수**이고,
   그 값 자체가 단언이 고정해야 할 대상이다.
   판별 태그(에러 코드 문자열·게이트 결과 열거·라우트명·메시지 본문·클래스 참조)는 제외한다 —
   그런 단언의 주어는 "값이 얼마인가"가 아니라 **"어느 분기를 탔는가"**이고,
   철자를 리터럴로 박아도 계약이 더 잠기지 않는다.
3. **C3 (스펙이 정한 값)** 스펙 또는 태스크 스펙이 **그 리터럴을 문면에 적었다**.
   즉 상수가 바뀌면 계약 위반이다. `specs/03 §6`이 "env로 스윕한다"고 선언한
   튜닝 파라미터는 해당 없다 — 바뀌라고 있는 값이다.
4. **C4 (앵커 부재)** 그 상수를 리터럴에 묶는 단언이 스위트 어디에도 없다.

C2는 이 태스크가 원래 제안에 더한 조건이다. 이것 없이 C1·C3·C4만 쓰면 판별 태그
약 60개 사이트가 전부 결함으로 잡히는데, 그것들은 고쳐도 뮤턴트가 하나도 더 죽지 않는다.

## Scope

- `packages/**`·`eval/**`·`tools/**`의 **모든** `*.spec.ts`에서 import한 상수를 기대값으로 쓰는
  단언 사이트를 전수 수집하고, 위 4조건으로 진짜/가짜를 가른다
- 진짜로 판정된 각 상수에 **리터럴 계약 앵커 단언을 추가**한다.
  T-014·T-031의 선례를 따른다 — 기대값을 리터럴로 박고, 상수가 그 리터럴과 같은지를
  **별도 단언**으로 고정한다. 상수를 바꾸면 **두 테스트가 죽는다**(하나는 행동, 하나는 계약).
- 각 앵커에 **근거 스펙 조항**을 테스트 이름 또는 주석으로 남긴다
- 재발을 잡는 **자동 가드**를 만든다: 스캐너 + 명시 분류 레지스트리 래칫

## Out of scope

- **기존 단언 수정·삭제.** 이 태스크는 테스트를 **강화**한다. 추가만 한다.
- 상수 **값** 변경 — 값이 틀렸다는 판정은 이 태스크가 하지 않는다
- 가짜 양성 "정리" — C2·C3에 걸린 사이트는 손대지 않는다
- 구현 코드 수정 (`*.spec.ts`와 새 가드 파일 외)
- T-003·T-014·T-031의 이미 고쳐진 사이트 재작업

## Acceptance

전부 명령어로 판정 가능하다.

- [x] **A1 전수 스캔이 코드로 있다.** `tools/assertion-audit.ts`가 `*.spec.ts`를 읽어
      (a) import한 상수를 기대값으로 쓰는 사이트와 (b) 그 상수의 리터럴 앵커 유무를 돌려준다.
      판정: `pnpm test -- assertion-audit` 그린
- [x] **A2 분류가 코드로 있고 빠짐이 없다.** 스캔이 찾은 모든 상수가
      `SPEC_PINNED_CONSTANTS`(스펙 조항 인용 포함) 또는 `SYMBOLIC_CONSTANTS`(제외 사유 포함)
      **둘 중 정확히 하나**에 있다. 어느 쪽에도 없는 상수가 하나라도 생기면 실패한다.
      판정: 같은 스위트
- [x] **A3 앵커 부재가 0이다.** `SPEC_PINNED_CONSTANTS`의 모든 항목에 리터럴 앵커 단언이
      실재한다. 판정: 같은 스위트
- [x] **A4 NFR-03 토큰 예산이 잠긴다.** `MCP_SEARCH_TOKEN_BUDGET`이 800임을 리터럴로
      단언한다(specs/00 NFR-03). 판정: `pnpm test -- format.spec` 그린
- [x] **A5 생성 게이트 임계값이 잠긴다.** `GENERATOR_DEFAULTS.SIMILARITY_THRESHOLD`가 0.62임을
      리터럴로 단언한다(specs/03 §5). 판정: `pnpm test -- generator/config` 그린
- [x] **A6 검색 파라미터 중 스펙이 문면에 박은 둘이 잠긴다.**
      `RETRIEVAL_NUM_CANDIDATES=200`(specs/03 §2), `RETRIEVAL_MAX_CHUNKS_PER_RECORD=2`(같은 절).
      나머지 다섯은 §6의 스윕 대상이므로 **잠그지 않는다**. 판정: `pnpm test -- retriever/config` 그린
- [x] **A7 나머지 스펙 고정 상수가 잠긴다.** `DEFAULT_MAX_INPUT_CHARS`·`ANTHROPIC_TIMEOUT_MS`·
      `ANTHROPIC_MAX_RETRIES`·`EXPECTED_SCENARIO_COUNT`·`EXPECTED_IRRELEVANT_COUNT`·
      `TEMPLATES_PER_KIND`·`TARGET_RECORDS_4W`·`NFR01_SEARCH_P95_MS`.
      판정: `pnpm test` 그린 + A2·A3
- [x] **A8 무약화.** 기존 단언이 **하나도 지워지거나 바뀌지 않았다**.
      판정: `git diff -U0 -- '*.spec.ts' | grep '^-' | grep -v '^---'` 가 비어 있다
- [x] **A9 뮤테이션 증명.** 진짜로 판정한 각 상수마다, 값을 바꾼 뮤턴트가
      **고치기 전에는 통과하고 고친 뒤에는 죽는다**. 리포트에 전/후 표를 싣는다.
- [x] **A10** `pnpm verify` 그린

## Context budget

- 읽기: `packages/**/*.spec.ts`·`eval/**/*.spec.ts`·`tools/*.spec.ts`(스캐너가 기계적으로 읽는다),
  그중 진짜로 판정된 상수의 **정의 파일만**, `specs/00`·`specs/03`·`specs/05`,
  `specs/tasks/T-004`·`T-007`·`T-031`·`T-039`(리터럴 출처 확인용)
- 이 태스크는 성질상 레포 전체 grep이 **필요하다.** 단, 읽기는 스캐너가 하고
  사람이 여는 파일은 위로 한정한다.

## 검증 프로토콜

- **뮤테이션이 유일한 증거다.** 이 태스크가 고치는 결함의 정의 자체가
  "뮤턴트가 생존한다"이므로, 뮤턴트를 돌리지 않은 수정은 수정이 아니다.
- 각 상수마다 **전(前) 통과 / 후(後) 사망**을 둘 다 관측한다.
  전에 이미 죽었다면 그 상수는 가짜 양성이므로 **되돌린다**.

## Findings (T-041 구현 세션)

### 판정 결과 — 후보 104 사이트 / 37 상수 → **진짜 2건, 가짜 35건**

| 단계 | 수 |
|---|---|
| 기대값이 식별자인 단언 사이트 | 241 |
| 그중 테스트 내부 픽스처(C1 탈락) | 135 |
| import한 상수를 기대값으로 쓰는 사이트 | 104 (상수 37종) |
| C2(판별 태그) 탈락 | 19종 |
| C3·C4 탈락 (스펙 미고정 / 이미 앵커됨 / 행동으로 잠김) | 16종 |
| **진짜 결함** | **2종** |

### F-1 ⚠️ **진짜 결함 2건은 둘 다 `specs/00`의 NFR 상한이었다**

우연이 아니다. NFR 상한은 성질상 `expect(측정값).toBeLessThanOrEqual(상한)` 꼴로 쓰이고,
이 형태는 **상한을 올리면 무조건 통과한다**. 반면 개수·임계값은 좌변이 실데이터라
상수만 바꾸면 죽는다. **자기충족이 되는 것은 "한도"이지 "값"이 아니다.**

1. **`MCP_SEARCH_TOKEN_BUDGET = 800`** (`packages/mcp/src/tools/format.ts:179`) — NFR-03.
   단언 12개가 전부 `toBeLessThanOrEqual(MCP_SEARCH_TOKEN_BUDGET)`다.
   `CLAUDE.md` 금지 사항이 명시적으로 지키라는 예산인데 **테스트가 지키지 않고 있었다.**
2. **`NFR01_SEARCH_P95_MS = 1500`** (`tools/loadtest.ts:18`) — NFR-01.
   `buildReport`가 이 상수로 `report.thresholdMs`를 채우고 단언이 그 둘을 비교한다 —
   **양변이 같은 상수에서 나온다.** 600000(10분)으로 올려도 546건이 전건 통과했다.

### F-2 ❌ **태스크가 지목한 1순위는 가짜 양성이었다 — 이미 올바르게 고쳐져 있다**

`relation-expansion.spec.ts:292`의 `toHaveLength(MAX_RELATION_CHUNKS)`에
"리터럴 앵커가 없다"는 전제가 사실이 아니었다. 같은 `describe` 바로 위 279행에

```
it("specs/03 §2.5의 상한은 3이다", () => { expect(MAX_RELATION_CHUNKS).toBe(3); });
```

가 있고, 293행에는 `toEqual(["c1","c2","c3"])`라는 **행동 앵커**까지 있다.
실측: `MAX_RELATION_CHUNKS` 3 → 10 뮤턴트가 **3건을 죽인다**(계약 1 + 행동 2).
T-035가 이미 T-014·T-031의 선례를 정확히 따랐다. **고치지 않았다** — 고쳤다면 노이즈만 늘었다.

### F-3 ⚠️ 지목된 나머지 후보도 전부 가짜였다. **그러나 이유가 제각각이다**

| 후보 | 판정 | 근거 |
|---|---|---|
| `retrieve.int.spec.ts:557` `CONFIG.maxChunksPerRecord` | 가짜 | 2→3 뮤턴트 사망(2건). 좌변이 실제 dedupe 결과다 |
| `config.spec.ts:75` `RETRIEVAL_MAX_CHUNKS_PER_RECORD` | 가짜 | 같은 뮤턴트가 잡는다 |
| `llm/config.spec.ts:79,119` `ANTHROPIC_MAX_RETRIES` | 가짜 | 1→2 뮤턴트 사망(1건). 주입 `fetch`가 실제 시도 횟수를 센다(T-039 A7) |
| `sanitize.spec.ts:750-772` `DEFAULT_MAX_INPUT_CHARS` | 가짜 | 65536→131072 사망(1건). 상한 초과 입력이 실제로 던져야 한다 |
| `embedder/{fake,voyage}.spec.ts` `toHaveLength(DIM)` | 가짜 | `DIM = 16`이 **테스트 파일 12행에 정의**돼 있고 `createFakeEmbedder({dim: DIM})`의 **입력**이다. C1 탈락 — 태스크가 예상한 그대로다 |

### F-4 ⚠️ 스펙 공백 — `PROMPT_TOKEN_BUDGET`은 **잠글 수 없었다**

`packages/mcp/src/prompts/index.ts:54`의 `PROMPT_TOKEN_BUDGET = 4000`은 F-1의 둘과
**형태가 완전히 같다**(`toBeLessThanOrEqual`, 자기충족). 그런데 잠그지 않았다:
`specs/07 §Prompts`도 `T-038` Acceptance도 **기호만 참조하고 숫자를 정하지 않았다.**

여기서 4000을 리터럴로 박으면 **없는 계약을 내가 만드는 것**이고, 그건
`CLAUDE.md` 최우선 원칙 1("코드와 스펙이 어긋나면 스펙을 먼저 고친다 — 인간 승인 필요")의 반대다.
→ **스펙에 숫자를 넣는 결정이 먼저다.** 그때까지 `BEHAVIOURALLY_ANCHORED`가 아니라
사유를 적어 분류만 해 뒀다. 다음 사람이 이 문단을 근거로 스펙을 고치면 한 줄로 잠긴다.

### F-5 `specs/03 §6`이 가짜 양성의 절반을 설명한다

`RETRIEVAL_DEFAULTS`의 일곱 값 중 잠글 수 있는 것은 **둘뿐**이다.
§2가 문면에 박은 `numCandidates=200`과 "record당 최대 2청크"가 그것이고,
나머지 다섯(`VECTOR_K`·`TEXT_K`·`FINAL_K`·`RRF_K`·`CANDIDATE_OVERFETCH`)은
§6이 **"전부 env에서 주입, eval에서 스윕하기 위함"**이라고 선언한 튜닝 파라미터다.
**바뀌라고 있는 값에 앵커를 박으면 eval 스윕이 막힌다.** C3이 이 구분을 한다.
(둘 다 실측으로는 이미 행동에 잠겨 있어 이번에 추가 앵커는 넣지 않았다.)

### 자동 가드 판단 — **ESLint 규칙은 무리, 래칫 테스트는 만들었다**

**ESLint 규칙을 만들지 않은 이유는 실측이다.** "import한 상수를 기대값으로 쓰지 마라"는
규칙은 후보 104개 중 **98개가 오탐**이다(오탐률 94%). 그 규칙은 억제 주석 98개를 낳고
그 다음부터 아무도 읽지 않는다 — T-004 포스트모템이 말한 fail-open과 같은 구조다.
"수치형 상수만"으로 좁혀도 타입 정보 없이는 `GATE_OUTCOMES.X`와 `LLM_DEFAULTS.X`를 못 가른다.

대신 **분류 래칫**을 만들었다(`tools/assertion-audit.ts` + `.spec.ts`).
스캐너가 후보를 모으고, 모든 상수가 세 레지스트리 중 **정확히 하나**에 사유와 함께
있어야 그린이다. 판정은 사람이 하되 **빠뜨릴 수는 없다.**

- 새 `spec.ts`가 상수를 기대값으로 쓰면 → 미분류로 **빌드가 깨진다**
- 누가 계약 앵커를 지우면 → `missingLiteralAnchors`가 **잡는다**(실측: 앵커 제거 뮤턴트 사망)

이 가드의 값은 T-003·T-014·T-031이 **각자 뮤테이션을 돌렸기 때문에만** 발견됐다는 사실에 있다.
래칫은 그 발견을 다음 사람의 성실성에 맡기지 않는다.

### 뮤테이션 표 (관측 경로: `npx vitest run --project unit --project integration <경로>`)

**전(前) = 이 태스크의 수정 이전, 후(後) = 이후.** 생존이 결함의 정의다.

| # | 뮤턴트 | 전 | 후 | 판정 |
|---|---|---|---|---|
| M1 | `MCP_SEARCH_TOKEN_BUDGET` 800 → **1200** | **생존** (276 전건 통과) | 사망 (1) | ✅ 진짜 → 고침 |
| M2 | `MCP_SEARCH_TOKEN_BUDGET` 800 → 999999 | 사망 (1) — 예산 재분배 테스트가 우연히 잡음 | 사망 (2) | 상한 드리프트는 M1이 봐야 한다 |
| M3 | `NFR01_SEARCH_P95_MS` 1500 → **2000** | **생존** (546 전건 통과) | 사망 (1) | ✅ 진짜 → 고침 |
| M4 | `NFR01_SEARCH_P95_MS` 1500 → **600000** | **생존** (546 전건 통과) | 사망 (1) | ✅ 같은 자리 |
| M5 | `MAX_RELATION_CHUNKS` 3 → 10 | 사망 (3) | — | ❌ 가짜 (F-2) |
| M6 | `SIMILARITY_THRESHOLD` 0.62 → 0.40 | 사망 (3) | — | ❌ 가짜 |
| M7 | `SIMILARITY_THRESHOLD` 0.62 → −1 | 사망 (11) | — | ❌ 가짜 |
| M8 | `RETRIEVAL_NUM_CANDIDATES` 200 → 100 | 사망 (1) | — | ❌ 가짜 |
| M9 | `RETRIEVAL_MAX_CHUNKS_PER_RECORD` 2 → 3 | 사망 (2) | — | ❌ 가짜 |
| M10 | `DEFAULT_MAX_INPUT_CHARS` 65536 → 131072 | 사망 (1) | — | ❌ 가짜 |
| M11 | `ANTHROPIC_TIMEOUT_MS` 8000 → 12000 | 사망 (1) | — | ❌ 가짜 |
| M12 | `ANTHROPIC_MAX_RETRIES` 1 → 2 | 사망 (1) | — | ❌ 가짜 |
| M13 | `EXPECTED_SCENARIO_COUNT` 20 → 3 | 사망 (2) | — | ❌ 가짜 |
| M14 | `EXPECTED_IRRELEVANT_COUNT` 5 → 1 | 사망 (2) | — | ❌ 가짜 |
| M15 | `TEMPLATES_PER_KIND` 3 → 1 | 사망 (2) | — | ❌ 가짜 |
| M16 | `TARGET_RECORDS_4W` 30 → 25 | 사망 (1) | — | ❌ 가짜 |
| M17 | 계약 앵커 `expect(MCP_SEARCH_TOKEN_BUDGET).toBe(800)` 삭제 | — | 사망 (1) | 가드가 앵커 삭제를 잡는다 |

M2가 이 태스크의 방법론적 교훈이다. **극단값 뮤턴트만 돌렸으면 M1을 놓쳤다** —
999999에서는 죽고 1200에서는 살기 때문이다. 상한 상수는 **현실적 드리프트**로 재야 한다.

### 미탐색 축

- **`toContain`·`toMatch`·`toThrow` 계열은 스캔하지 않았다.** 값 비교가 아니라 성질이 달라
  같은 기준을 적용할 수 없다. 자기충족이 가능한지는 미확인이다.
- **간접 자기충족**: 기대값이 상수 자체가 아니라 상수에서 **계산된 지역 변수**인 경우
  (`const limit = MAX * 2` 후 `toBe(limit)`)는 스캐너가 못 본다. 실측하지 않았다.
- **`packages/web`의 Playwright 스위트**(`test:e2e`)는 `pnpm verify` 밖이라 스캔 대상에서 뺐다.

### F-6 (부수 관측, 이 태스크 밖) 통합 테스트 1건이 전체 실행에서만 깨진다

`packages/core/src/db/search-indexes.int.spec.ts`의
"meta.project filter가 실제로 걸러낸다"가 `pnpm verify` 첫 실행에서 실패했다
(`expected [] to deeply equal ['bizcare-web']`). 단독 실행 2회·전체 재실행 2회는 전건 그린이다.
Atlas Search 인덱스가 READY를 보고한 뒤에도 색인이 따라오지 않는 **전형적인 최종 일관성 경합**으로
보인다. 이 태스크의 변경과 무관하다(건드린 파일이 겹치지 않는다). 별도 태스크 감이다.
