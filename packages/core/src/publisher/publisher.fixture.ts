/**
 * 파이프라인 fixture. **T-030의 고정 시드 레코드(`facts.fixture.ts`)를 그대로 쓴다** —
 * 발행 경로의 위험(마스킹된 레코드·플래그 없는 잔여 유출·플래그 없는 일본어 인젝션)이
 * 이미 그 fixture에 심겨 있고, 여기서 새로 지어내면 그 난이도가 사라진다.
 *
 * 초안 본문은 **손으로 썼다.** 모델을 부를 수 없는 환경(API 키 없음, specs/05)에서
 * "린터와 팩트 대조가 실제로 무엇을 통과시키고 무엇을 막는가"를 재려면 통과하는 본문과
 * 위반하는 본문이 둘 다 있어야 한다. 통과 본문이 하나도 없으면 이 파이프라인은
 * **모든 것을 반려하는 장치**여도 테스트가 초록이다.
 */
import type { ArticleFacts } from "../facts/types.js";
import { extractFacts } from "../facts/extract.js";
import { FACT_FIXTURE_RECORDS } from "../facts/facts.fixture.js";

/** T-030 fixture로 만든 팩트 팩. 패턴 아티클 기준. */
export function fixtureFacts(): ArticleFacts {
  return extractFacts({ kind: "pattern", records: FACT_FIXTURE_RECORDS }).facts;
}

/**
 * 린트와 팩트 대조를 **둘 다** 통과하는 본문.
 * 수치·날짜·인용은 전부 `fixtureFacts()`에 실재하는 값이다.
 */
export const ACCEPTED_DRAFT = `2026-03-02, \`pnpm install\` 직후 vitest가 즉시 죽었다. 로그에 남은 것은 한 줄이었다.

\`\`\`
Error: The package "@esbuild/darwin-arm64" could not be found, and is needed by esbuild
MongoServerSelectionError: getaddrinfo ENOTFOUND _mongodb._tcp.cluster0.example.mongodb.net
\`\`\`

같은 프로젝트에서 63일 동안 7건이 쌓였고, 그중 5건이 사건이고 2건이 이격이다.

## 몇 번이었나

재발 간격은 고르지 않았다. 타임라인의 8점을 순서대로 읽으면 2026-03-16과 2026-03-18 사이는 이틀이다. 2026-04-06에서 2026-04-13까지는 일주일이 걸렸다. 간격이 짧아지는 구간은 앞선 조치가 절반만 적용된 뒤였다.

## 매번 달랐던 것

겉으로 드러난 문자열은 매번 달랐다. 어떤 날은 \`pnpm approve-builds\`가 필요했다. 2026-04-27의 실패는 \`docker compose exec api env\`로 주입된 값을 확인하고 나서야 갈렸다.

## 매번 같았던 것

같았던 것은 진단의 첫 수였다. \`dig SRV _mongodb._tcp.cluster0.example.net\`처럼 한 겹 아래를 직접 물어보는 명령이 매번 답을 갈랐다. \`pnpm-workspace.yaml\`을 고치는 것도, \`pnpm 10\`의 기본값을 되돌리는 것도 같은 성질의 조치였다. 요컨대 기본값이 바뀐 지점을 찾는 일이 반복됐다.

## 무엇을 바꿔야 멈추나

\`pnpm install --frozen-lockfile\`을 CI에 고정하는 것으로는 절반만 막힌다. 나머지 절반은 2026-05-04처럼 캐시 키가 낡은 채로 배포된 축이고, 그 축은 아직 열려 있다.
`;

/** 팩트 팩에 없는 수치(`97`)를 심은 초안. §3 "facts에 없는 숫자는 반려 사유다". */
export const DRAFT_WITH_INVENTED_NUMBER = ACCEPTED_DRAFT.replace(
  "63일 동안 7건이 쌓였고",
  "63일 동안 97건이 쌓였고",
);

/** 팩트 팩에 없는 명령어를 인용한 초안. */
export const DRAFT_WITH_INVENTED_COMMAND = ACCEPTED_DRAFT.replace(
  "`pnpm approve-builds`",
  "`pnpm rebuild --recursive --offline`",
);

/** 팩트 팩의 타임라인에 없는 날짜를 쓴 초안. */
export const DRAFT_WITH_INVENTED_DATE = ACCEPTED_DRAFT.replace("2026-04-27", "2026-06-11");

/** 팩트 팩에 없는 로그 줄을 코드 블록에 넣은 초안. */
export const DRAFT_WITH_INVENTED_LOG = ACCEPTED_DRAFT.replace(
  "MongoServerSelectionError: getaddrinfo ENOTFOUND _mongodb._tcp.cluster0.example.mongodb.net",
  "FATAL: heap out of memory while linking 4210 modules",
);

/** 모델이 산술을 한 초안. 팩트 팩에 비율은 없다 — §0-1 "통계는 코드가 계산한다". */
export const DRAFT_WITH_DERIVED_RATIO = ACCEPTED_DRAFT.replace(
  "그중 5건이 사건이고 2건이 이격이다",
  "그중 71%가 사건이고 나머지가 이격이다",
);
