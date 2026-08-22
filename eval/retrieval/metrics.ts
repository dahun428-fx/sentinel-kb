/**
 * Recall@5·MRR 계산. 출처: specs/05 "Eval 1: Retrieval".
 *
 * **순수 함수만 있다.** 검색도 DB도 파일도 모른다 — 지표의 정의가 네트워크 코드와 섞이면
 * 지표가 왜 그 값인지를 테스트로 잠글 수 없다.
 *
 * ## 정의 (여기서 못박는다)
 *
 * ### 랭킹의 단위는 **record**다, 청크가 아니다
 * `/v1/search`는 청크 단위 hit을 돌려주고 `specs/03 §2`의 dedupe 때문에 한 record가
 * 최대 2개 슬롯을 먹는다. 골든셋의 정답은 `expectedRecordIds`(record)이므로
 * **첫 등장 순서로 record를 접은 뒤** 순위를 매긴다. 접지 않으면 "record 3건이 5슬롯을
 * 채운 결과"와 "record 5건이 채운 결과"가 같은 척도로 비교된다.
 *
 * ### Recall@5는 **적중률**이다 (정답 집합의 커버리지가 아니다)
 * `expectedRecordIds`가 배열인 이유는 "정답이 여러 개 다 나와야 한다"가 아니라
 * **모호 클러스터를 열거해 해소하기 위해서**다(T-013 Findings: BGP 전역 장애 PUB-08·13·14·11,
 * Mongo "연결 안 됨" INC-04·05·07 …). 그 넷 중 어느 것이 1위로 와도 사용자에게는 정답이다.
 * 따라서 `recall@5 = (정답 중 하나라도 top-5 record에 있는 케이스 수) / (전체 케이스 수)`다.
 * 커버리지로 정의하면 4건짜리 클러스터는 top-5로 최대 0.25밖에 못 받아 지표가 무의미해진다.
 *
 * ### MRR도 같은 top-k 랭킹 위에서 잰다 (= MRR@5)
 * `baselines.json`이 `recall@5`와 `mrr`을 한 쌍으로 묶어 두었으므로 두 지표는 같은 모집단을
 * 봐야 한다. top-5 밖의 정답은 recall에서 0인데 MRR에서만 1/9을 받는 비대칭을 만들지 않는다.
 *
 * ## ⚠️ 동점 점수는 지표를 흔든다 (T-011 F-9)
 * atlas-local의 `$vectorSearch`는 **같은 점수를 갖는 후보의 순서를 보장하지 않는다.**
 * T-011에서 이걸 어겨 테스트가 간헐 실패했고 뮤테이션 3건이 가짜로 죽었다.
 * eval에서 같은 일이 나면 **기준선 자체가 무의미해진다** — 어제의 0.83과 오늘의 0.80이
 * 코드 변경 때문인지 동전 던지기 때문인지 구별할 수 없다.
 *
 * 그래서 숨기지 않고 **드러낸다**: `ambiguousTie`는 "점수가 같은데 정답 여부가 다른 record 쌍이
 * 컷오프 창 안에 있는가"다. 참이면 그 케이스의 결과는 실행마다 달라질 수 있다.
 * 리포트가 이 수를 집계하고, 0이 아니면 경고가 붙는다.
 * (정답 여부가 **같은** 동점 쌍은 순서가 바뀌어도 recall·MRR이 변하지 않으므로 세지 않는다.)
 */

/** specs/05가 고정한 컷오프. 지표 이름(`recall@5`)과 `baselines.json` 키가 이 값에 묶여 있다. */
export const RECALL_K = 5;

/** `/v1/search` 결과 1건에서 지표가 필요로 하는 최소 형상. */
export interface RankedHit {
  readonly recordId: string;
  readonly score: number;
}

/** record 단위로 접은 뒤의 1건. `score`는 그 record가 처음 등장한 청크의 점수다. */
export interface RankedRecord {
  readonly recordId: string;
  readonly score: number;
}

/**
 * 청크 hit을 record 랭킹으로 접는다. **첫 등장이 이긴다** —
 * 응답이 이미 점수 내림차순이므로 첫 등장이 그 record의 최고 점수다.
 */
export function toRecordRanking(hits: readonly RankedHit[]): RankedRecord[] {
  const seen = new Set<string>();
  const ranking: RankedRecord[] = [];
  for (const hit of hits) {
    if (seen.has(hit.recordId)) continue;
    seen.add(hit.recordId);
    ranking.push({ recordId: hit.recordId, score: hit.score });
  }
  return ranking;
}

/**
 * 컷오프 판정에 실제로 영향을 줄 수 있는 창.
 *
 * top-k에 더해, **k번째와 점수가 같은 뒤쪽 record 전부**를 포함한다. 순서가 뒤집히면
 * 그중 하나가 top-k 안으로 들어오기 때문이다. `slice(0, k+1)`로 끝내면 k, k+1, k+2가
 * 모두 동점인 경우를 놓친다.
 */
export function cutoffWindow(ranking: readonly RankedRecord[], k: number): RankedRecord[] {
  if (k < 1) return [];
  if (ranking.length <= k) return [...ranking];
  const boundary = ranking[k - 1];
  const window = ranking.slice(0, k);
  if (boundary === undefined) return window;
  for (let index = k; index < ranking.length; index += 1) {
    const candidate = ranking[index];
    if (candidate === undefined || candidate.score !== boundary.score) break;
    window.push(candidate);
  }
  return window;
}

/**
 * 결과가 동점 때문에 실행마다 달라질 수 있는가.
 * 점수가 같은데 **정답 여부가 다른** 쌍이 있으면 참이다 — 그 쌍의 순서가 곧 지표를 바꾼다.
 */
export function hasAmbiguousTie(
  window: readonly RankedRecord[],
  expected: ReadonlySet<string>,
): boolean {
  for (let i = 0; i < window.length; i += 1) {
    const left = window[i];
    if (left === undefined) continue;
    for (let j = i + 1; j < window.length; j += 1) {
      const right = window[j];
      if (right === undefined) continue;
      if (left.score !== right.score) continue;
      if (expected.has(left.recordId) !== expected.has(right.recordId)) return true;
    }
  }
  return false;
}

/** 케이스 1건의 판정 결과. 리포트의 `cases[]`가 이걸 그대로 싣는다. */
export interface CaseOutcome {
  /** top-k까지의 record 순서. 회귀 분석이 "무엇이 대신 올라왔나"를 보는 유일한 근거다. */
  readonly rankedRecordIds: readonly string[];
  /** 정답이 처음 나온 순위(1-based). top-k 안에 없으면 null이다 — 0이 아니다. */
  readonly firstHitRank: number | null;
  readonly hit: boolean;
  readonly reciprocalRank: number;
  /** 참이면 이 케이스의 결과는 재실행 시 달라질 수 있다. 위 파일 주석 참조. */
  readonly ambiguousTie: boolean;
}

export function scoreCase(
  hits: readonly RankedHit[],
  expectedRecordIds: readonly string[],
  k: number = RECALL_K,
): CaseOutcome {
  const expected = new Set(expectedRecordIds);
  const ranking = toRecordRanking(hits);
  const topK = ranking.slice(0, k);

  let firstHitRank: number | null = null;
  for (let index = 0; index < topK.length; index += 1) {
    const record = topK[index];
    if (record !== undefined && expected.has(record.recordId)) {
      firstHitRank = index + 1;
      break;
    }
  }

  return {
    rankedRecordIds: topK.map((record) => record.recordId),
    firstHitRank,
    hit: firstHitRank !== null,
    reciprocalRank: firstHitRank === null ? 0 : 1 / firstHitRank,
    ambiguousTie: hasAmbiguousTie(cutoffWindow(ranking, k), expected),
  };
}

/** 한 그룹(전체 / 질의 종류별)의 집계. */
export interface MetricSummary {
  readonly caseCount: number;
  readonly recall: number;
  readonly mrr: number;
  readonly ambiguousTieCount: number;
}

/**
 * 소수 4자리로 자른다. 부동소수 꼬리가 리포트 diff를 매번 더럽히면 시계열이 안 읽힌다.
 * 기준선 비교는 반올림 **이후** 값으로 한다 — 리포트에 적힌 수와 판정이 어긋나면 안 된다.
 */
export function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/**
 * **케이스가 0건이면 0이 아니라 0건임을 그대로 남긴다.**
 * 호출자는 `caseCount === 0`인 그룹의 `recall`을 기준선과 비교하면 안 된다 —
 * "측정했더니 0"과 "측정한 적 없음"은 다르다. 그 판정은 baseline-guard가 한다.
 */
export function aggregate(outcomes: readonly CaseOutcome[]): MetricSummary {
  if (outcomes.length === 0) {
    return { caseCount: 0, recall: 0, mrr: 0, ambiguousTieCount: 0 };
  }
  const hits = outcomes.filter((outcome) => outcome.hit).length;
  const reciprocalSum = outcomes.reduce((sum, outcome) => sum + outcome.reciprocalRank, 0);
  return {
    caseCount: outcomes.length,
    recall: round4(hits / outcomes.length),
    mrr: round4(reciprocalSum / outcomes.length),
    ambiguousTieCount: outcomes.filter((outcome) => outcome.ambiguousTie).length,
  };
}
