/**
 * 포트폴리오 지표 산출 (T-028 Scope 5·Acceptance 3).
 *
 * 두 개의 원천만 읽는다.
 *
 * 1. `eval/loop-log.jsonl` — 루프 계측. `.claude/skills/task-loop/SKILL.md` §7이 정한
 *    append-only 로그이고, "자동 완결률"(specs/00 성공 지표)의 **유일한** 원천이다.
 * 2. `eval/reports/YYYY-MM-DD-{kind}.json` — eval 리포트. 각 러너가 남긴 시계열.
 *
 * ## 왜 여기서 숫자를 만들지 않는가
 * 포트폴리오는 숫자를 지어내기 가장 쉬운 자리다. 이 모듈의 규약은 하나다 —
 * **원천에 없는 값은 계산하지 않고, 원천이 비면 0이 아니라 "없음"을 돌려준다.**
 * `resultRate`가 `number | null`인 `tools/dogfood-report.ts`와 같은 규약이다.
 * eval 리포트가 0건일 때 그래프를 "0"으로 그리면 **측정해서 0이 나온 것**처럼 읽힌다.
 * 그래서 `EvalSeries.reports`가 비면 렌더러는 그래프가 아니라 결번 사유를 그린다.
 *
 * ## 왜 `status`를 그대로 믿지 않는가
 * 로그의 `status`에는 규약에 없는 값(`done`)이 섞여 있고, 태스크 파일의 `STATUS:`와
 * 어긋난 항목도 있다(T-013·T-016은 로그가 `PARTIAL`, 파일이 `BLOCKED`).
 * 집계기가 조용히 한쪽을 고르면 그 불일치는 영영 안 보인다. 그래서
 * `LoopMetrics.anomalies`에 **불일치 자체를 싣는다** — 지표가 아니라 계측의 상태다.
 *
 * ## 세 번째 원천 (계측률)
 * `specs/tasks/T-*.md` 파일 수. 완결률의 분모는 "로그에 기록된 태스크"이므로
 * **계측되지 않은 태스크는 분모에 없다.** 그 사실을 감추지 않으려고 계측률
 * (기록된 태스크 / 백로그)을 같은 표에 싣는다. 이 행이 없으면 분모를 좁히는 것이
 * "계측 안 된 것을 없던 일로 만드는" 일이 된다.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";

/** 레포 루트 기준 상대 경로. 문서가 이 상수를 인용하고 가드가 대조한다. */
export const LOOP_LOG_PATH = "eval/loop-log.jsonl";
export const EVAL_REPORT_DIR = "eval/reports";
export const BACKLOG_TASK_DIR = "specs/tasks";

/** `.claude/skills/task-loop/SKILL.md`: "실패 시 최대 3회 IMPLEMENT 복귀". */
export const RETRY_LIMIT = 3;

/** `.claude/skills/task-loop/SKILL.md` §1: "구현 계획 3–7줄 선언". */
export const PLAN_LINES_MIN = 3;
export const PLAN_LINES_MAX = 7;

/** `specs/00-product.md` 성공 지표: "태스크 자동 완결률 >= 70%". 통과시키려고 낮추지 않는다. */
export const TARGET_AUTO_COMPLETION = 0.7;

/**
 * **공식 정의의 이름.** `specs/00-product.md` "태스크 자동 완결률의 정의(공식)" 절이
 * `CompletionRates.withinRetryLimit`를 지목했다. 이 모듈은 그 정의만으로 목표를 판정한다
 * (`LoopMetrics.meetsTarget`). 나머지 둘은 계속 산출하되 **판정에 쓰지 않는다.**
 */
export const OFFICIAL_COMPLETION_KEY = "withinRetryLimit" as const;

/** `.claude/skills/task-loop/SKILL.md` §4 게이트 표. 한 번도 안 걸린 게이트도 0으로 싣는다. */
export const GATES = ["G1", "G2", "G3", "G4", "G5", "G6"] as const;
export type Gate = (typeof GATES)[number];

/**
 * 로그에 실제로 나타난 상태값. `done`은 규약 문서 어디에도 없다 —
 * 지우지 않고 `NON_CANONICAL_STATUSES`로 따로 세는 이유는, 지우면 그 태스크 2건이
 * 분모에서 사라져 완결률이 **올라가기** 때문이다.
 */
export const CANONICAL_STATUSES = ["GREEN", "BLOCKED", "PARTIAL"] as const;
export const NON_CANONICAL_STATUSES = ["done"] as const;
/** 게이트를 전부 통과한 것으로 취급하는 값. `done`은 GREEN의 비규약 동의어다. */
const GREEN_STATUSES = new Set<string>(["GREEN", ...NON_CANONICAL_STATUSES]);

export const EVAL_KINDS = ["retrieval", "tools", "generation", "injection"] as const;
export type EvalKind = (typeof EVAL_KINDS)[number];

/** T-028 Scope 4: "eval 리포트 전/후 비교 그래프 (retrieval, tool-selection, generation)". */
export const GRAPH_KINDS: readonly EvalKind[] = ["retrieval", "tools", "generation"];

/** 줄 번호를 들고 죽는 오류. `tools/dogfood-report.ts`와 같은 규약이다. */
export class LoopLogError extends Error {
  public readonly line: number;
  public constructor(line: number, message: string) {
    super(`${LOOP_LOG_PATH}:${String(line)} — ${message}`);
    this.name = "LoopLogError";
    this.line = line;
  }
}

export interface LoopEntry {
  readonly taskId: string;
  readonly attempts: number;
  readonly failedGate: Gate | null;
  readonly turns: number;
  readonly status: string;
  readonly ts: string;
  /** 없을 수 있다. 없다는 사실이 곧 "PLAN 선언을 기계 판정할 수 없다"이다 (T-000 F-2). */
  readonly planLines: number | null;
  readonly filesRead: readonly string[] | null;
  readonly note: string | null;
  /** 로그 파일에서의 줄 번호. 이상 항목을 사람이 찾아갈 수 있어야 한다. */
  readonly line: number;
}

/**
 * 백로그 태스크 파일 이름. `specs/tasks/README.md`처럼 태스크가 아닌 파일이 섞여 있으므로
 * 이름으로 가른다. 이 정규식이 곧 계측률의 **분모 정의**다.
 */
export const BACKLOG_TASK_FILE_RE = /^T-\d{3}-[A-Za-z0-9-]+\.md$/;

/** 순수 함수. 디렉터리 목록을 받아 백로그 태스크 수를 센다 — 픽스처로 잠글 수 있어야 한다. */
export function countBacklogTasks(fileNames: readonly string[]): number {
  return fileNames.filter((name) => BACKLOG_TASK_FILE_RE.test(name)).length;
}

/**
 * 이 모듈에서 fs를 만지는 **유일한** 지점. 디렉터리가 없으면 0을 돌려주고,
 * 0은 `buildLoopMetrics`에서 "계측률 판정 불가"(null)가 된다 — 0%가 아니다.
 */
export function readBacklogTaskCount(repoRoot: string): number {
  try {
    return countBacklogTasks(readdirSync(join(repoRoot, BACKLOG_TASK_DIR)));
  } catch {
    return 0;
  }
}

function fail(line: number, message: string): never {
  throw new LoopLogError(line, message);
}

function requireString(raw: Record<string, unknown>, key: string, line: number): string {
  const value = raw[key];
  if (typeof value !== "string" || value.trim() === "") {
    fail(line, `\`${key}\`가 비어 있지 않은 문자열이어야 한다.`);
  }
  return value;
}

function requireCount(raw: Record<string, unknown>, key: string, line: number): number {
  const value = raw[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    fail(line, `\`${key}\`가 0 이상의 정수여야 한다.`);
  }
  return value;
}

function optionalPlanLines(raw: Record<string, unknown>, line: number): number | null {
  if (!("planLines" in raw) || raw["planLines"] === undefined || raw["planLines"] === null) {
    return null;
  }
  return requireCount(raw, "planLines", line);
}

function optionalFilesRead(raw: Record<string, unknown>, line: number): readonly string[] | null {
  const value = raw["filesRead"];
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    fail(line, "`filesRead`는 문자열 배열이어야 한다.");
  }
  return value as readonly string[];
}

function parseGate(raw: Record<string, unknown>, line: number): Gate | null {
  const value = raw["failedGate"];
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || !(GATES as readonly string[]).includes(value)) {
    fail(line, `\`failedGate\`는 null이거나 ${GATES.join("|")} 중 하나여야 한다: ${String(value)}`);
  }
  return value as Gate;
}

/**
 * JSONL을 엔트리 배열로. 빈 줄만 건너뛰고 나머지는 전부 판정한다.
 * 깨진 줄을 건너뛰면 지표가 조용히 작아지고, 낮은 이유가 "안 했다"인지
 * "로그가 깨졌다"인지 영영 구분되지 않는다.
 */
export function parseLoopLog(raw: string): LoopEntry[] {
  const entries: LoopEntry[] = [];
  for (const [index, text] of raw.split("\n").entries()) {
    const line = index + 1;
    if (text.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error: unknown) {
      fail(line, `JSON이 아니다: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      fail(line, "한 줄은 객체 하나여야 한다.");
    }
    const raw_ = parsed as Record<string, unknown>;
    const note = raw_["note"];
    entries.push({
      taskId: requireString(raw_, "taskId", line),
      attempts: requireCount(raw_, "attempts", line),
      failedGate: parseGate(raw_, line),
      turns: requireCount(raw_, "turns", line),
      status: requireString(raw_, "status", line),
      ts: requireString(raw_, "ts", line),
      planLines: optionalPlanLines(raw_, line),
      filesRead: optionalFilesRead(raw_, line),
      note: typeof note === "string" && note.trim() !== "" ? note : null,
      line,
    });
  }
  return entries;
}

/**
 * 완결률의 **공식 정의는 `withinRetryLimit`**이다(`specs/00-product.md` 성공 지표 절).
 * 나머지 둘을 지우지 않는 이유는 둘이 틀려서가 아니라 **다른 것을 재기 때문**이고,
 * 셋을 나란히 둬야 정의를 사후에 갈아탄 사실이 눈에 보이기 때문이다.
 * 목표 판정에 쓰이는 것은 `withinRetryLimit` 하나뿐이다(`LoopMetrics.meetsTarget`).
 */
export interface CompletionRates {
  /** 한 번에: `attempts === 1` + 게이트 실패 없음 + 최종 GREEN. 사람 개입 0. **공식 정의 아님.** */
  readonly firstPass: number;
  /** **공식 정의.** 재시도 한도(3회) 안에서 GREEN 도달 — 규약이 정한 정상 경로 안에서 끝난 것. */
  readonly withinRetryLimit: number;
  /** 결국 GREEN 도달. 사람이 BLOCKED를 푼 경우를 포함한다 — 상한이지 **공식 정의 아님.** */
  readonly everGreen: number;
}

export interface LoopMetrics {
  readonly source: string;
  readonly entries: number;
  readonly tasks: number;
  /** 최종 엔트리 기준 상태 분포. 같은 태스크의 여러 엔트리는 마지막 것만 센다. */
  readonly finalStatus: Readonly<Record<string, number>>;
  readonly completion: CompletionRates;
  /**
   * 같은 세 정의의 **분자(태스크 수)**. 비율만 실으면 분모가 무엇이었는지 사라지고,
   * 분모를 바꾼 집계와 안 바꾼 집계를 문서에서도 테스트에서도 구별할 수 없다.
   */
  readonly completionCounts: Readonly<Record<keyof CompletionRates, number>>;
  /**
   * 계측 범위. 완결률의 분모(`tasks`)가 백로그 전체가 아니라는 사실을 **같이 싣는다.**
   * `instrumentedShare`가 null이면 백로그를 세지 못한 것이고 0%가 아니다.
   */
  readonly backlog: {
    /** `specs/tasks/T-*.md` 파일 수. */
    readonly tasks: number;
    /** 계측률 = 기록된 태스크 / 백로그 태스크. */
    readonly instrumentedShare: number | null;
  };
  readonly target: number;
  /**
   * **공식 정의(`withinRetryLimit`) 하나로만 판정한다.**
   *
   * 이전 이름은 `meetsTargetUnderAnyDefinition`이었고 "세 정의 중 하나라도 넘으면 true"였다.
   * 정의가 없던 동안에는 그것이 정직한 상한 표시였지만, `specs/00`이 공식 정의를 가진
   * 지금은 **사후에 유리한 정의를 고르는 것을 허가하는 필드**다 — 실제로 공식 정의는
   * 목표에 미달하는데 `everGreen`이 목표를 넘어 true가 나온다. 그래서 교체했다.
   */
  readonly meetsTarget: boolean;
  /** 엔트리 단위 게이트 실패 분포. 한 번도 안 걸린 게이트도 0으로 싣는다. */
  readonly gateFailures: Readonly<Record<Gate | "none", number>>;
  readonly attempts: {
    readonly total: number;
    /** attempts 합이 가장 큰 태스크와 그 비중. 루프 비용이 어디에 쏠렸는지. */
    readonly heaviestTask: string | null;
    readonly heaviestShare: number | null;
    /** `attempts > RETRY_LIMIT`인 엔트리를 낸 태스크. */
    readonly retryLimitExceeded: readonly string[];
  };
  /** 계측 자체의 건강 상태. 지표가 아니라 "지표를 낼 수 있는가"다. */
  readonly instrumentation: {
    readonly planLinesPresent: number;
    readonly planLinesInRange: number;
    readonly filesReadPresent: number;
    readonly filesReadMin: number | null;
    readonly filesReadMedian: number | null;
    readonly filesReadMax: number | null;
  };
  /** 기계가 발견한 계측 결함. 비어 있는 것이 정상이고, 비어 있지 않으면 그것이 소식이다. */
  readonly anomalies: readonly string[];
}

function isGreen(status: string): boolean {
  return GREEN_STATUSES.has(status);
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? null;
  const lo = sorted[mid - 1] ?? 0;
  const hi = sorted[mid] ?? 0;
  return (lo + hi) / 2;
}

function ratio(numerator: number, denominator: number): number {
  if (denominator === 0) return 0;
  return Math.round((numerator / denominator) * 10_000) / 10_000;
}

/**
 * @param backlogTasks `specs/tasks/T-*.md` 개수. **필수 인자다** — 기본값을 주면 호출부가
 *   깜빡 빠뜨려도 조용히 다른 표가 나오고, README 대조 가드가 무엇 때문에 어긋났는지
 *   알 수 없게 된다. 타입 검사가 모든 호출부를 잡게 둔다.
 */
export function buildLoopMetrics(
  entries: readonly LoopEntry[],
  backlogTasks: number,
): LoopMetrics {
  const byTask = new Map<string, LoopEntry[]>();
  for (const entry of entries) {
    const bucket = byTask.get(entry.taskId);
    if (bucket === undefined) byTask.set(entry.taskId, [entry]);
    else bucket.push(entry);
  }

  const finals = [...byTask.values()].map((rows) => rows[rows.length - 1] as LoopEntry);
  const finalStatus: Record<string, number> = {};
  for (const entry of finals) finalStatus[entry.status] = (finalStatus[entry.status] ?? 0) + 1;

  const tasks = byTask.size;
  const firstPass = finals.filter(
    (entry) => entry.attempts === 1 && entry.failedGate === null && isGreen(entry.status),
  ).length;
  const withinRetryLimit = finals.filter(
    (entry) => isGreen(entry.status) && entry.attempts <= RETRY_LIMIT,
  ).length;
  const everGreen = finals.filter((entry) => isGreen(entry.status)).length;

  const gateFailures: Record<string, number> = { none: 0 };
  for (const gate of GATES) gateFailures[gate] = 0;
  for (const entry of entries) {
    const key = entry.failedGate ?? "none";
    gateFailures[key] = (gateFailures[key] ?? 0) + 1;
  }

  const attemptsTotal = entries.reduce((sum, entry) => sum + entry.attempts, 0);
  const attemptsByTask = new Map<string, number>();
  for (const entry of entries) {
    attemptsByTask.set(entry.taskId, (attemptsByTask.get(entry.taskId) ?? 0) + entry.attempts);
  }
  let heaviestTask: string | null = null;
  let heaviestAttempts = 0;
  for (const [taskId, total] of [...attemptsByTask].sort(([a], [b]) => a.localeCompare(b))) {
    if (total > heaviestAttempts) {
      heaviestAttempts = total;
      heaviestTask = taskId;
    }
  }

  const retryLimitExceeded = [
    ...new Set(entries.filter((e) => e.attempts > RETRY_LIMIT).map((e) => e.taskId)),
  ].sort();

  const planLines = entries.filter((entry) => entry.planLines !== null);
  const filesReadCounts = entries
    .filter((entry) => entry.filesRead !== null)
    .map((entry) => (entry.filesRead ?? []).length);

  const anomalies: string[] = [];
  if (backlogTasks > 0 && tasks > backlogTasks) {
    anomalies.push(
      `${LOOP_LOG_PATH}: 기록된 태스크 ${String(tasks)}개가 백로그 ${String(backlogTasks)}개보다 많다 — 계측률의 분모가 분자를 담지 못한다`,
    );
  }
  for (const entry of entries) {
    if (!(CANONICAL_STATUSES as readonly string[]).includes(entry.status)) {
      anomalies.push(
        `${LOOP_LOG_PATH}:${String(entry.line)} ${entry.taskId}: 규약에 없는 status "${entry.status}"`,
      );
    }
    if (entry.planLines === null) {
      anomalies.push(
        `${LOOP_LOG_PATH}:${String(entry.line)} ${entry.taskId}: planLines 없음 — PLAN 선언을 기계 판정할 수 없다`,
      );
    }
    if (entry.filesRead === null) {
      anomalies.push(
        `${LOOP_LOG_PATH}:${String(entry.line)} ${entry.taskId}: filesRead 없음 — Context budget 준수를 기계 판정할 수 없다`,
      );
    }
  }

  return {
    source: LOOP_LOG_PATH,
    entries: entries.length,
    tasks,
    finalStatus,
    completion: {
      firstPass: ratio(firstPass, tasks),
      withinRetryLimit: ratio(withinRetryLimit, tasks),
      everGreen: ratio(everGreen, tasks),
    },
    completionCounts: { firstPass, withinRetryLimit, everGreen },
    backlog: {
      tasks: backlogTasks,
      instrumentedShare: backlogTasks === 0 ? null : ratio(tasks, backlogTasks),
    },
    target: TARGET_AUTO_COMPLETION,
    meetsTarget: ratio(withinRetryLimit, tasks) >= TARGET_AUTO_COMPLETION,
    gateFailures: gateFailures as Readonly<Record<Gate | "none", number>>,
    attempts: {
      total: attemptsTotal,
      heaviestTask,
      heaviestShare: heaviestTask === null ? null : ratio(heaviestAttempts, attemptsTotal),
      retryLimitExceeded,
    },
    instrumentation: {
      planLinesPresent: planLines.length,
      planLinesInRange: planLines.filter(
        (entry) => (entry.planLines ?? 0) >= PLAN_LINES_MIN && (entry.planLines ?? 0) <= PLAN_LINES_MAX,
      ).length,
      filesReadPresent: filesReadCounts.length,
      filesReadMin: filesReadCounts.length === 0 ? null : Math.min(...filesReadCounts),
      filesReadMedian: median(filesReadCounts),
      filesReadMax: filesReadCounts.length === 0 ? null : Math.max(...filesReadCounts),
    },
    anomalies,
  };
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

/**
 * README가 그대로 품는 표. **README는 이 문자열을 복사해 넣고 가드가 재계산해 대조한다.**
 * 그래서 로그가 늘면 README가 낡고, 낡으면 `pnpm verify`가 빨개진다.
 * 사람이 표를 손으로 고치는 경로는 없다.
 */
export function renderLoopMetricsTable(metrics: LoopMetrics): string {
  const { completion, completionCounts, attempts, instrumentation: inst } = metrics;
  /** 비율만 적으면 분모가 사라진다. 분자·분모를 같이 적어 표가 스스로 분모를 증언하게 한다. */
  const rate = (key: keyof CompletionRates): string =>
    `${percent(completion[key])} (${String(completionCounts[key])}/${String(metrics.tasks)})`;
  const statuses = Object.entries(metrics.finalStatus)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([status, count]) => `${status} ${String(count)}`)
    .join(" · ");
  const gates = GATES.map((gate) => `${gate} ${String(metrics.gateFailures[gate])}`).join(" · ");
  const share = metrics.backlog.instrumentedShare;
  const rows: readonly (readonly [string, string, string])[] = [
    [
      "기록된 태스크",
      `${String(metrics.tasks)}개 (엔트리 ${String(metrics.entries)}줄)`,
      "자동 완결률의 분모",
    ],
    [
      "계측률",
      share === null
        ? "판정 불가 — 백로그를 세지 못했다"
        : `${percent(share)} (${String(metrics.tasks)}/${String(metrics.backlog.tasks)})`,
      `기록된 태스크 / ${BACKLOG_TASK_DIR}의 T-*.md`,
    ],
    ["최종 상태 분포", statuses, "같은 태스크의 마지막 엔트리만"],
    ["완결률 — 한 번에", rate("firstPass"), "attempts=1 + 게이트 실패 0 + GREEN. 참고 지표"],
    [
      "완결률 — 재시도 한도 안",
      rate("withinRetryLimit"),
      `GREEN + attempts <= ${String(RETRY_LIMIT)}. **specs/00 공식 정의**`,
    ],
    ["완결률 — 결국 GREEN", rate("everGreen"), "사람이 BLOCKED를 푼 경우 포함. 참고 지표"],
    [
      "자동 완결률 목표 판정",
      `${percent(completion.withinRetryLimit)} ${metrics.meetsTarget ? ">=" : "<"} ${percent(metrics.target)} — ${metrics.meetsTarget ? "충족" : "미달"}`,
      "공식 정의 하나로만 판정한다",
    ],
    ["게이트 실패(엔트리)", gates, "한 번도 안 걸린 게이트도 0으로 싣는다"],
    [
      "attempts 합",
      `${String(attempts.total)}회 (최다 ${attempts.heaviestTask ?? "-"} ${attempts.heaviestShare === null ? "-" : percent(attempts.heaviestShare)})`,
      "루프 비용이 어디에 쏠렸는가",
    ],
    [
      "재시도 한도 초과",
      attempts.retryLimitExceeded.length === 0 ? "없음" : attempts.retryLimitExceeded.join(", "),
      `attempts > ${String(RETRY_LIMIT)}`,
    ],
    [
      "PLAN 3–7줄 기계 판정",
      `${String(inst.planLinesInRange)}/${String(inst.planLinesPresent)} (planLines 있는 엔트리 ${String(inst.planLinesPresent)}/${String(metrics.entries)})`,
      "planLines가 없으면 판정 불가",
    ],
    [
      "filesRead 파일 수",
      `최소 ${String(inst.filesReadMin ?? 0)} · 중앙값 ${String(inst.filesReadMedian ?? 0)} · 최대 ${String(inst.filesReadMax ?? 0)}`,
      `기록된 엔트리 ${String(inst.filesReadPresent)}/${String(metrics.entries)}`,
    ],
    [
      "계측 결함(anomalies)",
      `${String(metrics.anomalies.length)}건`,
      "0이 정상. 0이 아니면 그것이 소식이다",
    ],
  ];
  const header = "| 지표 | 값 | 정의 |\n| --- | --- | --- |";
  const body = rows.map(([name, value, note]) => `| ${name} | ${value} | ${note} |`).join("\n");
  return `${header}\n${body}`;
}

/* -------------------------------------------------------------------------- */
/* eval 리포트 시계열                                                          */
/* -------------------------------------------------------------------------- */

/** `eval/reports/YYYY-MM-DD-{kind}.json` — 각 러너의 `report-io.ts`가 정한 이름 규약. */
const REPORT_FILE_RE = /^(\d{4}-\d{2}-\d{2})-([a-z]+)\.json$/;

export interface EvalPoint {
  readonly date: string;
  readonly file: string;
  /** 리포트의 `metrics` 객체. 값이 `null`이면 **잴 수 없었다**는 뜻이고 0이 아니다. */
  readonly metrics: Readonly<Record<string, number | null>>;
}

export interface EvalSeries {
  readonly kind: EvalKind;
  readonly reports: readonly EvalPoint[];
  /** 리포트가 0건인 이유. 지어낼 수 없으므로 문장으로 남긴다. */
  readonly absent: boolean;
}

/** 리포트 JSON에서 `metrics`만 방어적으로 꺼낸다. 모양이 다르면 조용히 넘기지 않고 죽는다. */
export function extractMetrics(raw: unknown, file: string): Readonly<Record<string, number | null>> {
  if (typeof raw !== "object" || raw === null || !("metrics" in raw)) {
    throw new Error(`${file}: 최상위 \`metrics\` 키가 없다.`);
  }
  const metrics = (raw as { metrics: unknown }).metrics;
  if (typeof metrics !== "object" || metrics === null || Array.isArray(metrics)) {
    throw new Error(`${file}: \`metrics\`가 객체가 아니다.`);
  }
  const out: Record<string, number | null> = {};
  for (const [key, value] of Object.entries(metrics as Record<string, unknown>)) {
    if (value === null) {
      out[key] = null;
    } else if (typeof value === "number") {
      out[key] = value;
    }
    // 숫자도 null도 아닌 값(중첩 객체 등)은 그래프의 축이 될 수 없으므로 뺀다.
  }
  return out;
}

export interface ReportFile {
  readonly name: string;
  readonly raw: string;
}

/**
 * 디렉터리 목록과 파일 내용을 받아 종류별 시계열로 묶는다.
 * fs를 직접 만지지 않는 이유는 이 함수를 픽스처로 잠글 수 있어야 하기 때문이다 —
 * "리포트가 있으면 그래프가 나온다"를 리포트 없이 검증하려면 순수 함수여야 한다.
 */
export function collectEvalSeries(files: readonly ReportFile[]): Map<EvalKind, EvalSeries> {
  const byKind = new Map<EvalKind, EvalPoint[]>();
  for (const kind of EVAL_KINDS) byKind.set(kind, []);
  for (const file of files) {
    const match = REPORT_FILE_RE.exec(file.name);
    if (match === null) continue;
    const kind = match[2] as EvalKind;
    if (!(EVAL_KINDS as readonly string[]).includes(kind)) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(file.raw);
    } catch (error: unknown) {
      throw new Error(
        `${EVAL_REPORT_DIR}/${file.name}: JSON이 아니다 — ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    byKind.get(kind)?.push({
      date: match[1] ?? "",
      file: file.name,
      metrics: extractMetrics(parsed, `${EVAL_REPORT_DIR}/${file.name}`),
    });
  }
  const out = new Map<EvalKind, EvalSeries>();
  for (const kind of EVAL_KINDS) {
    const reports = (byKind.get(kind) ?? []).sort((a, b) => a.date.localeCompare(b.date));
    out.set(kind, { kind, reports, absent: reports.length === 0 });
  }
  return out;
}

const SVG_W = 640;
const SVG_H = 240;
const PAD = 44;

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * 시계열 하나를 SVG 꺾은선으로. **비어 있으면 빈 그래프가 아니라 결번 사유를 그린다.**
 *
 * 축 없는 빈 그래프는 "0점을 받았다"로 읽히고, 이 레포에서 그 오독은 치명적이다 —
 * retrieval·tools·generation은 **0점이 아니라 아직 한 번도 잰 적이 없다.**
 */
export function renderEvalSvg(series: EvalSeries, reason: string): string {
  const title = `eval:${series.kind}`;
  if (series.absent) {
    return [
      `<svg xmlns="http://www.w3.org/2000/svg" width="${String(SVG_W)}" height="${String(SVG_H)}" viewBox="0 0 ${String(SVG_W)} ${String(SVG_H)}" role="img" aria-label="${escapeXml(title)} — 리포트 없음">`,
      `<rect width="${String(SVG_W)}" height="${String(SVG_H)}" fill="#F7F9F9"/>`,
      `<rect x="0.5" y="0.5" width="${String(SVG_W - 1)}" height="${String(SVG_H - 1)}" fill="none" stroke="#AEBBC0" stroke-dasharray="4 4"/>`,
      `<text x="${String(SVG_W / 2)}" y="${String(SVG_H / 2 - 14)}" text-anchor="middle" font-family="monospace" font-size="15" fill="#0F1A1F">${escapeXml(title)} — 측정된 리포트 0건</text>`,
      `<text x="${String(SVG_W / 2)}" y="${String(SVG_H / 2 + 12)}" text-anchor="middle" font-family="sans-serif" font-size="12" fill="#3E5058">${escapeXml(reason)}</text>`,
      `<text x="${String(SVG_W / 2)}" y="${String(SVG_H / 2 + 34)}" text-anchor="middle" font-family="sans-serif" font-size="11" fill="#8A6512">0점이 아니라 미측정이다. 이 자리를 숫자로 채우지 않는다.</text>`,
      "</svg>",
    ].join("\n");
  }

  const keys = [
    ...new Set(series.reports.flatMap((point) => Object.keys(point.metrics))),
  ].sort();
  const values = series.reports.flatMap((p) =>
    Object.values(p.metrics).filter((v): v is number => v !== null),
  );
  const maxValue = values.length === 0 ? 1 : Math.max(1, ...values);
  const stepX =
    series.reports.length === 1 ? 0 : (SVG_W - PAD * 2) / (series.reports.length - 1);
  const x = (index: number): number =>
    series.reports.length === 1 ? SVG_W / 2 : PAD + index * stepX;
  const y = (value: number): number => SVG_H - PAD - (value / maxValue) * (SVG_H - PAD * 2);
  const palette = ["#1C3D5A", "#2C6B5A", "#8A6512", "#7A2E2E"];

  const lines: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${String(SVG_W)}" height="${String(SVG_H)}" viewBox="0 0 ${String(SVG_W)} ${String(SVG_H)}" role="img" aria-label="${escapeXml(title)}">`,
    `<rect width="${String(SVG_W)}" height="${String(SVG_H)}" fill="#F7F9F9"/>`,
    `<text x="${String(PAD)}" y="22" font-family="monospace" font-size="13" fill="#0F1A1F">${escapeXml(title)} (n=${String(series.reports.length)})</text>`,
    `<line x1="${String(PAD)}" y1="${String(SVG_H - PAD)}" x2="${String(SVG_W - PAD)}" y2="${String(SVG_H - PAD)}" stroke="#AEBBC0"/>`,
    `<line x1="${String(PAD)}" y1="${String(PAD)}" x2="${String(PAD)}" y2="${String(SVG_H - PAD)}" stroke="#AEBBC0"/>`,
  ];
  for (const [keyIndex, key] of keys.entries()) {
    const color = palette[keyIndex % palette.length] ?? "#1C3D5A";
    const points = series.reports
      .map((point, index) => ({ index, value: point.metrics[key] }))
      .filter((p): p is { index: number; value: number } => typeof p.value === "number");
    if (points.length > 1) {
      const path = points.map((p) => `${String(x(p.index))},${String(y(p.value))}`).join(" ");
      lines.push(`<polyline fill="none" stroke="${color}" stroke-width="2" points="${path}"/>`);
    }
    for (const p of points) {
      lines.push(`<circle cx="${String(x(p.index))}" cy="${String(y(p.value))}" r="3" fill="${color}"/>`);
    }
    lines.push(
      `<text x="${String(SVG_W - PAD)}" y="${String(38 + keyIndex * 15)}" text-anchor="end" font-family="sans-serif" font-size="11" fill="${color}">${escapeXml(key)}</text>`,
    );
  }
  for (const [index, point] of series.reports.entries()) {
    lines.push(
      `<text x="${String(x(index))}" y="${String(SVG_H - PAD + 16)}" text-anchor="middle" font-family="monospace" font-size="10" fill="#3E5058">${escapeXml(point.date)}</text>`,
    );
  }
  lines.push("</svg>");
  return lines.join("\n");
}

/** 그래프 3종이 왜 비어 있는지. 원천은 각 태스크 파일의 STATUS이고, 여기서 지어내지 않는다. */
export const ABSENT_REASONS: Readonly<Record<EvalKind, string>> = {
  retrieval: "T-013 BLOCKED — 실 임베딩 자격증명 부재로 Recall@5·MRR 측정 불가",
  tools: "T-016 BLOCKED — tool-calling 실 provider 키 부재로 selectionAccuracy 측정 불가",
  generation: "T-020 판정 불가 — judge 모델 키 부재로 faithfulness·usefulness 측정 불가",
  injection: "T-021 판정 불가 — 방어선 3(프롬프트 내성) 판정에 실 ChatModel 필요",
};

export function evalSvgFileName(kind: EvalKind): string {
  return `portfolio-eval-${kind}.svg`;
}

export const LOOP_METRICS_JSON = "portfolio-loop-metrics.json";
export const LOOP_METRICS_MD = "portfolio-loop-metrics.md";
