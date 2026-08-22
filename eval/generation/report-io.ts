/**
 * 리포트 파일 입출력. T-020 Scope: `eval/reports/{date}-generation.json`.
 *
 * 읽기 경로가 따로 있는 이유는 **회귀 가드를 리포트 하나만으로 재실행할 수 있어야** 하기
 * 때문이다(`check-baseline.cli.ts`). 모델을 다시 부르지 않고도 판정을 재현할 수 있어야
 * "가드가 진짜로 동작하는가"를 증명할 수 있다. T-013·T-016과 같은 규약이다.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  GenerationReport,
  GENERATION_REPORT_DIR,
  generationReportFileName,
  type GenerationReport as GenerationReportType,
} from "./report.js";

/**
 * `eval/generation/` 기준 레포 루트. cwd에 의존하지 않는다.
 * `url.pathname`이 아니라 `fileURLToPath`를 쓴다 — 경로에 공백·한글이 있으면 pathname은
 * 퍼센트 인코딩된 문자열이라 `mkdir`이 엉뚱한 디렉터리를 만든다.
 */
export const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

export function generationReportPath(date: string, rootDir: string): string {
  return join(rootDir, GENERATION_REPORT_DIR, generationReportFileName(date));
}

/**
 * 리포트를 쓴다. **파일명의 날짜는 리포트 안의 `date`에서 나온다** — 인자로 따로 받으면
 * 둘이 어긋난 파일이 만들어지고, 시계열을 날짜로 읽는 순간 거짓말이 된다.
 */
export async function writeGenerationReport(
  report: GenerationReportType,
  rootDir: string,
): Promise<string> {
  const path = generationReportPath(report.date, rootDir);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return path;
}

/** 파일에서 읽어 스키마로 파싱한다. 손상된 리포트는 여기서 죽는다 — 조용히 통과시키지 않는다. */
export async function readGenerationReport(path: string): Promise<GenerationReportType> {
  return GenerationReport.parse(JSON.parse(await readFile(path, "utf8")));
}
