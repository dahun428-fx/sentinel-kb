/**
 * 야간 아티클 트리거 배치. 출처: specs/08-publishing.md §1("worker가 야간 배치로 판정"), §7.
 *
 * 흐름: 재료 적재 → 순수 트리거 판정(`article-triggers.ts`) → 후보 upsert.
 * 판단은 전부 순수 함수 쪽에 있고 이 파일은 **입출력만** 한다.
 *
 * ## 이 배치가 절대 하지 않는 일
 * - `status`를 `candidate` 외의 값으로 쓰지 않는다. `publishedAt`도 쓰지 않는다.
 *   §0-5·§7의 "전자동 발행 금지"는 사람의 승인 경로를 남기는 것이 전부이므로,
 *   그 경로를 지우는 코드가 여기 한 줄이라도 들어오면 기능 전체가 무의미해진다.
 * - 이미 있는 아티클을 **수정하지 않는다.** 전부 `$setOnInsert`다. 사람이 손댄 초안이
 *   야간 배치에 덮여 사라지는 것은 되돌릴 수 없다.
 */
import type { ArticleStatus } from "@sentinel/contracts";
import { ObjectId, type Db } from "mongodb";

import { articleId, articleSlug, articlesCollection, type ArticleDocument } from "./articles.js";
import {
  evaluateArticleTriggers,
  type ArticleCandidate,
  type ArticleTriggerThresholds,
  type TriggerRecord,
} from "./article-triggers.js";

export interface ArticleBatchDeps {
  readonly db: Db;
  /** 시각 주입. 다이제스트 주차 계산과 `createdAt`이 여기 걸린다. */
  readonly now?: () => Date;
  readonly thresholds?: Partial<ArticleTriggerThresholds>;
}

export interface ArticleBatchResult {
  /** 트리거 판정에 실제로 쓰인 레코드 수(초안·injection-suspect 제외 후). */
  readonly materialCount: number;
  /** 트리거가 낸 후보 제안 수. */
  readonly proposed: number;
  /** 새로 적재된 후보 수. */
  readonly inserted: number;
  /** 같은 소스 집합의 아티클이 이미 있어 건너뛴 수. */
  readonly skippedExisting: number;
  /** 같은 클러스터의 **열린** 아티클이 이미 있어 억제된 수. */
  readonly skippedSuperseded: number;
}

/** 사람이 아직 판단하지 않은 상태. 이 상태의 아티클이 있으면 같은 클러스터를 다시 제안하지 않는다. */
const OPEN_STATUSES: readonly ArticleStatus[] = ["candidate", "draft"];

/**
 * 트리거 배치 1회 실행. **멱등하다** — 같은 DB 상태에서 몇 번을 돌려도
 * `inserted`는 첫 실행 이후 0이고 컬렉션은 자라지 않는다.
 */
export async function runArticleTriggerBatch(
  deps: ArticleBatchDeps,
): Promise<ArticleBatchResult> {
  const now = (deps.now ?? ((): Date => new Date()))();
  const material = await loadTriggerRecords(deps.db);
  const proposals = evaluateArticleTriggers(material, {
    now,
    ...(deps.thresholds === undefined ? {} : { thresholds: deps.thresholds }),
  });

  const open = await loadOpenSourceSets(deps.db);

  /**
   * **넓은 후보부터 적재한다.** 억제 규칙이 "열린 아티클의 소스 집합 ⊆ 새 제안"이므로,
   * 좁은 후보가 먼저 들어가면 같은 실행 안에서 그것을 포함하는 넓은 후보가 억제된다.
   * 이격 리포트가 정확히 그 모양이다 — `tool=implementer` 3건은 `model=claude` 10건의
   * 부분집합이고, 순서가 뒤집히면 **더 많은 근거를 가진 리포트가 사라진다.**
   */
  const ordered = [...proposals].sort(
    (a, b) => b.sourceRecordIds.length - a.sourceRecordIds.length,
  );

  let inserted = 0;
  let skippedExisting = 0;
  let skippedSuperseded = 0;

  for (const proposal of ordered) {
    /**
     * 같은 유형·같은 소스 집합이면 `_id`도 같다. 이격 리포트의 두 축(model·tool)이
     * 정확히 같은 3건을 가리키는 경우가 그렇고, 그때는 뒤에 온 쪽이 `skippedExisting`이 된다.
     * 같은 레코드 집합에 대한 같은 유형의 글은 하나면 충분하므로 의도한 결과다.
     */
    const _id = articleId(proposal.kind, proposal.sourceRecordIds);

    if (isSuperseded(proposal, _id, open)) {
      skippedSuperseded += 1;
      continue;
    }

    const upserted = await insertCandidate(deps.db, proposal, _id, now);
    if (upserted) {
      inserted += 1;
      // 같은 실행 안에서 뒤따르는 제안이 방금 만든 후보를 다시 만들지 않도록 반영한다.
      open.push({ _id, kind: proposal.kind, sourceRecordIds: [...proposal.sourceRecordIds] });
    } else {
      skippedExisting += 1;
    }
  }

  return {
    materialCount: material.length,
    proposed: proposals.length,
    inserted,
    skippedExisting,
    skippedSuperseded,
  };
}

// ---------------------------------------------------------------- 재료 적재

/** 트리거 판정에 필요한 필드만 읽는다. 본문을 끌고 오면 야간 배치가 §7의 격리 요구를 어긴다. */
interface RecordProjection {
  _id: ObjectId;
  type: "incident" | "divergence";
  title: string;
  tags?: string[];
  sanitizeFlags?: ("secret-masked" | "injection-suspect")[];
  status: "draft" | "published";
  createdAt: Date;
  context?: { model?: string; tool?: string; framework?: string };
}

async function loadTriggerRecords(db: Db): Promise<TriggerRecord[]> {
  /**
   * 쿼리에서도 걸러 낸다. `isArticleMaterial`이 순수 함수 쪽에서 같은 조건을 다시 확인하므로
   * **이중 방어**다 — 한쪽이 느슨해져도 다른 한쪽이 남는다. `injection-suspect` 레코드가
   * 발행물의 재료가 되는 것은 조용히 일어나면 되돌릴 수 없는 종류의 사고다(NFR-05).
   */
  const documents = (await db
    .collection("records")
    .find(
      { status: "published", sanitizeFlags: { $ne: "injection-suspect" } },
      {
        projection: {
          _id: 1,
          type: 1,
          title: 1,
          tags: 1,
          sanitizeFlags: 1,
          status: 1,
          createdAt: 1,
          context: 1,
        },
      },
    )
    .toArray()) as unknown as RecordProjection[];

  const helpful = await countHelpfulFeedback(db);

  return documents.map((document) => {
    const id = document._id.toHexString();
    return {
      _id: id,
      type: document.type,
      title: document.title,
      tags: document.tags ?? [],
      sanitizeFlags: document.sanitizeFlags ?? [],
      status: document.status,
      createdAt: document.createdAt,
      ...(document.context === undefined ? {} : { context: document.context }),
      helpfulFeedbackCount: helpful.get(id) ?? 0,
    };
  });
}

/**
 * `helped=true` 피드백을 레코드별로 센다. §1 A의 문턱이 이 수치 하나에 걸려 있다.
 *
 * `feedbacks`의 `_id`가 `(project, recordId, query)`에서 유도되므로(T-022) 한 사람이 같은
 * 질의로 몇 번을 눌러도 1건이다 — 즉 이 카운트는 **서로 다른 질의·프로젝트의 수**이고,
 * 그래서 "2건 이상이면 재사용된 지식"이라는 §1 A의 해석이 성립한다.
 */
async function countHelpfulFeedback(db: Db): Promise<Map<string, number>> {
  const rows = (await db
    .collection("feedbacks")
    .aggregate([
      { $match: { helped: true } },
      { $group: { _id: "$recordId", count: { $sum: 1 } } },
    ])
    .toArray()) as unknown as { _id: ObjectId | null; count: number }[];

  const counts = new Map<string, number>();
  for (const row of rows) {
    if (row._id === null) continue;
    counts.set(row._id.toHexString(), row.count);
  }
  return counts;
}

// ---------------------------------------------------------------- 중복 억제

interface OpenArticle {
  readonly _id: ObjectId;
  readonly kind: string;
  readonly sourceRecordIds: readonly string[];
}

async function loadOpenSourceSets(db: Db): Promise<OpenArticle[]> {
  const documents = (await articlesCollection(db)
    .find(
      { status: { $in: [...OPEN_STATUSES] } },
      { projection: { _id: 1, kind: 1, sourceRecordIds: 1 } },
    )
    .toArray()) as unknown as { _id: ObjectId; kind: string; sourceRecordIds: ObjectId[] }[];

  return documents.map((document) => ({
    _id: document._id,
    kind: document.kind,
    sourceRecordIds: document.sourceRecordIds.map((id) => id.toHexString()),
  }));
}

/**
 * 같은 클러스터에 **아직 사람이 판단하지 않은** 아티클이 있으면 새 후보를 내지 않는다.
 *
 * 소스 집합 해시만으로는 부족하다. 패턴 클러스터는 레코드가 하나 늘 때마다 집합이 바뀌므로
 * 해시도 바뀌고, 그러면 같은 태그에 대해 3건짜리·4건짜리·5건짜리 후보가 줄줄이 쌓인다.
 * 사람이 보는 후보 목록이 그 순간 쓸모없어진다 — 문턱을 잘못 잡았을 때와 같은 결과다.
 *
 * **`published`·`rejected`는 억제하지 않는다.** 사람이 3건짜리를 "아직 이르다"고 반려했다면
 * 10건이 됐을 때 다시 제안되는 것이 맞다. 그건 같은 주장이 아니다.
 */
function isSuperseded(
  proposal: ArticleCandidate,
  id: ObjectId,
  open: readonly OpenArticle[],
): boolean {
  const proposed = new Set(proposal.sourceRecordIds);
  return open.some((article) => {
    if (article.kind !== proposal.kind) return false;
    // 완전히 같은 집합은 `$setOnInsert`가 알아서 no-op이므로 여기서 가로채지 않는다 —
    // 멱등성의 근거를 억제 규칙이 아니라 `_id`에 두기 위해서다.
    if (article._id.equals(id)) return false;
    return article.sourceRecordIds.every((sourceId) => proposed.has(sourceId));
  });
}

// ---------------------------------------------------------------- 적재

/** 새로 삽입했으면 true. 이미 있으면 false이며 **기존 문서는 한 필드도 바뀌지 않는다.** */
async function insertCandidate(
  db: Db,
  proposal: ArticleCandidate,
  _id: ObjectId,
  now: Date,
): Promise<boolean> {
  const document: Omit<ArticleDocument, "_id"> = {
    kind: proposal.kind,
    // 입력은 `records._id`에서 온 값이라 항상 유효한 24자 hex다.
    sourceRecordIds: proposal.sourceRecordIds.map((hex) => new ObjectId(hex)),
    title: proposal.title,
    slug: articleSlug(proposal.kind, proposal.label, _id),
    // 배치가 쓸 수 있는 유일한 상태다. 상수로 박지 않고 리터럴로 두는 것이
    // "여기서 다른 값이 나올 수 있다"는 인상을 주지 않는다.
    status: "candidate",
    editHistory: [],
    createdAt: now,
  };

  const result = await articlesCollection(db).updateOne(
    { _id },
    { $setOnInsert: document },
    { upsert: true },
  );
  return result.upsertedCount === 1;
}
