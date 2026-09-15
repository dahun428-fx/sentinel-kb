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
- [ ] 위 8개 상수 각각에 대해 **현실적 드리프트 뮤턴트**(극단값 금지)를 주입하면 테스트가 죽는다.
      리포트에 **killer 파일:라인**을 상수별로 적을 것
- [ ] 뮤턴트 적용 시 `.env.example`을 **함께** 옮겨도 죽는다 (거울 대조만으로 통과하지 않음)
- [ ] 레지스트리의 근거 문장이 전부 실측과 일치한다
- [ ] 거울 대조만 있는 상수를 `BEHAVIOURALLY_ANCHORED`에 넣으면 래칫이 실패한다 (일부러 넣어 확인)
- [ ] `tools/assertion-audit.spec.ts` 그린, `pnpm verify` 그린

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
