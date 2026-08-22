/**
 * `suggest_resolution` — specs/07 §4. **이 태스크에서는 검색 기반 스텁이다**(T-015 Scope).
 *
 * ---
 * ## 스텁이 무엇까지 하는가 (T-015 결정 3)
 *
 * ### 하지 않는 것 ①: 원인 가설·해결 절차를 지어내지 않는다
 * 근거 없는 해결책 생성 금지는 NFR-02이고, 이 제품이 존재하는 이유 자체다(specs/00 문제 3).
 * 생성은 T-019가 `/v1/answer`를 붙이면서 온다. 그때까지 이 도구는 **인용 후보 목록**을
 * 돌려주고 "가설은 아직 없다"고 말한다. 그럴듯한 문장을 만들어 두면 T-019 전까지
 * 근거 없는 답변이 실제로 유통되며, 그건 이 도구가 막으려는 바로 그것이다.
 *
 * ### 하지 않는 것 ②: 임계값 게이트를 흉내내지 않는다
 * `specs/03 §4`의 게이트는 **벡터 검색의 원시 cosine 최고점**을 `SIMILARITY_THRESHOLD`와
 * 비교한다. 그 값(`RetrievalResult.maxVectorScore`)은 `/v1/search` 응답에 **실리지 않는다** —
 * `SearchHit.score`는 RRF 융합 점수이고 `specs/03:62`가 "cosine 임계값과 비교할 수 없다"고
 * 못박았다. 스텁이 RRF 점수로 유사 게이트를 만들면 (a) 금지된 척도 비교를 하고,
 * (b) T-019가 진짜 게이트를 붙일 때 **게이트가 두 곳이 되어 갈라진다.**
 * 게다가 `specs/03 §4`는 "벡터 경로 0건일 때의 게이트 동작"을 아직 정하지 않았고
 * (T-018 착수 전 결정 사항) 스텁이 그 답을 먼저 발명해서는 안 된다.
 *
 * ### 하는 것: 0건일 때만 `found:false`
 * "결과가 0건"은 임계값 판정이 아니라 **사실 진술**이다. 어떤 임계값을 쓰든 후보가 없으면
 * 근거도 없으므로, 이 갈래만은 어떤 게이트 구현과도 어긋나지 않는다. 그리고 이 갈래가
 * 살아 있어야 핵심 루프(`없음 → 직접 해결 → record_knowledge`)가 스텁 단계에서도 닫힌다.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SearchRequest } from "@sentinel/contracts";

import type { McpContext } from "../server.js";
import { estimateTokens, MCP_SEARCH_TOKEN_BUDGET, renderSearchHits } from "./format.js";
import { textResult, toToolError } from "./result.js";
import { parseSearchHits } from "./wire.js";
import { MCP_SEARCH_LIMIT_MAX } from "./search-knowledge.js";

const inputSchema = {
  errorText: SearchRequest.shape.query.describe(
    "겪고 있는 에러 메시지나 증상을 그대로 붙여 넣는다. 스택트레이스 전체보다 핵심 줄이 잘 맞는다.",
  ),
  project: SearchRequest.shape.project.describe(
    "특정 프로젝트의 사례로 좁힐 때만 채운다. 비우면 전체 프로젝트에서 찾는다(권장).",
  ),
};

export const SUGGEST_RESOLUTION_DESCRIPTION =
  "에러 텍스트를 그대로 넘기면 관련 있는 과거 기록을 찾아 **인용 후보**로 돌려준다. " +
  "'이 에러 어떻게 고치나'를 한 번에 묻고 싶을 때 부르는 상위 도구다 — " +
  "검색 목록만 훑고 직접 고르고 싶으면 search_knowledge를 부른다. " +
  "유사 사례가 없으면 `found: false`로 답한다. 그때는 직접 해결한 뒤 record_knowledge로 기록하라. " +
  "**현재 이 도구는 검색 기반이라 원인 가설과 해결 절차를 생성하지 않는다** — " +
  "돌려준 recordId를 get_record로 열어 직접 판단해야 한다.";

const NOT_FOUND_LINES = [
  "found: false",
  "suggestRecord: true",
  "유사 사례를 찾지 못했다. 이 에러는 이 지식보관소에 아직 기록이 없다는 뜻이다. " +
    "직접 해결한 뒤 record_knowledge로 기록하면 다음 프로젝트가 같은 자리를 다시 파지 않는다.",
];

const FOUND_HEADER = "found: true (인용 후보 — 원인 가설은 아직 생성되지 않는다)";
const FOUND_FOOTER =
  "위 기록들이 인용 후보다. 이 도구는 현재 검색 기반이라 원인 가설·해결 절차를 만들지 않는다 — " +
  "지어낸 가설을 내놓느니 후보만 주는 편이 낫다. 적용해 볼 후보를 골라 get_record로 전문을 읽어라. " +
  "어느 것도 맞지 않으면 직접 해결한 뒤 record_knowledge로 기록하라.";

export function registerSuggestResolution(server: McpServer, context: McpContext): void {
  server.registerTool(
    "suggest_resolution",
    { title: "에러 해결 후보 제안", description: SUGGEST_RESOLUTION_DESCRIPTION, inputSchema },
    async (args) => {
      try {
        const raw = await context.coreApi.read({
          method: "POST",
          path: "/v1/search",
          body: SearchRequest.parse({
            query: args.errorText,
            ...(args.project === undefined ? {} : { project: args.project }),
            limit: MCP_SEARCH_LIMIT_MAX,
          }),
        });
        const hits = parseSearchHits(raw);
        if (hits.length === 0) return textResult(...NOT_FOUND_LINES);

        // 머리말·꼬리말도 NFR-03 예산 안에서 낸다 — 목록 예산을 그만큼 줄인다.
        const overhead = estimateTokens(`${FOUND_HEADER}\n${FOUND_FOOTER}\n`).high;
        return textResult(
          FOUND_HEADER,
          renderSearchHits(hits, MCP_SEARCH_TOKEN_BUDGET - overhead),
          FOUND_FOOTER,
        );
      } catch (error: unknown) {
        return toToolError("suggest_resolution", error);
      }
    },
  );
}
