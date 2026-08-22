/**
 * 리포트 파일 입출력. specs/05: `eval/reports/YYYY-MM-DD-retrieval.json` 커밋.
 *
 * 읽기 경로가 따로 있는 이유는 **회귀 가드를 리포트 하나만으로 재실행할 수 있어야** 하기
 * 때문이다(`check-baseline.cli.ts`). 검색을 다시 돌리지 않고도 판정을 재현할 수 있어야
 * "가드가 진짜로 동작하는가"를 증명할 수 있고, 커밋된 과거 리포트에 대해서도 같은 판정을
 * 돌려볼 수 있다.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  RetrievalReport,
  RETRIEVAL_REPORT_DIR,
  retrievalReportFileName,
  type RetrievalReport as RetrievalReportType,
} from "./report.js";

/**
 * `eval/retrieval/` 기준 레포 루트. cwd에 의존하지 않는다.
 * `url.pathname`이 아니라 `fileURLToPath`를 쓴다 — 경로에 공백·한글이 있으면 pathname은
 * 퍼센트 인코딩된 문자열이라 `mkdir`이 엉뚱한 디렉터리를 만든다.
 */
export const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

export function retrievalReportPath(date: string, rootDir: string): string {
  return join(rootDir, RETRIEVAL_REPORT_DIR, retrievalReportFileName(date));
}

/**
 * 리포트를 쓴다. **파일명의 날짜는 리포트 안의 `date`에서 나온다** — 인자로 따로 받으면
 * 둘이 어긋난 파일이 만들어지고, 시계열을 날짜로 읽는 순간 거짓말이 된다.
 */
export async function writeRetrievalReport(
  report: RetrievalReportType,
  rootDir: string,
): Promise<string> {
  const path = retrievalReportPath(report.date, rootDir);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return path;
}

/** 파일에서 읽어 스키마로 파싱한다. 손상된 리포트는 여기서 죽는다 — 조용히 통과시키지 않는다. */
export async function readRetrievalReport(path: string): Promise<RetrievalReportType> {
  return RetrievalReport.parse(JSON.parse(await readFile(path, "utf8")));
}
