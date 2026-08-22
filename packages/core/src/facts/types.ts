/**
 * 팩트 팩의 형상. 출처: specs/08-publishing.md §3(팩트 추출기)·§5.1(ChartSpec).
 *
 * ## 무엇이 팩트인가 — 이 파일 전체를 지배하는 한 가지 판단
 *
 * 태스크 이름이 계약이다: **결정론**. LLM은 부르지 않는다. 그러면 자유 서술로 쓰인
 * 레코드에서 코드가 뽑을 수 있는 것은 세 종류뿐이고, 팩트 팩에는 그 셋만 들어간다.
 *
 * 1. **구조화된 필드값** — `type`·`severity`·`tags`·`project`·`relations`·`context`·타임스탬프.
 *    사람이 이미 이산값으로 분류해 넣은 것이라 해석이 개입하지 않는다.
 * 2. **그 값들에서 파생된 수치·날짜** — 건수, 분포, 기간, 재발 간격. 순수 산술이다.
 * 3. **본문에서 기계적으로 식별 가능한 스니펫** — 에러 원문·명령어·파일 경로·수치+단위·
 *    버전 문자열·URL. 각각 **허용목록 패턴**에 걸린 구간만, 원문 그대로.
 *
 * ## 무엇이 팩트가 아닌가 (더 중요한 절반)
 *
 * - **자유 서술은 팩트가 아니다.** `title`·`summary`·`symptom`·`rootCause`·`correction`의
 *   산문은 팩트 팩에 **한 글자도 들어가지 않는다.** 이유가 둘이다.
 *   (a) 산문에서 "요지"를 뽑는 것은 결정론적으로 불가능하고, 규칙으로 흉내 내면
 *       규칙이 곧 해석이 되어 같은 레코드가 규칙 개정마다 다른 팩트를 낸다.
 *   (b) **안전.** T-040은 인젝션 탐지가 9/10이고 일본어 축이 미탐이라고 밝혔다. 즉
 *       `injection-suspect` 플래그만 믿으면 안 되는 축이 실재한다. 산문을 통째로 싣지
 *       않으면 그 미탐 축이 발행물로 나가는 경로 자체가 없어진다 — 탐지를 개선하는 것과
 *       달리 이 방어는 언어 수를 늘려도 약해지지 않는다.
 *   대신 서사는 T-031이 쓴다. 그쪽은 LLM이고, LLM에 무엇을 주느냐는 그 태스크의 몫이다.
 * - **추정·분류된 의미는 팩트가 아니다.** `correction` 유형 분류(§3)조차 산문의 뜻이 아니라
 *   **본문에 실재하는 토큰**(경로·확장자)을 근거로만 매긴다. 근거 토큰이 없으면
 *   `unclassified`로 남긴다 — 억지로 분류하면 그건 계산이 아니라 추측이다.
 * - **관측되지 않은 지표는 팩트가 아니다.** 조회수(§1 A의 "조회 >= N")는 데이터가 없다
 *   (T-029 F-1). 없는 것은 0으로 채우지 않고 아예 필드를 만들지 않는다.
 */
import type { ChunkSection, RecordType, Severity } from "@sentinel/contracts";

/** `key`가 몇 건인가. 분포·빈도의 공통 단위. */
export interface FactCount {
  readonly key: string;
  readonly count: number;
}

/** 2차원 빈도(히트맵)의 칸 하나. */
export interface FactCell {
  readonly row: string;
  readonly column: string;
  readonly count: number;
}

/**
 * 본문에서 뽑은 **원문 그대로의** 스니펫. specs/08 §3 "인용 후보".
 *
 * `recordIds`가 비어 있는 항목은 만들어지지 않는다 — 발행물의 모든 인용은 어느 레코드에서
 * 왔는지 되짚을 수 있어야 하고(T-020 인용 검증·T-035 출처 관계와 같은 계열), 출처를 잃은
 * 인용은 그 순간 "코드가 계산한 팩트"가 아니라 출처 불명의 문자열이 된다.
 */
export interface FactEvidence {
  readonly kind: EvidenceKind;
  /** 원문 그대로. 마스킹하거나 다듬지 않는다 — 통과하지 못할 스니펫은 아예 버린다. */
  readonly text: string;
  /** 이 스니펫이 등장한 소스 레코드 전부. 정렬됨. 최소 1건. */
  readonly recordIds: readonly string[];
  /** 등장한 본문 섹션들. 정렬됨. */
  readonly sections: readonly ChunkSection[];
  /** = `recordIds.length`. 여러 레코드에 걸친 **빈도** 지표다. */
  readonly recordCount: number;
}

/**
 * 스니펫의 종류. 전부 **기계적으로 식별 가능한** 형상이다.
 * `error`·`command`가 §3이 명시한 "인용 후보"이고, 나머지 넷은 밀도 근거(§0-2)로 쓰이는
 * 부가 신호다 — 둘을 한 배열에 섞지 않는 이유는 `ArticleFacts` 주석에 있다.
 */
export const EVIDENCE_KINDS = ["error", "command", "path", "metric", "version", "url"] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

/** 인용 후보로 쓰이는 종류. specs/08 §3: "에러 원문·명령어 스니펫". */
export const CITATION_KINDS: readonly EvidenceKind[] = ["error", "command"];

/** 타임라인의 한 점. specs/08 §3 "레코드 createdAt + incident timeline 필드 병합". */
export interface FactTimelineEntry {
  /** ISO-8601 UTC. */
  readonly at: string;
  readonly recordId: string;
  readonly event: "created" | "updated";
  readonly type: RecordType;
  readonly severity: Severity;
}

/** 명시적 재발 관계 1건. `relations`는 사람이 직접 연결한 값이라 해석이 개입하지 않는다. */
export interface FactRecurrenceLink {
  readonly recordId: string;
  readonly type: "recurrence_of" | "same_root_cause";
  readonly targetRecordId: string;
  /** 대상이 이 아티클의 소스 집합 안에 있는가. 밖이면 아티클 밖을 가리키는 주장이다. */
  readonly withinSourceSet: boolean;
}

/**
 * `correction`이 무엇을 고쳤는지. **근거 토큰이 있을 때만** 매긴다.
 * 우선순위는 배열 순서 그대로이며, 한 레코드는 정확히 한 칸에만 들어간다(합 = 건수).
 */
export const CORRECTION_CATEGORIES = ["spec", "test", "config", "code", "unclassified"] as const;
export type CorrectionCategory = (typeof CORRECTION_CATEGORIES)[number];

/** 분류 1건과 **그 근거**. 근거를 함께 싣지 않으면 분류는 검증 불가능한 주장이 된다. */
export interface FactCorrection {
  readonly recordId: string;
  readonly category: CorrectionCategory;
  /** 분류 근거가 된 본문 토큰(원문 그대로). `unclassified`면 없다. */
  readonly marker?: string;
}

/** divergence 집계. specs/08 §3 "모델별·도구별 빈도, correction 유형 분류". */
export interface FactDivergence {
  readonly count: number;
  readonly byModel: readonly FactCount[];
  readonly byTool: readonly FactCount[];
  readonly byFramework: readonly FactCount[];
  readonly correctionCategories: readonly FactCount[];
  /** 모델 × correction 유형. §5.1의 "모델×이격유형 히트맵"의 데이터. */
  readonly modelByCorrection: readonly FactCell[];
  readonly corrections: readonly FactCorrection[];
}

/** 기간. 소스 레코드의 `createdAt`에서만 유도한다 — 실행 시각은 쓰지 않는다. */
export interface FactPeriod {
  readonly firstAt: string;
  readonly lastAt: string;
  readonly spanDays: number;
}

/** specs/08 §3 "반복 지표: 동일 클러스터 내 최초~최근 간격, 재발 횟수". */
export interface FactRecurrence {
  readonly occurrences: number;
  readonly spanDays: number;
  /** 연속한 발생 사이의 간격(일). `occurrences - 1`개. */
  readonly intervalsDays: readonly number[];
  readonly meanIntervalDays: number | null;
  readonly maxIntervalDays: number | null;
  readonly minIntervalDays: number | null;
  /** 기록자가 직접 연결한 재발 관계. 추론하지 않는다. */
  readonly links: readonly FactRecurrenceLink[];
}

/**
 * 밀도 지표. specs/08 §0-2 "실데이터 밀도 강제"의 판정 근거를 **여기서 계산해 둔다.**
 * 반려 판정 자체는 초안을 만드는 T-031의 몫이지만, 세는 일은 결정론이므로 여기 있어야 한다.
 */
export interface FactDensity {
  readonly records: number;
  readonly citations: number;
  readonly signals: number;
  readonly timelineEntries: number;
  /** 인용·신호 어느 쪽에서도 근거를 얻지 못한 레코드 수. 높으면 재료가 얇다는 신호다. */
  readonly recordsWithoutEvidence: number;
}

/** 게이트에 걸려 재료에서 빠진 레코드와 그 사유. **조용히 버리지 않는다.** */
export interface FactExclusion {
  readonly recordId: string;
  readonly reason: "injection-suspect" | "injection-detected" | "not-published";
}

/**
 * 팩트 팩. `ArticleSchema.facts`에 그대로 저장된다(T-029가 `z.record(z.unknown())`로 열어 둔 칸).
 *
 * `citations`와 `signals`를 가른 이유: §3이 "인용 후보"라고 부른 것은 에러 원문과 명령어
 * 스니펫 둘뿐이다. 경로·수치·버전·URL은 밀도 근거이지 **본문에 따옴표로 실릴 후보가 아니다.**
 * 한 배열에 섞으면 T-031이 그 구분을 다시 추측해야 하고, 추측하는 순간 §3의 문면이 사라진다.
 */
export interface ArticleFacts {
  /** 팩트 팩의 형상 버전. 저장된 팩트를 나중에 읽을 때 해석 기준이 된다. */
  readonly factsVersion: 1;
  readonly sourceRecordIds: readonly string[];
  readonly counts: {
    readonly records: number;
    readonly incidents: number;
    readonly divergences: number;
  };
  readonly period: FactPeriod;
  readonly distributions: {
    readonly tags: readonly FactCount[];
    readonly severity: readonly FactCount[];
    readonly project: readonly FactCount[];
  };
  /** 소스 레코드 **전부**에 붙은 태그. 여러 레코드에 걸친 교집합이다. */
  readonly commonTags: readonly string[];
  readonly timeline: readonly FactTimelineEntry[];
  readonly recurrence: FactRecurrence;
  /** divergence가 한 건도 없으면 없는 필드다 — 0으로 채운 집계를 만들지 않는다. */
  readonly divergence?: FactDivergence;
  readonly citations: readonly FactEvidence[];
  readonly signals: readonly FactEvidence[];
  readonly density: FactDensity;
  readonly excluded: readonly FactExclusion[];
}
