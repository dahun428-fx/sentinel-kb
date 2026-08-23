/**
 * 스타일 리포트 입출력. `eval/injection/report-io.ts`와 같은 규약 —
 * 읽기 경로가 따로 있어야 판정을 다시 돌리지 않고도 재현할 수 있다.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  STYLE_REPORT_DIR,
  StyleReport,
  styleReportFileName,
  type StyleReport as StyleReportType,
} from "./report.js";

/**
 * `eval/style/` 기준 레포 루트. `url.pathname`이 아니라 `fileURLToPath`를 쓴다 —
 * 경로에 공백·한글이 있으면 pathname은 퍼센트 인코딩이라 엉뚱한 디렉터리를 만든다.
 */
export const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

export function styleReportPath(date: string, rootDir: string): string {
  return join(rootDir, STYLE_REPORT_DIR, styleReportFileName(date));
}

/** 파일명의 날짜는 리포트 안의 `date`에서 나온다 — 둘이 어긋나면 시계열이 거짓말이 된다. */
export async function writeStyleReport(report: StyleReportType, rootDir: string): Promise<string> {
  const path = styleReportPath(report.date, rootDir);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return path;
}

/** 손상된 리포트는 여기서 죽는다 — 조용히 통과시키지 않는다. */
export async function readStyleReport(path: string): Promise<StyleReportType> {
  return StyleReport.parse(JSON.parse(await readFile(path, "utf8")));
}
