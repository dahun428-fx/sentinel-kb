/**
 * `/v1/feedback` 라우트와 그 저장 경로. 출처: specs/04-api.md 표, specs/02-data-model.md
 * (feedbacks / eval_cases), specs/00 FR-07.
 *
 * 검증은 **contracts의 `FeedbackRequest`로만** 한다 — 타입도 제약도 여기서 다시 정의하지 않는다(CLAUDE.md).
 * 이 파일이 하는 일은 계약이 표현하지 못하는 **서버 소유 규칙**뿐이다:
 *   - `project`는 인증 키에서 주입하고 바디 값은 400으로 거부한다 (specs/04 규약)
 *   - 같은 `(project, recordId, query)`는 새 문서를 만들지 않고 갱신한다 (T-022 Acceptance 3)
 *   - `helped=true`는 `eval_cases`에 **후보만** 남긴다 — `approvedBy`는 절대 쓰지 않는다.
 *     specs/02: "eval_cases는 사람 승인 없이 자동 추가 금지". 승격은 사람의 몫이다.
 */
import { createHash } from "node:crypto";

import { FeedbackRequest, type EvalCaseSchema, type FeedbackSchema } from "@sentinel/contracts";
import { toObjectId } from "@sentinel/core/db";
import type { FastifyInstance, FastifyReply } from "fastify";
import { ObjectId, type Collection, type Db, type Filter } from "mongodb";

import { API_ERROR_CODES, HttpError } from "./errors.js";

// ---------------------------------------------------------------- 저장 형상

/**
 * `feedbacks` 도큐먼트. contracts의 `FeedbackSchema`에서 **파생**한다 —
 * id 계열만 드라이버 타입으로 낮추고 나머지 필드는 계약이 그대로 소유한다.
 */
export type FeedbackDocument = Omit<FeedbackSchema, "_id" | "recordId"> & {
  _id: ObjectId;
  recordId: ObjectId;
};

/**
 * `eval_cases` 도큐먼트. `approvedBy`가 **선택**인 것이 이 타입의 요점이다.
 *
 * contracts의 `EvalCaseSchema`는 `approvedBy: "human"`을 **필수**로 못박아 자동 생성 골든셋을
 * 거부한다. 저장 계층은 그보다 넓어야 한다 — 승인 전 후보가 실재하기 때문이다.
 * 대신 이 파일의 쓰기 경로는 `approvedBy`를 **한 번도 쓰지 않는다.** 그래서 여기서 만들어진
 * 도큐먼트는 `EvalCaseSchema.safeParse`를 통과하지 못하고, 계약으로 골든셋을 읽는 러너는
 * 사람이 승인하기 전까지 그 케이스를 절대 쓸 수 없다.
 */
export type EvalCaseDocument = Omit<EvalCaseSchema, "_id" | "expectedRecordIds" | "approvedBy"> & {
  _id: ObjectId;
  expectedRecordIds: ObjectId[];
  /** 사람이 승인 절차로만 채운다. 이 모듈은 읽지도 쓰지도 않는다. */
  approvedBy?: EvalCaseSchema["approvedBy"];
};

export function feedbacksCollection(db: Db): Collection<FeedbackDocument> {
  return db.collection<FeedbackDocument>("feedbacks");
}

export function evalCasesCollection(db: Db): Collection<EvalCaseDocument> {
  return db.collection<EvalCaseDocument>("eval_cases");
}

/**
 * **골든셋의 정의.** specs/05: "골든셋: … (`eval_cases`, 사람 승인분만)".
 * eval 러너는 이 필터로만 케이스를 읽어야 한다.
 */
export const APPROVED_EVAL_CASE_FILTER: Filter<EvalCaseDocument> = { approvedBy: "human" };

/** 승인 대기 후보. 승인 CLI가 사람에게 보여줄 목록이자, 러너가 **보면 안 되는** 집합이다. */
export const EVAL_CASE_CANDIDATE_FILTER: Filter<EvalCaseDocument> = {
  approvedBy: { $exists: false },
};

// ---------------------------------------------------------------- 중복 제거 키

/**
 * 내용에서 `_id`를 유도한다. 같은 입력은 항상 같은 문서를 가리킨다.
 *
 * **왜 보조 인덱스가 아니라 `_id`인가**: 중복 제거 키에 unique 인덱스가 없으면 동시 요청 두 개가
 * 모두 "없다"고 판단해 문서가 둘 생긴다. 그런데 `feedbacks` 인덱스는 specs/02 §인덱스에도
 * DB-DESIGN §3에도 없고(T-003 F-1), 인덱스 추가는 **스펙 변경 = 사람 승인** 경로다.
 * `_id`는 어느 컬렉션에나 이미 unique이므로, 중복 제거 키를 `_id`에 실으면
 * 스펙을 건드리지 않고도 동시 삽입이 두 문서가 되는 창을 닫을 수 있다.
 * (대가: `_id`가 시간순이 아니다. feedbacks는 cursor 페이지네이션 대상이 아니라 무해하다.)
 */
function deterministicId(...parts: readonly string[]): ObjectId {
  // 구분자로 NUL을 쓴다. 사용자 문자열이 경계를 넘어 다른 키와 충돌하는 것을 막는다.
  const digest = createHash("sha256").update(parts.join("\u0000")).digest();
  return new ObjectId(digest.subarray(0, 12));
}

/** 피드백의 중복 제거 키 = `(project, recordId, query)`. project는 키에서 온 값이다. */
export function feedbackDocumentId(project: string, recordId: string, query: string): ObjectId {
  return deterministicId("feedback", project, recordId, query);
}

/**
 * 후보 케이스의 키 = `query` 단독.
 *
 * `eval_cases`에는 `project` 필드가 없다(specs/02). 골든셋은 "이 query에 대한 정답 레코드"이지
 * 프로젝트별 사본이 아니므로, 같은 query에 대한 여러 프로젝트의 피드백은 한 후보로 모인다.
 */
export function evalCaseCandidateId(query: string): ObjectId {
  return deterministicId("eval-case", query);
}

const DUPLICATE_KEY_ERROR = 11_000;

function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === DUPLICATE_KEY_ERROR
  );
}

// ---------------------------------------------------------------- 저장

export interface StoreFeedbackInput {
  readonly project: string;
  readonly recordId: string;
  readonly query: string;
  readonly helped: boolean;
  readonly note?: string;
  readonly now: Date;
}

/**
 * 피드백을 upsert한다. 같은 `(project, recordId, query)`의 두 번째 요청은
 * 새 문서를 만들지 않고 **마지막 판단으로 덮는다** — 사람이 마음을 바꾸면 그게 현재 사실이다.
 * `createdAt`은 최초 기록 시점을 유지한다(`$setOnInsert`).
 */
async function upsertFeedback(db: Db, input: StoreFeedbackInput, recordId: ObjectId): Promise<void> {
  const _id = feedbackDocumentId(input.project, input.recordId, input.query);
  const update = {
    $set: {
      recordId,
      query: input.query,
      helped: input.helped,
      project: input.project,
      ...(input.note === undefined ? {} : { note: input.note }),
    },
    // note를 빼고 다시 보내면 이전 note가 남지 않는다. 남기면 저장된 문서가
    // "지금 이 사람이 한 말"이 아니라 두 요청의 혼합이 된다.
    ...(input.note === undefined ? { $unset: { note: "" as const } } : {}),
    $setOnInsert: { createdAt: input.now },
  };

  try {
    await feedbacksCollection(db).updateOne({ _id }, update, { upsert: true });
  } catch (error) {
    // 같은 `_id`로 동시에 들어온 요청 중 하나는 insert 경합에서 진다. 그 시점엔 이미
    // 문서가 있으므로 한 번 더 돌리면 update 경로를 탄다.
    if (!isDuplicateKeyError(error)) throw error;
    await feedbacksCollection(db).updateOne({ _id }, update, { upsert: true });
  }
}

/**
 * `helped=true`인 피드백을 `eval_cases` **후보**로 적재한다(T-022 Scope).
 *
 * **`approvedBy`를 쓰지 않는다. 이 함수가 지키는 유일한 불변식이다.**
 * 필터의 `approvedBy: {$exists:false}`는 그 불변식의 반대편이다 — 이미 사람이 승인한 케이스는
 * 이 경로로 절대 수정되지 않는다. 승인된 케이스의 정답 목록이 피드백으로 조용히 늘어나면
 * 그것이 곧 "자동 승격"이고, 골든셋이 오염되면 eval 루프 전체가 무의미해진다(specs/02).
 */
async function upsertEvalCaseCandidate(db: Db, query: string, recordId: ObjectId): Promise<void> {
  const _id = evalCaseCandidateId(query);
  try {
    await evalCasesCollection(db).updateOne(
      { _id, ...EVAL_CASE_CANDIDATE_FILTER },
      {
        $setOnInsert: { query },
        $addToSet: { expectedRecordIds: recordId },
      },
      { upsert: true },
    );
  } catch (error) {
    // 같은 query의 **승인된** 케이스가 이미 있다 → 필터가 걸러 upsert가 insert를 시도했고
    // `_id`에서 막혔다. 후보 병합을 포기하는 것이 맞다. 피드백 자체는 이미 저장돼 있으므로
    // 사람이 그 피드백을 보고 골든셋을 고칠 수 있다.
    if (!isDuplicateKeyError(error)) throw error;
  }
}

/** 라우트가 부르는 저장 경로 전체. 피드백은 항상, 후보는 `helped=true`일 때만. */
export async function storeFeedback(db: Db, input: StoreFeedbackInput): Promise<void> {
  const recordId = toObjectId(input.recordId);
  if (recordId === undefined) {
    // `ObjectIdString`이 이미 24자 hex를 강제하므로 도달할 수 없다.
    throw new HttpError(
      400,
      API_ERROR_CODES.VALIDATION_FAILED,
      "recordId가 24자 hex ObjectId 문자열이 아니다.",
    );
  }

  await upsertFeedback(db, input, recordId);
  if (input.helped) {
    await upsertEvalCaseCandidate(db, input.query, recordId);
  }
}

// ---------------------------------------------------------------- 라우트

export interface FeedbackRoutesDeps {
  readonly db: Db;
  /** 시계 주입. 테스트가 `createdAt`을 결정론적으로 만들 수 있어야 한다. */
  readonly now: () => Date;
}

/**
 * 바디의 `project`를 조용히 무시하지 않고 거부한다. specs/04 규약의 근거가
 * `/v1/records` 전용이 아니라 **API 전체**의 confused deputy 방지이므로 여기서도 같다.
 */
function assertNoProjectInBody(body: unknown): void {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return;
  if (!Object.keys(body).includes("project")) return;
  throw new HttpError(
    400,
    API_ERROR_CODES.PROJECT_NOT_ALLOWED_IN_BODY,
    "바디에 `project`를 담을 수 없다. project는 인증 키의 클레임에서 주입되며 " +
      "바디 값은 무시되지 않고 거부된다(specs/04).",
  );
}

export function registerFeedbackRoutes(app: FastifyInstance, deps: FeedbackRoutesDeps): void {
  // ------------------------------------------------------------ POST /v1/feedback
  app.post("/v1/feedback", async (request, reply): Promise<FastifyReply> => {
    assertNoProjectInBody(request.body);

    const parsed = FeedbackRequest.safeParse(request.body);
    if (!parsed.success) {
      throw new HttpError(
        400,
        API_ERROR_CODES.VALIDATION_FAILED,
        "요청이 스키마를 만족하지 않는다.",
        parsed.error.issues,
      );
    }

    const { recordId, query, helped, note } = parsed.data;
    await storeFeedback(deps.db, {
      recordId,
      query,
      helped,
      // `exactOptionalPropertyTypes`: note는 "없음"과 "undefined"를 구분한다.
      ...(note === undefined ? {} : { note }),
      /** **인증 훅이 붙인 값만 쓴다.** 바디의 project는 위에서 이미 400으로 거부됐다. */
      project: request.project,
      now: deps.now(),
    });

    // 204다. contracts에 응답 스키마가 없으므로 본문을 만들면 **계약 밖 형상**이 생긴다
    // (CLAUDE.md: 계약은 packages/contracts가 단일 소스). 저장 성공 외에 알릴 것도 없다.
    return reply.code(204).send();
  });
}
