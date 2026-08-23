/**
 * 문체 린터 테스트 — T-031 Acceptance 1
 * "린터 유닛 테스트 15케이스 (금지 표현·대칭 구조·밀도 미달·어미 반복·메타 서두 각각 탐지 + 정상 통과 5)".
 *
 * 위반 케이스는 **규칙 집합이 정확히 일치하는지**를 본다. `toContain`으로 느슨하게 보면
 * 한 본문이 규칙 다섯 개를 동시에 어겨도 통과하고, 그러면 "이 본문이 이 규칙에 걸린다"가
 * 아니라 "이 본문이 뭔가에 걸린다"만 재는 테스트가 된다.
 */
import { describe, expect, it } from "vitest";

import { BANNED_PHRASES, lintDraft, type LintRuleId } from "./lint.js";

/**
 * 위반 없는 기준 본문. 문단이 둘이라 `uniform-paragraphs`(문단 3개 이상에만 적용)와
 * `bullet-per-heading`(소제목 2개 이상)의 사정권 밖이고, 코드 블록과 날짜·명령어가 있어
 * 밀도 하한을 넘는다. 아래 위반 케이스는 전부 이 본문의 **국소 변형**이다.
 */
const CLEAN = `2026-03-02에 \`pnpm install\`이 죽었다. 로그는 한 줄이었다.

\`\`\`
Error: could not be found
\`\`\`

원인은 pnpm 10이 postinstall을 막은 것이었다.
`;

function rules(body: string): LintRuleId[] {
  return [...new Set(lintDraft(body).violations.map((violation) => violation.rule))].sort();
}

describe("lintDraft — 위반 탐지", () => {
  it("1. 금지 표현을 잡는다", () => {
    const body = CLEAN.replace("원인은", "결론적으로 원인은");
    expect(rules(body)).toEqual(["banned-phrase"]);
  });

  it("2. 스펙이 열거한 금지 표현 여섯 개가 각각 잡힌다", () => {
    for (const phrase of BANNED_PHRASES) {
      const body = CLEAN.replace("원인은", `${phrase} 원인은`);
      expect(rules(body), phrase).toEqual(["banned-phrase"]);
    }
    expect(BANNED_PHRASES).toHaveLength(6);
  });

  it("3. 이모지를 잡는다", () => {
    expect(rules(CLEAN.replace("죽었다", "죽었다 🎉"))).toEqual(["emoji"]);
  });

  it("4. 한 문장의 과장 수식 연쇄를 잡는다", () => {
    const body = CLEAN.replace(
      "원인은 pnpm 10이 postinstall을 막은 것이었다.",
      "원인은 매우 놀라운 pnpm 10의 기본값이었다.",
    );
    expect(rules(body)).toEqual(["hype-chain"]);
  });

  it("5. 3개 항목 대칭 나열이 2회 반복되면 잡는다", () => {
    const body = `${CLEAN}
- pnpm
- esbuild
- postinstall

- dns
- srv
- atlas
`;
    expect(rules(body)).toEqual(["symmetric-triples"]);
  });

  it("6. 모든 문단의 문장 수가 ±1 안에 있으면 잡는다", () => {
    const body = `2026-03-02에 \`pnpm install\`이 죽었다. 로그는 한 줄이었다.

\`\`\`
Error: could not be found
\`\`\`

원인은 pnpm 10의 기본값이었다. 조치는 승인 목록이었다.

재현은 2026-03-16에도 됐다. 같은 자리에서 막혔다.
`;
    expect(rules(body)).toEqual(["uniform-paragraphs"]);
  });

  it("7. 소제목마다 불릿 목록이 붙으면 잡는다", () => {
    const body = `2026-03-02에 \`pnpm install\`이 죽었다. 로그는 한 줄이었다.

\`\`\`
Error: could not be found
\`\`\`

## 증상

- 설치는 끝난다
- 실행이 죽는다

## 조치

- 승인 목록을 만든다
- 다시 설치한다
`;
    expect(rules(body)).toEqual(["bullet-per-heading"]);
  });

  it("8. 밀도가 1000자당 3개 미만이면 잡는다", () => {
    const filler = (
      "특별한 수치 없이 같은 이야기를 늘여 쓰면 밀도 규칙에 걸린다. " +
      "재료가 얇다는 뜻이기도 하다. 그래서 초안을 반려한다. 되짚을 근거가 없기 때문이다. "
    ).repeat(4);
    const body = `${filler}

\`\`\`
noop
\`\`\`

그래서 재료가 얇으면 초안을 반려한다.
`;
    expect(rules(body)).toEqual(["fact-density"]);
  });

  it("9. 코드/로그 블록이 없으면 잡는다", () => {
    const body = `2026-03-02에 \`pnpm install\`이 죽었다. 로그는 한 줄이었다.

원인은 pnpm 10이 postinstall을 막은 것이었다.
`;
    expect(rules(body)).toEqual(["missing-code-block"]);
  });

  it("10. 연속 5문장이 같은 어미면 잡는다", () => {
    const body = `2026-03-02에 설치를 재시도했다. 캐시를 삭제했다. 로그를 확인했다. 다시 설치했다. 결국 실패했다.

\`\`\`
Error: could not be found
\`\`\`

원인은 \`pnpm 10\`이 postinstall을 막은 것이었다.
`;
    expect(rules(body)).toEqual(["ending-repetition"]);
  });

  it("11. 메타 서두를 잡는다", () => {
    const body = CLEAN.replace("2026-03-02에", "이 글에서는 2026-03-02에");
    expect(rules(body)).toEqual(["meta-opening"]);
  });

  it("12. 메타 서두는 첫 문단에서만 잡는다 — 본문 중간의 같은 표현은 위반이 아니다", () => {
    const body = CLEAN.replace("원인은", "다음 절에서 살펴보겠습니다. 원인은");
    expect(rules(body)).toEqual([]);
  });
});

describe("lintDraft — 정상 통과", () => {
  it("13. 기준 본문은 통과한다", () => {
    const report = lintDraft(CLEAN);
    expect(report.passed).toBe(true);
    expect(report.violations).toEqual([]);
  });

  it("14. 문단 길이가 고르지 않으면 통과한다", () => {
    const body = `2026-03-02에 \`pnpm install\`이 죽었다.

\`\`\`
Error: could not be found
\`\`\`

원인은 pnpm 10의 기본값이었다. 승인 목록을 만들었다. 다시 설치하니 붙었다.

재현은 2026-03-16에도 됐다. 같은 자리였다.
`;
    expect(rules(body)).toEqual([]);
  });

  it("15. 소제목이 있어도 불릿이 없으면 통과한다", () => {
    const body = `2026-03-02에 \`pnpm install\`이 죽었다. 로그는 한 줄이었다.

\`\`\`
Error: could not be found
\`\`\`

## 증상

설치는 끝나는데 실행이 죽는다.

## 조치

승인 목록을 만들었다. 다시 설치하니 바이너리가 배치됐다. 그러고 나서야 붙었다.
`;
    expect(rules(body)).toEqual([]);
  });

  it("16. 3개 항목 나열이 한 번이면 통과한다 — 반복이 위반이지 나열이 위반이 아니다", () => {
    const body = `${CLEAN}
- pnpm
- esbuild
- postinstall
`;
    expect(rules(body)).toEqual([]);
  });

  it("17. 같은 어미 4문장 연속은 통과한다 — 상한은 5문장이다", () => {
    const body = `2026-03-02에 설치가 죽었다. 로그가 남았다. 캐시를 지웠다. 다시 설치했다.

\`\`\`
Error: could not be found
\`\`\`

원인은 pnpm 10의 기본값이라 승인 목록이 필요했다.
`;
    expect(rules(body)).toEqual([]);
  });
});

describe("lintDraft — 리포트 형상", () => {
  it("총점을 내놓지 않는다 — 점수가 있으면 재작성 루프가 그것을 최적화한다", () => {
    const report = lintDraft(CLEAN);
    expect(Object.keys(report).sort()).toEqual(["lintVersion", "metrics", "passed", "violations"]);
  });

  it("날짜 하나는 구체 팩트 하나로 센다 — 숫자런으로 세면 밀도가 공짜로 부푼다", () => {
    const withDate = lintDraft("2026-03-02에 죽었다.\n\n```\nnoop\n```\n");
    const withNumbers = lintDraft("2026 03 02에 죽었다.\n\n```\nnoop\n```\n");
    expect(withDate.metrics.concreteFacts).toBeLessThan(withNumbers.metrics.concreteFacts);
  });
});
