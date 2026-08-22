/**
 * 골든셋 **로더**. 출처: specs/05 "골든셋: query 30개 × 정답 recordIds (`eval_cases`, 사람 승인분만)".
 *
 * ## ⚠️ 이 파일에는 골든셋 **데이터**가 없다. 의도적이다.
 * T-013 스펙의 `## ⚠️ 착수 전 결정 필요`가 그 이유를 적어 두었다:
 * `scripts/seed.ts`가 `POST /v1/records`로 시드를 넣으므로 **`--reset`을 돌릴 때마다 전 레코드의
 * ObjectId가 새로 발급된다.** 골든셋은 `expectedRecordIds: ObjectId[]`로 정답을 지목하므로
 * 30건을 지금 만들면 다음 `--reset` 한 번에 통째로 죽는다. 해소 수단은 `RecordSchema`에
 * 안정적 시드 마커(`seedBatch`)를 넣는 것뿐이고, contracts가 `.strict()`라 **인간 승인(G3)**이다.
 *
 * 그래서 이 태스크는 **로더와 스키마만** 만든다. 결정이 내려지고 자격증명이 들어오면
 * `eval_cases`에 30건을 넣는 것만으로 러너가 그대로 돈다.
 *
 * ## 승인된 케이스만 읽는다
 * 필터는 `@sentinel/api`의 `APPROVED_EVAL_CASE_FILTER`를 **그대로 쓴다**. 같은 조건을 여기 다시
 * 적으면 두 개의 "골든셋 정의"가 생기고, `/v1/feedback`이 만드는 미승인 후보가 언젠가
 * 한쪽으로만 새어 들어온다. specs/02: "eval_cases는 사람 승인 없이 자동 추가 금지".
 *
 * 필터에 더해 **문서마다 contracts의 `EvalCaseSchema`로 다시 파싱한다.** 그 스키마는
 * `approvedBy: z.literal("human")`이라 승인 표식이 없는 문서는 여기서 죽는다 — 컬렉션에
 * 손으로 넣은 이상한 문서가 조용히 지표에 섞이는 경로를 닫는다.
 */
import { APPROVED_EVAL_CASE_FILTER, evalCasesCollection, type EvalCaseDocument } from "@sentinel/api";
import { EvalCaseSchema } from "@sentinel/contracts";
import type { Db } from "mongodb";

import { classifyQueryKind, type QueryKind } from "./query-kind.js";

/** specs/05의 "query 30개". 실제 케이스 수가 다르면 리포트에 경고가 붙는다(막지는 않는다). */
export const EXPECTED_GOLDEN_SET_SIZE = 30;

/** 러너가 소비하는 형상. contracts의 케이스 + 유도된 질의 종류. */
export interface GoldenCase {
  readonly caseId: string;
  readonly query: string;
  readonly expectedRecordIds: readonly string[];
  readonly type?: EvalCaseSchema["type"];
  /** 질의 텍스트에서 유도한다. 저장된 필드가 아니다 — `query-kind.ts` 참조. */
  readonly queryKind: QueryKind;
}

/**
 * DB 문서 → 골든셋 케이스. **ObjectId ↔ 24자 hex 변환은 DB 경계의 책임**이라는
 * specs/02 규약을 그대로 따른다(`packages/core/src/db/records.ts`와 같은 방향).
 */
export function toGoldenCase(document: EvalCaseDocument): GoldenCase {
  const parsed = EvalCaseSchema.parse({
    _id: document._id.toHexString(),
    query: document.query,
    expectedRecordIds: document.expectedRecordIds.map((id) => id.toHexString()),
    ...(document.type === undefined ? {} : { type: document.type }),
    ...(document.note === undefined ? {} : { note: document.note }),
    approvedBy: document.approvedBy,
  });
  return {
    caseId: parsed._id,
    query: parsed.query,
    expectedRecordIds: parsed.expectedRecordIds,
    ...(parsed.type === undefined ? {} : { type: parsed.type }),
    queryKind: classifyQueryKind(parsed.query),
  };
}

/**
 * 승인된 골든셋 전부. `_id` 오름차순으로 고정한다 — 리포트의 `cases[]` 순서가 실행마다
 * 달라지면 커밋된 리포트끼리의 diff가 읽히지 않는다.
 */
export async function loadGoldenSet(db: Db): Promise<GoldenCase[]> {
  const documents = await evalCasesCollection(db)
    .find(APPROVED_EVAL_CASE_FILTER)
    .sort({ _id: 1 })
    .toArray();
  return documents.map(toGoldenCase);
}

/**
 * 골든셋 자체의 건강 상태. **케이스를 고치지 않고 보고만 한다** —
 * eval-runner 스킬: "통과시키려고 골든셋을 수정하는 것"이 금지 1항이다.
 */
export function goldenSetWarnings(
  cases: readonly GoldenCase[],
  expectedSize: number = EXPECTED_GOLDEN_SET_SIZE,
): string[] {
  const warnings: string[] = [];
  if (cases.length === 0) {
    warnings.push(
      `eval_cases에 approvedBy:"human"인 케이스가 0건이다. 골든셋 ${String(expectedSize)}건은 ` +
        "아직 작성되지 않았다 — T-013의 `⚠️ 착수 전 결정 필요`(seedBatch 마커, G3)가 선행 조건이다.",
    );
  } else if (cases.length !== expectedSize) {
    warnings.push(
      `골든셋이 ${String(cases.length)}건이다. specs/05는 ${String(expectedSize)}건을 요구한다.`,
    );
  }

  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const goldenCase of cases) {
    if (seen.has(goldenCase.query)) duplicates.add(goldenCase.query);
    seen.add(goldenCase.query);
  }
  if (duplicates.size > 0) {
    warnings.push(
      `같은 query가 여러 케이스에 있다(${String(duplicates.size)}건). 가중치가 조용히 커진다.`,
    );
  }

  const koreanProse = cases.filter((item) => item.queryKind === "korean-prose").length;
  const identifier = cases.filter((item) => item.queryKind === "identifier").length;
  if (cases.length > 0 && (koreanProse === 0 || identifier === 0)) {
    warnings.push(
      `질의 종류가 한쪽으로 쏠려 있다(korean-prose=${String(koreanProse)}, identifier=${String(identifier)}). ` +
        "한 종류만으로는 lucene.standard의 한국어 손실(T-010 F-6)을 분해해 볼 수 없다.",
    );
  }
  return warnings;
}
