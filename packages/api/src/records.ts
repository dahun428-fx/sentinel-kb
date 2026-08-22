/**
 * `/v1/records` 라우트. 출처: specs/04-api.md 표, specs/00 FR-01, specs/02-data-model.md.
 *
 * 검증은 **contracts의 Zod 스키마로만** 한다 — 타입도 제약도 여기서 다시 정의하지 않는다(CLAUDE.md).
 * 이 파일이 하는 일은 계약이 표현하지 못하는 **서버 소유 규칙**뿐이다:
 *   - `project`는 인증 키에서 주입하고 바디 값은 400으로 거부한다 (specs/04)
 *   - `summary`·`sanitizeFlags`·`embeddingVersion`은 서버가 쓴다 (specs/02)
 *   - PATCH는 부분 `$set`만 한다 — 워터마크 보존 (specs/02)
 *   - PATCH는 기존 레코드의 `type`에 속한 필드만 받는다 (T-002 F-2)
 *   - 쓰기는 자기 project로만, 조회는 크로스 허용 (specs/04)
 */
import {
  CreateRecordInput,
  ListRecordsQuery,
  PatchRecordInput,
  RecordIdParam,
  RecordSchema,
  RecordSummary,
  type DivergenceContext,
  type Relation,
  type SanitizeFlag,
} from "@sentinel/contracts";
import type { ResolvedSanitizeOptions } from "@sentinel/core";
import {
  recordsCollection,
  toContractRecord,
  toObjectId,
  toRelationDocuments,
  type RecordDocument,
} from "@sentinel/core/db";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { Db, Filter, ObjectId } from "mongodb";
import { ObjectId as ObjectIdCtor } from "mongodb";

import { decodeCursor, encodeCursor } from "./cursor.js";
import { enqueueEmbedJob } from "./embed-jobs.js";
import { API_ERROR_CODES, HttpError } from "./errors.js";
import {
  allowedPatchFields,
  CONTEXT_KEYS,
  isBodySectionField,
  PATCHABLE_STORED_FIELDS,
  summarySourceField,
} from "./record-fields.js";
import { sanitizeFields, toSanitizeWarning, type SanitizedFields } from "./sanitize-record.js";
import { buildSummary } from "./summary.js";

export interface RecordRoutesDeps {
  readonly db: Db;
  /**
   * 컴포지션 루트가 **한 번** 만든 새니타이즈 옵션. 요청마다 env를 읽지 않는다(T-004 F-4).
   * `sanitize()`에 항상 명시적으로 넘어간다.
   */
  readonly sanitizeOptions: ResolvedSanitizeOptions;
  /** 시계 주입. 테스트가 잡·레코드 타임스탬프를 결정론적으로 만들 수 있어야 한다. */
  readonly now: () => Date;
}

/** `context.model` 처럼 중첩 필드를 평면 키로 표현할 때 쓰는 접두사. */
const CONTEXT_PREFIX = "context.";

// ---------------------------------------------------------------- 공통 헬퍼

/**
 * 바디에 서버 소유 필드가 왔는지 **먼저** 본다.
 *
 * `.strict()`가 어차피 거부하지만 그 메시지는 "Unrecognized key(s)"라 무엇이 왜 문제인지
 * 알려주지 않는다. specs/04가 "조용한 무시"를 "400 거부"로 고친 이유가
 * **클라이언트가 어디에 썼다고 믿는지**의 문제였으므로, 거부 사유도 그만큼 명시적이어야 한다.
 * 조용한 무시가 confused deputy를 만들듯, 뭉뚱그린 400은 클라이언트가 스키마를 의심하며
 * 같은 요청을 반복하게 만든다.
 */
function assertNoServerOwnedKeys(body: unknown, allowTypeKey: boolean): void {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return;
  const keys = Object.keys(body);

  if (keys.includes("project")) {
    throw new HttpError(
      400,
      API_ERROR_CODES.PROJECT_NOT_ALLOWED_IN_BODY,
      "바디에 `project`를 담을 수 없다. project는 인증 키의 클레임에서 주입되며 " +
        "바디 값은 무시되지 않고 거부된다(specs/04). 다른 project에 쓰려면 그 project의 키를 써라.",
    );
  }
  if (!allowTypeKey && keys.includes("type")) {
    throw new HttpError(
      400,
      API_ERROR_CODES.TYPE_IMMUTABLE,
      "레코드 종류(`type`)는 수정할 수 없다. 종류가 바뀌면 본문 섹션의 의미가 통째로 달라진다.",
    );
  }
}

/** Zod 실패를 400으로 옮긴다. issue 목록을 `details`에 실어 클라이언트가 필드를 특정할 수 있게 한다. */
function validationError(error: { issues: unknown }): HttpError {
  return new HttpError(
    400,
    API_ERROR_CODES.VALIDATION_FAILED,
    "요청이 스키마를 만족하지 않는다.",
    error.issues,
  );
}

/**
 * 수집 단계에 넣은 이름을 꺼낸다. 없으면 **프로그래밍 오류**다 —
 * 클라이언트 입력으로는 도달할 수 없으므로 400이 아니라 그대로 터뜨린다.
 */
function mustText(sanitized: SanitizedFields, name: string): string {
  const value = sanitized.texts[name];
  if (value === undefined) {
    throw new Error(`새니타이즈 결과에 ${name}가 없다 — 수집 단계와 사용 단계가 어긋났다.`);
  }
  return value;
}

/** DB 도큐먼트를 contracts 형상으로 낮춰 파싱한다. 통과하지 못하면 저장된 도큐먼트가 깨진 것이다. */
function toContractRecordOrThrow(document: RecordDocument, code: "read" | "write"): RecordSchema {
  const parsed = RecordSchema.safeParse(toContractRecord({ ...document }));
  if (!parsed.success) {
    if (code === "write") {
      throw new HttpError(
        400,
        API_ERROR_CODES.SANITIZED_RECORD_INVALID,
        "새니타이즈를 거친 결과가 레코드 스키마를 벗어났다. " +
          "마스킹 라벨이 길이 제약을 넘겼을 수 있다(예: 제목 200자).",
        parsed.error.issues,
      );
    }
    throw new Error(`저장된 레코드가 RecordSchema를 만족하지 않는다: ${parsed.error.message}`);
  }
  return parsed.data;
}

/** 201·200 본문. 레코드 전문 + 경고(있을 때만). 경고 형상의 근거는 `sanitize-record.ts`에 있다. */
function withWarning(record: RecordSchema, sanitized: SanitizedFields): unknown {
  const warning = toSanitizeWarning(sanitized);
  return warning === undefined ? record : { ...record, warning };
}

/** specs/02의 플래그 순서를 유지한 합집합. */
const FLAG_ORDER: readonly SanitizeFlag[] = ["secret-masked", "injection-suspect"];

function unionFlags(a: readonly SanitizeFlag[], b: readonly SanitizeFlag[]): SanitizeFlag[] {
  const seen = new Set<SanitizeFlag>([...a, ...b]);
  return FLAG_ORDER.filter((flag) => seen.has(flag));
}

// ---------------------------------------------------------------- 라우트

export function registerRecordRoutes(app: FastifyInstance, deps: RecordRoutesDeps): void {
  const records = recordsCollection(deps.db);

  // ------------------------------------------------------------ POST /v1/records
  app.post("/v1/records", async (request, reply): Promise<FastifyReply> => {
    assertNoServerOwnedKeys(request.body, true);

    const parsed = CreateRecordInput.safeParse(request.body);
    if (!parsed.success) throw validationError(parsed.error);
    const input = parsed.data;

    // 자유 텍스트를 모두 모아 **합계 길이를 먼저** 재고 한꺼번에 새니타이즈한다.
    // 섹션마다 따로 부르면 상한이 섹션 수만큼 곱해진다(T-004 인계 사항).
    const raw: Record<string, string> = { title: input.title };
    if (input.type === "incident") {
      raw["symptom"] = input.symptom;
      raw["resolution"] = input.resolution;
      if (input.rootCause !== undefined) raw["rootCause"] = input.rootCause;
      if (input.prevention !== undefined) raw["prevention"] = input.prevention;
    } else {
      raw["expected"] = input.expected;
      raw["actual"] = input.actual;
      raw["correction"] = input.correction;
      for (const key of CONTEXT_KEYS) {
        const value = input.context[key];
        if (value !== undefined) raw[`${CONTEXT_PREFIX}${key}`] = value;
      }
    }
    // 태그는 마스킹하지 않고 **길이만** 합계에 넣는다 — 정확 일치 키라 마스킹이 조회를 깬다.
    const sanitized = sanitizeFields(raw, deps.sanitizeOptions, input.tags);

    const now = deps.now();
    const common = {
      _id: new ObjectIdCtor(),
      /** **인증 훅이 붙인 값만 쓴다.** 바디의 project는 위에서 이미 400으로 거부됐다. */
      project: request.project,
      title: mustText(sanitized, "title"),
      summary: buildSummary(
        mustText(sanitized, summarySourceField(input.type)),
        mustText(sanitized, "title"),
      ),
      severity: input.severity,
      tags: input.tags,
      sanitizeFlags: sanitized.flags,
      /** 생성 입력에 `relations`가 없다(contracts). 필수 필드이므로 빈 배열로 실체화한다. */
      relations: [],
      status: input.status,
      /**
       * **워터마크 초기화 — T-007이 이 필드를 쓰는 유일한 지점이다.**
       * 0 = 미임베딩. 이후 올리는 주체는 인제스트 워커 단독이다(specs/02).
       */
      embeddingVersion: 0,
      createdAt: now,
      updatedAt: now,
    };

    const document: RecordDocument =
      input.type === "incident"
        ? {
            ...common,
            type: "incident",
            symptom: mustText(sanitized, "symptom"),
            resolution: mustText(sanitized, "resolution"),
            ...(sanitized.texts["rootCause"] === undefined
              ? {}
              : { rootCause: sanitized.texts["rootCause"] }),
            ...(sanitized.texts["prevention"] === undefined
              ? {}
              : { prevention: sanitized.texts["prevention"] }),
          }
        : {
            ...common,
            type: "divergence",
            expected: mustText(sanitized, "expected"),
            actual: mustText(sanitized, "actual"),
            correction: mustText(sanitized, "correction"),
            context: sanitizedContext(sanitized),
          };

    // 저장 **전에** 계약으로 검증한다. 마스킹이 길이 제약을 넘길 수 있으므로
    // (예: `api_key=ab` → `[MASKED:api-key]`는 14자 늘어난다) 여기서 걸러야
    // "저장은 됐는데 RecordSchema로 읽히지 않는" 도큐먼트가 생기지 않는다.
    const record = toContractRecordOrThrow(document, "write");

    await records.insertOne(document);

    /**
     * **생성 시점에 걸어야 한다.** T-002가 생성 기본값을 `published`로 정했으므로
     * draft→published 전환에만 걸면 대부분의 레코드가 영원히 임베딩되지 않는다(specs/03 §1-1).
     */
    if (document.status === "published") {
      await enqueueEmbedJob(deps.db, document._id, now);
    }

    return reply.code(201).send(withWarning(record, sanitized));
  });

  // ------------------------------------------------------------ GET /v1/records
  app.get("/v1/records", async (request, reply): Promise<FastifyReply> => {
    const parsed = ListRecordsQuery.safeParse(normalizeListQuery(request.query));
    if (!parsed.success) throw validationError(parsed.error);
    const query = parsed.data;

    const filter: Filter<RecordDocument> = {};
    // **caller의 project를 암묵적으로 걸지 않는다.** specs/04: 크로스 **조회**는 허용이며
    // 그것이 "지식 공유"라는 이 제품의 목적이다. 좁히려면 클라이언트가 명시해야 한다.
    if (query.project !== undefined) filter.project = query.project;
    if (query.type !== undefined) filter.type = query.type;
    if (query.tags !== undefined && query.tags.length > 0) filter.tags = { $all: query.tags };

    if (query.cursor !== undefined) {
      const cursor = decodeCursor(query.cursor);
      if (cursor === undefined) {
        throw new HttpError(
          400,
          API_ERROR_CODES.INVALID_CURSOR,
          "cursor가 이 서버가 발급한 형식이 아니다. 응답의 `nextCursor`를 그대로 돌려줘야 한다.",
        );
      }
      // `createdAt` 단독으로는 같은 밀리초의 레코드가 경계에서 사라진다 — `_id`가 동점 처리자다.
      filter.$or = [
        { createdAt: { $lt: cursor.createdAt } },
        { createdAt: cursor.createdAt, _id: { $lt: cursor.id } },
      ];
    }

    // 다음 페이지 존재 여부를 알기 위해 하나 더 읽는다. 총계를 세지 않는 이유는
    // `countDocuments`가 컬렉션 전체를 훑기 때문이고, cursor 방식은 총계를 약속하지 않는다.
    const documents = await records
      .find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .limit(query.limit + 1)
      .toArray();

    const page = documents.slice(0, query.limit);
    const last = page[page.length - 1];
    const nextCursor =
      documents.length > query.limit && last !== undefined
        ? encodeCursor({ createdAt: last.createdAt, id: last._id })
        : null;

    return reply.send({ items: page.map(toSummaryItem), nextCursor });
  });

  // ------------------------------------------------------------ GET /v1/records/:id
  app.get("/v1/records/:id", async (request, reply): Promise<FastifyReply> => {
    const document = await loadRecord(records, request.params);
    // 크로스 project **조회**는 허용이므로 project를 대조하지 않는다(specs/04).
    return reply.send(toContractRecordOrThrow(document, "read"));
  });

  // ------------------------------------------------------------ PATCH /v1/records/:id
  app.patch("/v1/records/:id", async (request, reply): Promise<FastifyReply> => {
    assertNoServerOwnedKeys(request.body, false);

    const parsed = PatchRecordInput.safeParse(request.body);
    if (!parsed.success) throw validationError(parsed.error);
    const patch: Record<string, unknown> = parsed.data;

    const existing = await loadRecord(records, request.params);

    // **쓰기는 자기 project로만**(specs/04). 조회와 달리 여기서 갈린다.
    if (existing.project !== request.project) {
      throw new HttpError(
        403,
        API_ERROR_CODES.CROSS_PROJECT_WRITE_FORBIDDEN,
        `project "${existing.project}"의 레코드는 그 project의 키로만 수정할 수 있다. ` +
          "크로스 project 조회는 허용되지만 쓰기는 허용되지 않는다.",
      );
    }

    // **종류 교차 방어** (T-002 F-2). `PatchRecordInput`은 평면 partial이라
    // incident에 `expected`를 넣는 요청이 계약을 통과한다. 기존 레코드의 type이 유일한 기준이다.
    const allowed = allowedPatchFields(existing.type);
    const violations = Object.keys(patch).filter((key) => !allowed.has(key));
    if (violations.length > 0) {
      throw new HttpError(
        400,
        API_ERROR_CODES.FIELD_NOT_ALLOWED_FOR_TYPE,
        `${existing.type} 레코드에 없는 필드를 수정하려 했다: ${violations.join(", ")}. ` +
          "저장하면 RecordSchema로 다시 읽히지 않는 도큐먼트가 된다.",
        { type: existing.type, fields: violations },
      );
    }

    const raw: Record<string, string> = {};
    for (const [key, value] of Object.entries(patch)) {
      if ((key === "title" || isBodySectionField(key)) && typeof value === "string") {
        raw[key] = value;
      }
    }
    if (patch["context"] !== undefined) {
      const context = patch["context"] as DivergenceContext;
      for (const key of CONTEXT_KEYS) {
        const value = context[key];
        if (value !== undefined) raw[`${CONTEXT_PREFIX}${key}`] = value;
      }
    }
    // 태그는 마스킹하지 않고 **길이만** 합계에 넣는다 — 정확 일치 키라 마스킹이 조회를 깬다.
    // `relations[].note`도 같이 센다. 개당 500자 × 최대 50개면 25K이고, 세지 않으면
    // 본문 상한을 우회하는 두 번째 경로가 된다(T-007 F-4와 같은 축).
    // **마스킹 여부는 여전히 미결이다** — note는 자유 텍스트라 태그와 달리 마스킹해도
    // 깨지는 조회가 없다. R-4에서 함께 결정한다.
    const relationNotes = ((patch["relations"] as readonly { note?: string }[] | undefined) ?? [])
      .map((relation) => relation.note ?? "")
      .filter((note) => note !== "");
    const sanitized = sanitizeFields(raw, deps.sanitizeOptions, [
      ...((patch["tags"] as string[]) ?? []),
      ...relationNotes,
    ]);

    const now = deps.now();
    /**
     * **부분 `$set`만 만든다.** 도큐먼트를 통째로 `$set`하거나 재검증 후 전체 치환하면
     * `embeddingVersion` 워터마크가 0으로 되돌아가 **이미 임베딩된 record가 미임베딩으로 오인된다**
     * (specs/02, T-008 인계 사항). `PatchRecordInput`의 `.strict()`는 클라이언트 주입만 막고
     * 서버 내부의 전체 치환은 못 막으므로, 여기서 키를 하나씩 쌓는 것이 유일한 방어다.
     */
    const contractPatch: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(patch)) {
      if (key === "context") {
        contractPatch[key] = sanitizedContext(sanitized);
      } else if (sanitized.texts[key] !== undefined) {
        contractPatch[key] = sanitized.texts[key];
      } else {
        contractPatch[key] = value;
      }
    }

    // 요약의 근거 섹션이 바뀌면 요약도 다시 만든다. 그러지 않으면 목록·검색이
    // 본문과 어긋난 요약을 계속 보여준다 — `summary`가 서버 생성 필드인 이유가 무의미해진다.
    const summarySource = summarySourceField(existing.type);
    if (sanitized.texts[summarySource] !== undefined) {
      contractPatch["summary"] = buildSummary(
        mustText(sanitized, summarySource),
        sanitized.texts["title"] ?? existing.title,
      );
    }
    // 플래그는 **합집합**이다. 이번 PATCH는 건드린 필드만 검사했으므로, 손대지 않은 섹션에서
    // 나온 플래그를 지울 근거가 없다. 지우면 "검사 결과 깨끗함"이라고 거짓말하게 된다.
    if (sanitized.flags.length > 0) {
      contractPatch["sanitizeFlags"] = unionFlags(existing.sanitizeFlags, sanitized.flags);
    }
    contractPatch["updatedAt"] = now;

    // 병합 결과가 계약을 만족하는지 **쓰기 전에** 본다. 검증은 병합본으로 하고
    // 쓰기는 부분 `$set`으로 한다 — 이 둘을 분리하는 것이 워터마크 보존의 핵심이다.
    const merged = {
      ...(toContractRecord({ ...existing }) as Record<string, unknown>),
      ...contractPatch,
    };
    const validated = RecordSchema.safeParse(merged);
    if (!validated.success) {
      throw new HttpError(
        400,
        API_ERROR_CODES.SANITIZED_RECORD_INVALID,
        "수정 결과가 레코드 스키마를 벗어났다.",
        validated.error.issues,
      );
    }

    const set: Record<string, unknown> = { ...contractPatch };
    if (contractPatch["relations"] !== undefined) {
      const documents = toRelationDocuments(contractPatch["relations"] as readonly Relation[]);
      if (documents === undefined) {
        throw new HttpError(
          400,
          API_ERROR_CODES.VALIDATION_FAILED,
          "relations의 targetRecordId가 24자 hex ObjectId가 아니다.",
        );
      }
      set["relations"] = documents;
    }
    assertOnlyPatchableFields(set);

    const updated = await records.findOneAndUpdate(
      // 필터에 `project`를 다시 건다. 위 403 검사와 이중이지만, 검사와 쓰기 사이에
      // 레코드가 바뀔 수 있고 그 창을 닫는 것은 필터뿐이다.
      { _id: existing._id, project: request.project },
      { $set: set },
      { returnDocument: "after" },
    );
    if (updated === null) {
      throw new HttpError(404, API_ERROR_CODES.RECORD_NOT_FOUND, "수정 중에 레코드가 사라졌다.");
    }

    const sectionChanged = Object.keys(patch).some((key) => isBodySectionField(key));
    const becamePublished = updated.status === "published" && existing.status !== "published";
    // specs/04: "본문 섹션 변경 시 재임베딩 job". 여기에 draft→published 전환을 더한다 —
    // draft로 만들어진 레코드는 생성 시 잡이 없었으므로 이 전환이 유일한 임베딩 기회다.
    if (updated.status === "published" && (sectionChanged || becamePublished)) {
      await enqueueEmbedJob(deps.db, updated._id, now);
    }

    return reply.send(withWarning(toContractRecordOrThrow(updated, "write"), sanitized));
  });
}

// ---------------------------------------------------------------- 보조

/**
 * `$set`에 서버 소유 필드가 섞이지 않았는지 확인한다.
 *
 * 화이트리스트에 `embeddingVersion`·`project`·`type`·`_id`·`createdAt`이 **없다.**
 * 누군가 이 함수를 통과시키려고 전체 도큐먼트를 `$set`으로 넘기는 순간 여기서 터진다 —
 * 조용히 워터마크가 0으로 돌아가 레코드가 미임베딩으로 오인되는 것보다 낫다.
 */
function assertOnlyPatchableFields(set: Readonly<Record<string, unknown>>): void {
  const forbidden = Object.keys(set).filter((key) => !PATCHABLE_STORED_FIELDS.has(key));
  if (forbidden.length > 0) {
    throw new Error(
      `PATCH의 $set에 서버 소유 필드가 섞였다: ${forbidden.join(", ")}. ` +
        "부분 $set만 허용된다(워터마크 보존, specs/02).",
    );
  }
}

/** 새니타이즈된 `context.*` 값을 다시 중첩 객체로 조립한다. 없는 키는 넣지 않는다. */
function sanitizedContext(sanitized: SanitizedFields): DivergenceContext {
  const context: DivergenceContext = {};
  for (const key of CONTEXT_KEYS) {
    const value = sanitized.texts[`${CONTEXT_PREFIX}${key}`];
    if (value !== undefined) context[key] = value;
  }
  return context;
}

/**
 * 쿼리스트링의 `tags`는 값이 하나면 문자열, 여럿이면 배열로 들어온다.
 * `ListRecordsQuery.tags`는 배열이므로 단일 값을 감싸 준다 —
 * 계약을 느슨하게 고치는 대신 **전송 형식의 차이를 여기서 흡수한다.**
 */
function normalizeListQuery(query: unknown): unknown {
  if (typeof query !== "object" || query === null) return query;
  const source = query as Record<string, unknown>;
  if (typeof source["tags"] !== "string") return query;
  return { ...source, tags: [source["tags"]] };
}

/** 목록 항목. `RecordSummary`가 `.strict()`라 본문 필드를 실으면 파싱이 실패한다(NFR-03). */
function toSummaryItem(document: RecordDocument): RecordSummary {
  return RecordSummary.parse({
    _id: document._id.toHexString(),
    type: document.type,
    project: document.project,
    title: document.title,
    summary: document.summary,
    severity: document.severity,
    tags: document.tags,
    sanitizeFlags: document.sanitizeFlags,
    status: document.status,
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
  });
}

/** 경로 파라미터를 검증하고 레코드를 읽는다. 형식 오류는 400, 없으면 404. */
async function loadRecord(
  records: ReturnType<typeof recordsCollection>,
  params: unknown,
): Promise<RecordDocument> {
  const parsed = RecordIdParam.safeParse(params);
  if (!parsed.success) throw validationError(parsed.error);

  // `ObjectIdString`이 이미 24자 hex를 강제하므로 여기서 실패할 수 없다.
  // 그래도 `toObjectId`가 `undefined`를 낼 수 있는 계약이라 분기를 남긴다.
  const id: ObjectId | undefined = toObjectId(parsed.data.id);
  if (id === undefined) {
    throw new HttpError(
      400,
      API_ERROR_CODES.VALIDATION_FAILED,
      "id가 24자 hex ObjectId 문자열이 아니다.",
    );
  }

  const document = await records.findOne({ _id: id });
  if (document === null) {
    throw new HttpError(404, API_ERROR_CODES.RECORD_NOT_FOUND, `레코드 ${parsed.data.id}가 없다.`);
  }
  return document;
}
