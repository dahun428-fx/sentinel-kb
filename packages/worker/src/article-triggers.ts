/**
 * 아티클 트리거 판정 — **순수 함수.** 출처: specs/08-publishing.md §1 표, §7.
 *
 * DB를 모른다. 입력은 이미 읽어 온 레코드 요약이고 출력은 "후보 제안"이다.
 * 이 분리가 목적인 이유: 트리거 조건은 이 파이프라인에서 **유일하게 판단이 들어가는 지점**이라
 * 8케이스 유닛 테스트로 못박을 수 있어야 하고, 그러려면 Mongo가 끼면 안 된다.
 *
 * ## 이 모듈이 지키는 두 가지 경계
 *
 * 1. **후보만 만든다. 발행하지 않는다.** §1: "트리거 판정은 `articles` 후보 큐에 적재만 한다.
 *    생성 실행은 사람이 후보 목록에서 골라 개시한다." T-022가 `give_feedback`에서
 *    골든셋 자동 승격을 금지한 것과 같은 계열이다 — 문턱을 넘었다는 사실은
 *    **사람에게 보여줄 이유**이지 사람을 건너뛸 이유가 아니다.
 * 2. **`injection-suspect` 레코드는 재료가 되지 않는다.** §7이 "sanitizeFlags 있는 레코드의
 *    원문 인용 금지"라고 적었지만, 아티클은 외부 공개 발행물이라 인용 단계에서 거르는 것으로는
 *    늦다. 후보 집합에 들어간 순간 그 레코드는 팩트 추출(T-030)과 프롬프트(T-031)를 거치고,
 *    T-018이 생성 컨텍스트에서 그것을 제외한 근거(NFR-05)가 여기에도 그대로 적용된다.
 *    **재료 단계에서 잘라낸다.** `secret-masked`는 다르다 — 이미 마스킹돼 안전하고,
 *    원문 인용 금지는 T-030이 인용 후보를 고를 때 지킬 규칙이다.
 */
import type { ArticleKind, DivergenceContext, RecordStatus, SanitizeFlag } from "@sentinel/contracts";

/** 트리거 판정에 필요한 레코드의 최소 형상. 본문은 필요 없다 — 문턱은 메타데이터로 정해진다. */
export interface TriggerRecord {
  /** 24자 hex. */
  readonly _id: string;
  readonly type: "incident" | "divergence";
  readonly title: string;
  readonly tags: readonly string[];
  readonly sanitizeFlags: readonly SanitizeFlag[];
  readonly status: RecordStatus;
  readonly createdAt: Date;
  /** divergence 전용. §1 C가 모델·도구로 묶는 근거다. */
  readonly context?: DivergenceContext;
  /** `helped=true` 피드백 수. §1 A의 문턱. */
  readonly helpfulFeedbackCount: number;
}

/** 트리거가 낸 후보 하나. 아직 아티클이 아니다 — 사람에게 보여줄 제안일 뿐이다. */
export interface ArticleCandidate {
  readonly kind: ArticleKind;
  /** 정렬된 24자 hex 배열. 멱등 키의 입력이다. */
  readonly sourceRecordIds: readonly string[];
  /** 슬러그에 쓰일 사람이 읽는 라벨(태그·모델명·주차 등). */
  readonly label: string;
  readonly title: string;
}

export interface ArticleTriggerThresholds {
  /** §1 A: 단건 레코드의 `helped` 피드백 수. */
  readonly caseHelpfulFeedback: number;
  /** §1 B: 동일 태그 클러스터 크기. */
  readonly patternClusterSize: number;
  /** §1 C: 모델·도구별 divergence 건수. */
  readonly divergenceClusterSize: number;
  /** §1 D: 주간 신규 레코드 수. */
  readonly digestNewRecords: number;
  /**
   * 태그가 코퍼스에서 차지할 수 있는 최대 비율. 이 값을 넘는 태그는 패턴 후보에서 제외한다.
   *
   * **이 문턱이 없으면 배치의 1등 산출물이 소음이다.** 실제 시드 50건에서 상위 태그는
   * `public-postmortem` 20건(40%)·`self-seed` 6건인데, 둘 다 "어디서 수집했는가"를 적은
   * **출처 라벨**이지 실패 양식이 아니다. "우리는 왜 자꾸 public-postmortem에서
   * 넘어지는가"라는 아티클은 문장으로 성립하지 않는다.
   * 코퍼스의 3분의 1 이상에 붙은 태그는 코퍼스를 설명할 뿐 아무것도 변별하지 못한다 —
   * 검색에서 문서빈도가 높은 항이 정보량을 잃는 것과 같은 이유다.
   */
  readonly maxTagDocumentFrequency: number;
}

/** specs/08 §1 표가 적은 값 그대로. `maxTagDocumentFrequency`만 이 레포의 관측에서 왔다. */
export const DEFAULT_ARTICLE_TRIGGER_THRESHOLDS: ArticleTriggerThresholds = {
  caseHelpfulFeedback: 2,
  patternClusterSize: 3,
  divergenceClusterSize: 3,
  digestNewRecords: 5,
  maxTagDocumentFrequency: 1 / 3,
};

export interface EvaluateTriggersOptions {
  /** 다이제스트의 기준 시각. 여기서 **직전 완결 주**를 계산한다. */
  readonly now: Date;
  readonly thresholds?: Partial<ArticleTriggerThresholds>;
}

const MS_PER_DAY = 86_400_000;

/**
 * 아티클 재료가 될 자격이 있는 레코드만 남긴다.
 *
 * **이 함수가 통과시키는 것이 곧 발행물의 재료다.** 두 조건 모두 되돌릴 수 없는 종류의
 * 사고를 막는다: 초안 상태의 미완성 기록이 편찬되는 것, 그리고 프롬프트 인젝션 의심
 * 레코드가 외부 공개 글의 재료가 되는 것(§7, NFR-05).
 */
export function isArticleMaterial(record: TriggerRecord): boolean {
  if (record.status !== "published") return false;
  return !record.sanitizeFlags.includes("injection-suspect");
}

/**
 * 네 유형의 트리거를 모두 판정한다. 반환은 `(kind, sourceRecordIds)` 기준으로 결정론적이며
 * 정렬돼 있다 — 같은 입력은 항상 같은 순서의 같은 후보를 낸다.
 */
export function evaluateArticleTriggers(
  records: readonly TriggerRecord[],
  options: EvaluateTriggersOptions,
): ArticleCandidate[] {
  const thresholds = { ...DEFAULT_ARTICLE_TRIGGER_THRESHOLDS, ...options.thresholds };
  const material = records.filter(isArticleMaterial);

  const candidates = [
    ...caseCandidates(material, thresholds),
    ...patternCandidates(material, thresholds),
    ...divergenceCandidates(material, thresholds),
    ...digestCandidates(material, thresholds, options.now),
  ];

  return candidates.sort((a, b) =>
    a.kind === b.kind
      ? a.sourceRecordIds.join().localeCompare(b.sourceRecordIds.join())
      : a.kind.localeCompare(b.kind),
  );
}

// ---------------------------------------------------------------- A. 케이스 스터디

/**
 * §1 A: `피드백 helped >= 2` 또는 `조회 >= N`.
 *
 * **`조회 >= N`은 구현하지 않는다.** specs/02의 어느 컬렉션에도 조회 카운터가 없고
 * `N`의 값도 스펙에 없다. 없는 데이터로 문턱을 흉내 내면 그 분기는 영원히 거짓이거나
 * 영원히 참이며, 어느 쪽이든 조건이 있다고 **믿게 만드는 것**이 더 나쁘다. (Findings)
 */
function caseCandidates(
  records: readonly TriggerRecord[],
  thresholds: ArticleTriggerThresholds,
): ArticleCandidate[] {
  return records
    .filter((record) => record.helpfulFeedbackCount >= thresholds.caseHelpfulFeedback)
    .map((record) => ({
      kind: "case" as const,
      sourceRecordIds: [record._id],
      label: record.title,
      title: truncateTitle(`케이스 스터디: ${record.title}`),
    }));
}

// ---------------------------------------------------------------- B. 패턴 아티클

/**
 * §1 B: 동일 태그·유사 클러스터 레코드 >= 3건.
 *
 * **"유사 클러스터"는 태그 동일성으로 근사한다.** 임베딩 클러스터링은 벡터 검색을 요구하는데
 * 그건 Atlas 전용이라 야간 배치가 로컬·CI에서 검증 불가능해지고, 무엇보다 클러스터 경계가
 * 실행마다 흔들리면 "동일 소스 집합 해시" 멱등성이 성립하지 않는다. 태그는 사람이 붙인
 * 결정론적 라벨이라 두 성질을 모두 만족한다. (Findings — T-031 이후 재검토 대상)
 */
function patternCandidates(
  records: readonly TriggerRecord[],
  thresholds: ArticleTriggerThresholds,
): ArticleCandidate[] {
  const byTag = new Map<string, TriggerRecord[]>();
  for (const record of records) {
    // 한 레코드가 같은 태그를 두 번 달아도 클러스터 크기를 부풀리지 못하게 한다.
    for (const tag of new Set(record.tags)) {
      const bucket = byTag.get(tag);
      if (bucket === undefined) byTag.set(tag, [record]);
      else bucket.push(record);
    }
  }

  const ceiling = thresholds.maxTagDocumentFrequency * records.length;
  const candidates: ArticleCandidate[] = [];
  for (const [tag, bucket] of byTag) {
    if (bucket.length < thresholds.patternClusterSize) continue;
    if (bucket.length > ceiling) continue; // 코퍼스 라벨 — 위 thresholds 주석 참조
    candidates.push({
      kind: "pattern",
      sourceRecordIds: sortedIds(bucket),
      label: tag,
      title: truncateTitle(`패턴: "${tag}"에서 반복된 ${bucket.length}건`),
    });
  }
  return candidates;
}

// ---------------------------------------------------------------- C. 이격 리포트

/** §1 C: divergence가 **모델·도구 기준** >= 3건. 두 축을 따로 센다. */
function divergenceCandidates(
  records: readonly TriggerRecord[],
  thresholds: ArticleTriggerThresholds,
): ArticleCandidate[] {
  const divergences = records.filter((record) => record.type === "divergence");
  const candidates: ArticleCandidate[] = [];

  for (const axis of ["model", "tool"] as const) {
    const byKey = new Map<string, TriggerRecord[]>();
    for (const record of divergences) {
      const key = record.context?.[axis]?.trim();
      if (key === undefined || key.length === 0) continue;
      const bucket = byKey.get(key);
      if (bucket === undefined) byKey.set(key, [record]);
      else bucket.push(record);
    }

    for (const [key, bucket] of byKey) {
      if (bucket.length < thresholds.divergenceClusterSize) continue;
      candidates.push({
        kind: "divergence-report",
        sourceRecordIds: sortedIds(bucket),
        label: `${axis}-${key}`,
        title: truncateTitle(`이격 리포트: ${key}에서 반복된 ${bucket.length}건`),
      });
    }
  }
  return candidates;
}

// ---------------------------------------------------------------- D. 주간 다이제스트

/**
 * §1 D: 매주 1회, 신규 레코드 >= 5건일 때만.
 *
 * **직전 "완결된" 주만 본다.** 진행 중인 주를 대상으로 삼으면 화요일 실행과 목요일 실행이
 * 서로 다른 소스 집합을 만들어 같은 주의 다이제스트 후보가 여러 개 쌓인다 —
 * 소스 집합 해시 멱등성이 무력해지는 정확한 지점이다. 완결된 주는 더 이상 자라지 않으므로
 * 몇 번을 돌려도 같은 집합이 나온다. "매주 1회"도 이 방식으로 자연히 만족된다.
 */
function digestCandidates(
  records: readonly TriggerRecord[],
  thresholds: ArticleTriggerThresholds,
  now: Date,
): ArticleCandidate[] {
  const { start, end } = lastCompleteWeek(now);
  const inWindow = records.filter(
    (record) => record.createdAt >= start && record.createdAt < end,
  );
  if (inWindow.length < thresholds.digestNewRecords) return [];

  const label = start.toISOString().slice(0, 10);
  return [
    {
      kind: "digest",
      sourceRecordIds: sortedIds(inWindow),
      label,
      title: truncateTitle(`주간 다이제스트: ${label} 주 신규 ${inWindow.length}건`),
    },
  ];
}

/** UTC 월요일 00:00 기준 직전 완결 주 `[start, end)`. */
export function lastCompleteWeek(now: Date): { start: Date; end: Date } {
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  // getUTCDay(): 일요일 0 → 월요일 기준 오프셋으로 옮긴다.
  const daysSinceMonday = (new Date(midnight).getUTCDay() + 6) % 7;
  const thisWeekStart = midnight - daysSinceMonday * MS_PER_DAY;
  return {
    start: new Date(thisWeekStart - 7 * MS_PER_DAY),
    end: new Date(thisWeekStart),
  };
}

// ---------------------------------------------------------------- 공통

function sortedIds(records: readonly TriggerRecord[]): string[] {
  return records.map((record) => record._id).sort();
}

/** `ArticleSchema.title`의 계약 상한(200자). 넘기면 후보 저장이 스키마를 위반한다. */
const TITLE_MAX_CHARS = 200;

function truncateTitle(title: string): string {
  return title.length <= TITLE_MAX_CHARS ? title : `${title.slice(0, TITLE_MAX_CHARS - 1)}…`;
}
