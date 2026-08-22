/**
 * `search_knowledge` — specs/07 §1. **핵심 루프의 첫 칸이다**(specs/00 "에러 조우 → search_knowledge").
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { RecordType, SearchRequest } from "@sentinel/contracts";

import type { McpContext } from "../server.js";
import { estimateTokens, MCP_SEARCH_TOKEN_BUDGET, renderSearchHits } from "./format.js";
import { textResult, toToolError } from "./result.js";
import { parseSearchHits } from "./wire.js";

/**
 * ## `limit`을 3으로 **클램프**하는 근거 (T-015 결정 1 — 검증 지적으로 재측정·재설계)
 *
 * `specs/07:10`은 `limit?: number(=5)`라고만 쓰고 **상한을 정하지 않았다.** HTTP 계약
 * (`SearchRequest.limit`)의 `max(20)`을 그대로 흘리면 에이전트가 **합법적으로**
 * NFR-03을 깨뜨린다. NFR-03의 주어는 MCP이므로(`specs/00:34`) 묶는 쪽은 HTTP가 아니라 여기다.
 *
 * ### 왜 스키마 `.max(3)`이 아니라 핸들러 클램프인가
 * 최초 구현은 인자 스키마를 `.max(3).default(3)`으로 좁혔는데, 그러면
 * **`specs/07:10`을 읽고 문서상 기본값인 `limit=5`를 넘긴 클라이언트가 결과가 아니라
 * MCP SDK의 `InvalidParams`를 받는다.** 스펙 준수 호출자가 깨지는 것은 예산 방어가 아니라
 * 계약 위반이다(핸들러 안의 `Math.min`도 도달하지 못하는 죽은 코드였다).
 * 지금은 **스키마를 계약대로 열어 두고(1–20, 기본 5)** 핸들러가 3으로 클램프한 뒤
 * "예산 때문에 N건만 냈다"를 응답에 적는다. NFR-03은 그대로 지켜지고 호출자는 깨지지 않는다.
 *
 * ### 3인 근거 — 재보정된 추정기 + 잔여 재배분(water-filling) 배분기로 다시 잰 수치
 * 이전 표(`3 → 98.5% / 758`, `5 → 71.1% / 798`)는 **재현되지 않아 철회했다.**
 * 그 수치는 (a) 2.6배 틀린 토큰 추정기와 (b) 균등 분할 배분기 위에서 나온 값이었다.
 * 추정기를 실 토크나이저로 재보정하고 배분기를 water-filling으로 바꾼 뒤,
 * 시드 50건 · `limit=3`은 **19,600조합 전수**, 4·5는 30,000조합 표본으로 다시 쟀다:
 *
 * | limit | 산문 보존율 | 온전한 요약 | cl100k 최대 | o200k 최대 | recordId 유실 |
 * |---|---|---|---|---|---|
 * | 3 | **87.7%** | **37.1%** | 407 | 292 | 0 |
 * | 4 | 56.3% | 2.0% | 376 | 283 | 0 |
 * | 5 | 40.8% | **0.0%** | 378 | 287 | 0 |
 *
 * 셋 다 예산은 지킨다(렌더러가 강제한다). 갈리는 것은 **품질**이고, 갈림이 이전 보고보다
 * 오히려 더 뚜렷하다: `limit=5`에서는 **온전하게 살아남는 요약이 하나도 없다.**
 * 요약이 첫 한 구절로 잘리면 NFR-03이 약속한 "요약+ID"가 "ID+조각"이 되고, 에이전트는
 * 요약만으로 판단할 수 없어 `get_record`를 더 부른다 — 예산을 지킨 대가로 총비용이 는다.
 *
 * `limit=5`의 낮은 보존율이 **배분기의 성질이지 `limit`의 성질이 아니라는 지적(G5)**은
 * 옳았고 그래서 배분기를 먼저 고쳤다. 그러고도 5는 회복되지 않는다 — 남은 원인은
 * 시드 요약의 분산(중앙값 93자 · 최대 170자)이 아니라 **총량**이다.
 *
 * ### 남는 긴장 (인계)
 * `specs/00`의 성공 지표는 `Recall@5 >= 0.85`인데 1차 인터페이스가 3건만 노출한다.
 * `Recall@5`는 **retrieval eval이 HTTP·retriever 경로에서** 재는 지표라 수치 자체는
 * 영향받지 않지만, 에이전트 표면의 실효 recall이 낮아지는 것은 사실이다.
 * 이건 NFR-03(800토큰)과 정면으로 맞바꾸는 값이라 **인간 비준 대상**이다(Findings F-1).
 */
export const MCP_SEARCH_LIMIT_MAX = 3;
/** 계약(`SearchRequest.limit`)과 `specs/07:10`의 문서상 기본값. 클램프 전 값이다. */
export const MCP_SEARCH_LIMIT_DEFAULT = 5;

/**
 * 도구 인자 스키마는 **contracts 스키마 객체에서 파생한다.** `z`를 직접 import하지 않는 것은
 * 이 레포의 관행이고(zod를 import하는 패키지는 contracts뿐이다) CLAUDE.md의
 * "타입을 다른 곳에 재정의하지 않는다"를 문자 그대로 지키는 방법이기도 하다 —
 * 여기서 하는 일은 정의가 아니라 **설명 부착**뿐이다. 상한은 손대지 않는다(위 참조).
 */
const inputSchema = {
  query: SearchRequest.shape.query.describe(
    "에러 메시지나 증상을 그대로 넣는다. 스택트레이스 전체보다 핵심 한두 줄이 잘 맞는다.",
  ),
  type: RecordType.optional().describe(
    "종류를 좁힐 때만 채운다. incident=장애·버그, divergence=AI 에이전트 산출물이 의도와 벌어진 사례. 비우면 둘 다 검색한다.",
  ),
  project: SearchRequest.shape.project.describe(
    "특정 프로젝트로 좁힐 때만 채운다. 비우면 전체 프로젝트를 검색한다 — 다른 프로젝트의 사례를 찾는 것이 이 지식보관소의 목적이므로 기본값(비움)을 권한다.",
  ),
  limit: SearchRequest.shape.limit.describe(
    `결과 개수. 계약상 1–20이지만 응답 토큰 예산(약 800, NFR-03) 때문에 서버가 ${String(MCP_SEARCH_LIMIT_MAX)}건으로 줄여서 낸다 — 더 큰 값을 보내도 오류가 아니라 ${String(MCP_SEARCH_LIMIT_MAX)}건과 그 사실을 알리는 문구를 받는다. 더 필요하면 질의를 나눠 여러 번 부르는 편이 싸다.`,
  ),
};

/** 클램프가 걸렸을 때 응답에 붙는 안내. 조용히 줄이면 에이전트가 "결과가 3건뿐"으로 읽는다. */
export function clampNote(requested: number, effective: number): string {
  return (
    `참고: limit=${String(requested)}를 요청했지만 응답 토큰 예산(약 ${String(MCP_SEARCH_TOKEN_BUDGET)}, NFR-03) 때문에 ` +
    `상위 ${String(effective)}건만 냈다. 결과가 ${String(effective)}건뿐이라는 뜻이 아니다 — ` +
    "더 보려면 질의를 좁혀 다시 부르거나, 후보를 정했으면 get_record로 전문을 읽어라."
  );
}

export const SEARCH_KNOWLEDGE_DESCRIPTION =
  "과거 트러블슈팅 사례(incident)와 AI 개발 이격 기록(divergence)을 검색한다. " +
  "**에러를 만나면 디버깅을 시작하기 전에 가장 먼저 부른다.** " +
  "결과는 요약 목록이고 본문은 들어 있지 않다 — 실제로 적용해 볼 후보가 생기면 그 recordId로 get_record를 이어서 부른다. " +
  "'이 에러 어떻게 고치나'를 통째로 묻고 싶으면 대신 suggest_resolution을 부른다(이 도구는 목록만 준다). " +
  "결과 1건은 3줄이다: `순위 recordId type/project/section` / 제목 / 요약. " +
  "앞의 번호가 관련도 순위이며 **절대 점수는 제공하지 않는다** — 내부 점수가 순위 융합 점수라 " +
  "백분율이나 임계값으로 해석하면 틀리기 때문이다. 순위끼리의 상대 비교만 유효하다.";

export function registerSearchKnowledge(server: McpServer, context: McpContext): void {
  server.registerTool(
    "search_knowledge",
    { title: "지식보관소 검색", description: SEARCH_KNOWLEDGE_DESCRIPTION, inputSchema },
    async (args) => {
      const requested = args.limit;
      const effective = Math.min(requested, MCP_SEARCH_LIMIT_MAX);
      try {
        // `POST /v1/search`는 부수효과 없는 읽기 POST다 — `read()`가 재시도해도 안전하다.
        const raw = await context.coreApi.read({
          method: "POST",
          path: "/v1/search",
          body: SearchRequest.parse({
            query: args.query,
            ...(args.type === undefined ? {} : { type: args.type }),
            // **인자 `project`를 그대로 흘린다.** 세션 project로 덮어쓰지 않는다 —
            // 다른 프로젝트의 사례를 찾는 것이 이 지식보관소의 존재 이유이고
            // (CLAUDE.md 도그푸딩 프로토콜), `packages/api`도 "쓰기는 자기 project로만,
            // 조회는 크로스 허용"으로 갈라놨다(specs/04). 여기서 세션 스코프를 걸면
            // 크로스 project 검색이 조용히 죽는다.
            ...(args.project === undefined ? {} : { project: args.project }),
            limit: effective,
          }),
        });
        const hits = parseSearchHits(raw);
        if (effective >= requested) return textResult(renderSearchHits(hits));
        // 안내 문구도 NFR-03 예산 **안에서** 낸다 — 목록 예산을 그만큼 줄인다.
        const note = clampNote(requested, effective);
        return textResult(
          renderSearchHits(hits, MCP_SEARCH_TOKEN_BUDGET - estimateTokens(`${note}\n`).high),
          note,
        );
      } catch (error: unknown) {
        return toToolError("search_knowledge", error);
      }
    },
  );
}
