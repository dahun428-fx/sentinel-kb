# T-043: assertion-audit 레지스트리 정정 + 거울 대조 확장
refs: specs/tasks/T-041-assertion-audit.md
M: M7 | deps: T-041

## 배경

T-041이 만든 `tools/assertion-audit.ts`의 `BEHAVIOURALLY_ANCHORED` 레지스트리는
각 항목에 "실측한 뮤턴트와 사망 건수"를 적어 **"주장이 아니라 관측"**이라고 선언한다.
감사 결과 **그 선언이 사실과 다르다 — killer를 확인하지 않았다.**

| 레지스트리 항목 | 적힌 근거 | 실측 |
|---|---|---|
| `RETRIEVAL_DEFAULTS` | "NUM_CANDIDATES 200→100 사망, MAX_CHUNKS 2→3 사망" | **행동이 아니다.** 200→100의 유일한 killer는 `config.spec.ts`의 **`.env.example` 거울 대조**. 2→3의 유일한 killer는 `no-hardcoded-params.spec.ts`가 `relation-expansion.ts`의 **무관한 리터럴 3과 우연히 충돌**한 것. **2→4는 아무것도 안 죽인다.** |
| `DEFAULT_MAX_INPUT_CHARS` | "상한 초과 입력이 실제로 던져야 한다" | **던지는 테스트가 죽인 게 아니다.** 유일한 killer는 `sanitize.property.spec.ts`의 **벽시계 `toBeLessThan(500)`** — 입력이 커져 느려진 것뿐. 65536→70000은 전건 생존. |
| `TARGET_RECORDS_4W` | "좌변이 픽스처에서 집계한 실수치다" | **픽스처가 아니다.** killer는 `tools/harvest-docs.spec.ts:161`의 `specs/00` **문서 거울 대조**. 지목된 픽스처 단언은 `TARGET_RECORDS_4W`번 도는 **자기충족 루프**라 안 죽는다. |
| `PIECE_MAX_CHARS` | "4000→**40** 사망" | **T-041이 경고한 극단값 착시 그 자체.** 4000→3000은 생존. |
| `DEFAULT_SERVER_SELECTION_TIMEOUT_MS` | "좌변이 드라이버에 실제로 넘어간 옵션이다" | **값을 보는 단언이 없다.** 5000→8000 생존. (단, "고정할 스펙이 없다"는 두 번째 문장은 참.) |
| `GENERATOR_DEFAULTS` | "0.62→0.40 사망 3건" | **참.** 0.62→0.55도 실제 게이트 판정으로 사망. |
| `LLM_DEFAULTS` | "8000→12000 사망" | **참, 그리고 올바른 형태.** killer가 `toBeLessThan(10_000)`이라 점이 아니라 **경계**를 잠근다. |

`LITERAL_ANCHOR_REQUIRED` 4건은 **전건 정확했다**(현실적 드리프트로 재확인). 건드리지 마라.

### 더 구조적인 결함 — 스캐너 사각지대

`scanImportedConstantAssertions`는 `expect(x).<matcher>(IMPORTED_IDENT)` 형태만 본다
(기대값 자리에 **맨 식별자**를 요구). 그런데 위에서 드러난 실제 관측 경로 대다수가 그 형태가 아니다:

```ts
// packages/core/src/retriever/config.spec.ts:111 — 안 잡힌다
expect(envExample).toContain(`\n${name}=${String(value)}\n`);
// tools/harvest-docs.spec.ts:161 — 안 잡힌다
expect(target).toContain(String(TARGET_RECORDS_4W));
```

> **자기충족의 단위는 상수 하나가 아니라 `{상수, 그 상수의 문서 거울}` 쌍이다.**
> `.env.example`에는 사람 승인 게이트가 없으므로, 상수와 `.env.example`을 **같은 커밋에서
> 옮기는 것**이 게이트를 통과하는 가장 싼 길이다 — T-041이 없애려던 형태가 한 층 위에서
> 그대로 재현된다. (`specs/00`을 거울로 쓰는 것은 스펙 개정이 인간 승인 사항이라 상대적으로 낫다.)

## Scope

1. **레지스트리 문장 정정.** 위 표의 5개 항목에서 **거짓 근거를 지운다.**
   각 상수마다 둘 중 하나를 고른다:
   - 진짜 행동 단언을 **추가**해서 `BEHAVIOURALLY_ANCHORED`를 참으로 만든다
   - 행동으로 잠글 수 없으면 `LITERAL_ANCHOR_REQUIRED`로 **옮기고** 리터럴 앵커를 단다
   어느 쪽이든 **근거란에는 실제로 확인한 killer 파일:라인을 적는다.**
2. **튜닝 상수 행동 단언.** 감사에서 생존한 것들:
   `RETRIEVAL_NUM_CANDIDATES`(200→150), `RETRIEVAL_FINAL_K`(8→6),
   `RETRIEVAL_VECTOR_K`(20→15), `RETRIEVAL_TEXT_K`(20→15), `RRF_K`(60→30),
   `RETRIEVAL_CANDIDATE_OVERFETCH`(4→5), `RETRIEVAL_MAX_CHUNKS_PER_RECORD`(2→4),
   `SANITIZE_MAX_INPUT_CHARS`(65536→70000).
3. **스캐너를 `{상수, 거울}` 쌍으로 확장.** `toContain`/템플릿 리터럴 안에 상수가
   보간되는 형태를 **거울 대조**로 분류해 별도로 센다. 거울 대조**만** 있는 상수는
   "행동으로 잠김"이 아님을 래칫이 판정해야 한다.

## Out of scope
- `LITERAL_ANCHOR_REQUIRED` 4건 (전건 정확 — 건드리지 마라)
- **`packages/core/src/sanitizer/sanitize.property.spec.ts`** — 벽시계 단언 경화는 T-045 몫
- 새 튜닝 상수 도입, 값 변경 (값은 그대로 두고 **잠그기만** 한다)

## Acceptance
- [x] 위 8개 상수 각각에 대해 **현실적 드리프트 뮤턴트**(극단값 금지)를 주입하면 테스트가 죽는다.
      리포트에 **killer 파일:라인**을 상수별로 적을 것
- [x] 뮤턴트 적용 시 `.env.example`을 **함께** 옮겨도 죽는다 (거울 대조만으로 통과하지 않음)
- [x] 레지스트리의 근거 문장이 전부 실측과 일치한다
- [x] 거울 대조만 있는 상수를 `BEHAVIOURALLY_ANCHORED`에 넣으면 래칫이 실패한다 (일부러 넣어 확인)
- [x] `tools/assertion-audit.spec.ts` 그린, `pnpm verify` 그린

## Context budget
- 읽기: `tools/assertion-audit.ts`, `tools/assertion-audit.spec.ts`,
  `specs/tasks/T-041-assertion-audit.md`, `packages/core/src/retriever/config.ts` + `config.spec.ts`,
  `packages/core/src/sanitizer/sanitize.ts`, `tools/no-hardcoded-params.spec.ts`,
  `tools/harvest-docs.spec.ts`, `.env.example`

## Findings (인계)

- **⚠️ 값을 바꿔서 테스트를 통과시키려는 유혹이 이 태스크에서 가장 강하다.** 상수 값은
  전부 그대로 둔다. 잠금 장치만 만든다. 값 변경은 즉시 중단 사유다(CLAUDE.md 4항).
- **`RETRIEVAL_MAX_CHUNKS_PER_RECORD=2`를 잠글 때 주의**: `no-hardcoded-params.spec.ts`에
  이미 `2 *`(retriever의 `toRawCosine`) 표현식 수준 예외가 있다. 그 예외를 넓히지 마라.
- **극단값 뮤턴트로 "죽었다"를 보고하지 마라.** T-041의 교훈이 정확히 이것이고,
  이 태스크는 그 교훈이 자기 자신에게 적용되지 않았던 것을 고치는 일이다.
- **동등 뮤턴트는 동등하다고 보고하라.** 억지로 결함으로 만들지 마라.
  `LLM_DEFAULTS` 8000→9999가 생존하면 그건 계약을 지키는 값이므로 정상이다.

## Findings (T-043 구현 세션)

### 감사 표는 전건 재현됐다 — 상수 값은 한 글자도 바꾸지 않았다

수정 **전** 실측(현실적 드리프트 + `.env.example` 동반 이동, 유닛 스위트 전체):

| 뮤턴트 | 전 | 수정 후 killer |
|---|---|---|
| `RETRIEVAL_VECTOR_K` 20→15 | **생존** | `packages/core/src/retriever/config.spec.ts:118` |
| `RETRIEVAL_TEXT_K` 20→15 | **생존** | 같은 자리 `:118` |
| `RETRIEVAL_FINAL_K` 8→6 | **생존** | 같은 자리 `:118` |
| `RRF_K` 60→30 | **생존** | 같은 자리 `:118` |
| `RETRIEVAL_NUM_CANDIDATES` 200→150 | **생존** | 같은 자리 `:118` |
| `RETRIEVAL_CANDIDATE_OVERFETCH` 4→5 | **생존** | 같은 자리 `:118` |
| `RETRIEVAL_MAX_CHUNKS_PER_RECORD` 2→4 | **생존** | 같은 자리 `:118` |
| `SANITIZE_MAX_INPUT_CHARS` 65536→70000 | **생존** | `packages/core/src/sanitizer/sanitize.spec.ts:775`, `:781` |
| `PIECE_MAX_CHARS` 4000→3000 | **생존** | `eval/style/corpus.spec.ts:77` |
| `DEFAULT_SERVER_SELECTION_TIMEOUT_MS` 5000→8000 | **생존** | `packages/core/src/db/client.spec.ts:88` |
| `TARGET_RECORDS_4W` 30→25 | 사망 1 — `tools/harvest-docs.spec.ts:161`(**문서 거울**) | `tools/dogfood-report.spec.ts:208` + 거울 그대로 |

레지스트리에 남긴 둘도 현실적 드리프트로 재확인했다: `GENERATOR_DEFAULTS` 0.62→**0.55**
사망 2(`generator/gate.spec.ts:21`, `generator/generate.spec.ts:71`),
`LLM_DEFAULTS` 8000→12000 사망 1(`llm/config.spec.ts:84`), 1→2 사망 1(같은 파일 `:88`).
나머지 넷(`EXPECTED_SCENARIO_COUNT` 20→18, `EXPECTED_CASE_COUNT` 15→14,
`EXPECTED_IRRELEVANT_COUNT` 5→4, `TEMPLATES_PER_KIND` 3→2)도 전건 사망 — 근거 문장이 참이다.

### F-1 동등 뮤턴트: `ANTHROPIC_TIMEOUT_MS` 8000→9000은 살아도 된다

killer가 `toBeLessThan(10_000)`이라 **점이 아니라 경계**를 잠근다. 9000은 계약 안의 값이므로
생존이 정상이고, 결함으로 만들지 않았다. 레지스트리에 그렇게 적었다.
이것이 이 레포에서 유일하게 **올바른 형태**의 행동 앵커다 — 나머지는 전부 점을 잠근다.

### F-2 ⚠️ `sanitize.property.spec.ts:753`의 벽시계 단언이 뮤테이션 측정을 오염시킨다

`RETRIEVAL_CANDIDATE_OVERFETCH`·`TARGET_RECORDS_4W`처럼 **새니타이저와 아무 관계도 없는**
뮤턴트에서도 산발적으로 죽었다(실측). 즉 T-041이 `DEFAULT_MAX_INPUT_CHARS`의 근거로 적은
"65536→131072 사망(1건)"은 상한을 잰 것이 아니라 이 단언이 부하로 넘어간 것이다.
**killer를 이름까지 읽지 않으면 이 오염을 건수로만 보고 놓친다.** T-045 몫이라 건드리지 않았고,
`pnpm verify` 1회차가 이것으로 깨졌으나 **무변경 트리에서도 같은 단언이 깨지는 것을 확인**했다
(515ms vs 500ms). T-034 note·A-1 note·T-028 F-11과 같은 현상이다.

### F-3 `RETRIEVAL_DEFAULTS` 앵커는 §6 스윕을 막지 않는다

T-041 F-5는 "바뀌라고 있는 값에 앵커를 박으면 eval 스윕이 막힌다"고 적었지만, **스윕은 env로
한다.** 앵커가 잠그는 것은 `readRetrievalConfig()`의 주입 경로가 아니라 **커밋된 기본값**이다.
그 구분을 관측 가능하게 만들려고 `config.spec.ts:129`에 "앵커가 eval 스윕을 막지 않는다"
테스트를 나란히 뒀다 — 일곱 파라미터를 전부 env로 덮어쓰는 단언이다.

### F-4 스캐너 확장은 `{상수, 거울}` 쌍을 보지만 **자기충족 좌변까지 잡지는 못한다**

`ConstantFinding.mirrorSites`가 `toContain`/`toMatch` 안의 보간을 따로 세고,
`for (const [name, value] of Object.entries(CONST))` 루프로 **루프 변수에 갈아탄** 형태까지
잡는다(`config.spec.ts:163`, `harvest-docs.spec.ts:161` 둘 다 잡힌다 — 태스크가 지목한 사각지대).
래칫 `mirrorOnlyBehaviourallyAnchored`는 **거울밖에 없는** 상수의 행동 주장만 막는다.
`RETRIEVAL_DEFAULTS`처럼 **자기충족 값 사이트 + 거울**인 조합은 기계가 가르지 못한다 —
좌변이 그 상수에서 파생됐는지를 알려면 타입·데이터흐름이 필요하다. 그 판정은 여전히 사람 몫이고,
레지스트리 근거란에 **killer 파일:라인을 적게 한 것**이 지금으로선 유일한 강제 장치다.

### F-5 거울 전용 상수 12종은 분류를 강제하지 않았다

`TARGET_HITS_4W`·`DOGFOOD_LOG_PATH`·`SSE_CONTENT_TYPE` 등 12종은 값 비교 사이트가 0이다.
전부 분류시키면 레지스트리가 두 배가 되는데 그것들은 애초에 "값이 얼마인가"를 다투지 않는다.
`unclassifiedConstants`는 값 사이트가 있는 상수만 본다(의도적 면제, 코드 주석에 근거 기재).
`TARGET_HITS_4W`는 `TARGET_RECORDS_4W`의 형제인데도 앵커를 달지 않았다 — 이 태스크 대상이
아니고, 새 래칫의 **실물 표본**으로 남겨 두는 편이 낫다고 판단했다. 다음 사람이 앵커를 달면
`assertion-audit.spec.ts`의 "거울 전용 상수가 실재한다" 테스트가 다른 상수를 가리켜야 한다.

### F-6 Context budget 밖 파일 3개를 **수정**했다

`tools/dogfood-report.spec.ts`·`eval/style/corpus.spec.ts`·`packages/core/src/db/client.spec.ts`.
budget의 "읽기" 목록에 없지만 Scope 1이 이 세 상수에 "리터럴 앵커를 단다"를 **명령**하므로
수정 없이는 Acceptance를 채울 수 없다. task-loop SKILL의 budget 자동 포함 3항
("태스크가 수정하는 코드의 기존 테스트 파일")에 해당한다고 보고 진행했다.
`sanitize.property.spec.ts`는 지시대로 손대지 않았다.

### F-7 ⚠️ 이 레포의 `*.spec.ts`는 prettier 규약을 따르지 않는다 — `--write`를 돌리지 마라

작업 중 `prettier --write`를 돌렸더니 **내가 건드리지 않은 기존 단언 블록들이 재포맷됐다**
(`sanitize.spec.ts`의 `LEAK_REGRESSIONS`·`OUTSIDE_STRICT` 표 등). `pnpm verify`는 prettier를
돌리지 않으므로(lint는 eslint-config-prettier로 포맷 규칙이 꺼져 있다) 그 상태가 정상이다.
전부 되돌렸고 최종 diff는 `git diff -U0 -- '*.spec.ts' | grep '^-'`가 공집합이다(T-041 A8 유지).
`specs/tasks/*.md`도 마찬가지다 — 이 파일의 표가 prettier 규약을 안 따른다.

### F-8 (부수 관측, 이 태스크 밖) main에 8521줄짜리 임시 파일이 커밋돼 있다

`...cal-command-caveatcaveat-the-messages-below.txt`. `109a2ee`~`9c7a386` 구간에서 들어왔다.
레포 산출물이 아니다. 별도 정리 감이다.
