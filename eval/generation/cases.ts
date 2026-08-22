/**
 * generation eval 케이스 로더. 출처: specs/05 "Eval 2: Generation", T-020 Scope.
 *
 * ## 케이스에 **정답 답변이 없다.** 의도적이다.
 * generation eval이 재는 것은 "답이 정답 문자열과 같은가"가 아니라 (a) 주장 문장이 실제
 * 컨텍스트에 묶여 있는가(자동 룰체크), (b) judge가 본 충실도·유용성이다. 정답 답변을 적어
 * 두면 그 문자열이 곧 프롬프트 튜닝의 표적이 되고, 골든셋이 오염된다(eval-runner 스킬).
 *
 * ## `kind: "irrelevant"` 다섯은 specs/05 Eval 2(c)다
 * "무관한 쿼리 5개 → 전부 `found:false`". **이 다섯은 답변을 기대하지 않는다** —
 * `found:true`가 나오면 그 자체가 실패이고, 인용 룰체크의 분모에도 들어가지 않는다.
 *
 * > 같은 성질의 판정을 T-019가 이미 `packages/api/src/answer.int.spec.ts`의
 * > "무관한 쿼리 (Acceptance 2)"에서 통합 테스트로 통과시켰다(fake 임베더로 cosine을 실제
 * > 계산해 게이트가 막는 것을 확인). 여기서 다시 두는 이유는 **재는 대상이 다르기** 때문이다:
 * > 그쪽은 fake 임베딩 위에서 "게이트 배선이 살아 있는가"를, 이쪽은 실 임베딩·실 코퍼스
 * > 위에서 "의미적으로 무관한 질의가 실제로 임계값에 걸리는가"를 잰다. 후자는 그 통합
 * > 테스트가 스스로 "판정하지 못한다"고 밝힌 바로 그 부분이다.
 */
import { readFileSync } from "node:fs";

import { z } from "zod";

import { CaseKind } from "./report.js";

/** specs/05는 개수를 정하지 않았다. 커밋된 파일의 실제 수와 다르면 리포트에 경고가 붙는다. */
export const EXPECTED_CASE_COUNT = 15;

/** specs/05 Eval 2(c)의 "무관한 쿼리 5개". 이 수가 줄면 경고가 붙는다. */
export const EXPECTED_IRRELEVANT_COUNT = 5;

export const GenerationCase = z
  .object({
    caseId: z.string().min(1),
    kind: CaseKind,
    query: z.string().min(2),
    boundary: z.string().min(1),
  })
  .strict();
export type GenerationCase = z.infer<typeof GenerationCase>;

const CasesFile = z.object({
  _comment: z.string().optional(),
  cases: z.array(GenerationCase).min(1),
});

export const CASES_PATH = "eval/generation/cases.json";
const CASES_URL = new URL("./cases.json", import.meta.url);

/** 케이스 파일을 못 읽거나 스키마를 어기면 던진다. CLI가 78로 옮긴다. */
export class CaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CaseError";
  }
}

export function loadCases(url: URL = CASES_URL): GenerationCase[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(url, "utf8"));
  } catch (error) {
    throw new CaseError(`${CASES_PATH}을 읽지 못했다: ${message(error)}`);
  }

  const result = CasesFile.safeParse(parsed);
  if (!result.success) {
    throw new CaseError(`${CASES_PATH}이 스키마를 어겼다: ${result.error.issues[0]?.message ?? ""}`);
  }

  const ids = result.data.cases.map((item) => item.caseId);
  const duplicated = ids.filter((id, index) => ids.indexOf(id) !== index);
  if (duplicated.length > 0) {
    // 중복 id는 리포트의 케이스 행을 서로 덮어써 "어느 쪽이 틀렸는지"를 지운다.
    throw new CaseError(`${CASES_PATH}에 중복 caseId가 있다: ${[...new Set(duplicated)].join(", ")}`);
  }
  return result.data.cases;
}

/** `irrelevant`는 답을 기대하지 않는다. 이 함수가 그 규칙의 유일한 정의다. */
export function expectsFound(item: GenerationCase): boolean {
  return item.kind === "grounded";
}

/**
 * 케이스 집합 자체의 건강 상태. **케이스를 고치지 않고 보고만 한다** —
 * eval-runner 스킬: "통과시키려고 골든셋·시나리오를 수정하는 것"이 금지 1항이다.
 */
export function caseWarnings(cases: readonly GenerationCase[], expected: number): string[] {
  const warnings: string[] = [];
  if (cases.length !== expected) {
    warnings.push(
      `케이스가 ${String(cases.length)}건이다(기대 ${String(expected)}건). ` +
        "지표는 잰 것 그대로이지만 과거 리포트와 분모가 다르다.",
    );
  }
  const irrelevant = cases.filter((item) => item.kind === "irrelevant").length;
  if (irrelevant !== EXPECTED_IRRELEVANT_COUNT) {
    warnings.push(
      `무관한 쿼리가 ${String(irrelevant)}건이다. specs/05 Eval 2(c)는 5건을 요구한다.`,
    );
  }
  return warnings;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
