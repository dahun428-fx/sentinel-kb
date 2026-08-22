/**
 * `suggest_resolution` — specs/07 §4. **T-019에서 실제 RAG 생성으로 갈아끼웠다.**
 *
 * T-015의 검색 기반 스텁은 인용 후보만 돌려주고 "가설은 아직 없다"고 말했다. 그 스텁이
 * 존재한 이유는 생성 경로가 없었기 때문이고(NFR-02: 근거 없는 해결책 생성 금지), 이제
 * `POST /v1/answer`가 있으므로 본문과 문구 상수를 **통째로** 교체했다(T-015 F-4의 지시).
 *
 * ## 이 도구는 게이트를 **갖지 않는다**
 *
 * 임계값 게이트는 `specs/03 §4`가 정한 대로 **원시 cosine 최고점**으로 판정하며, 그 값
 * (`maxVectorScore`)은 MCP가 볼 수 있는 어떤 응답에도 실리지 않는다 — `SearchHit.score`는
 * RRF 융합 점수이고 `specs/03:62`가 그것으로 cosine 임계값을 재는 것을 금지한다.
 * 그러므로 판정은 `/v1/answer` 한 곳에서만 일어나고, 이 도구는 **결과를 전달**할 뿐이다.
 * 여기에 "점수가 낮으면 버린다" 같은 판단을 얹는 순간 게이트가 두 곳이 되어 갈라지고,
 * 그 둘은 서로 다른 척도를 보게 된다.
 *
 * ## 검색을 따로 부르지 않는다
 *
 * `/v1/answer`가 이미 검색 → 게이트 → 생성을 한 번에 한다. 여기서 `/v1/search`를 덧붙여
 * 부르면 같은 질의로 검색이 두 번 나가고(지연 2배, NFR-01), 두 결과가 어긋날 때
 * 어느 쪽이 인용의 진실인지 알 수 없게 된다.
 *
 * ## 응답에 레코드 본문을 싣지 않는다 (NFR-03, CLAUDE.md 금지 사항)
 *
 * 응답에 담기는 것은 **모델이 쓴 답변 + 인용된 recordId·섹션·제목**뿐이다. 청크 본문은
 * `/v1/answer` 응답에도 없다(T-018 F-3이 지킨 경계). 전문이 필요하면 에이전트가
 * `get_record`를 부른다 — 예산·절단은 `renderAnswer`가 `estimateTokens`+water-filling으로
 * 검색 목록과 **같은 기계**를 써서 지킨다.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AnswerRequest, AnswerResponse, SearchRequest } from "@sentinel/contracts";

import type { McpContext } from "../server.js";
import { estimateTokens, MCP_SEARCH_TOKEN_BUDGET, renderAnswer } from "./format.js";
import { textResult, toToolError } from "./result.js";

const inputSchema = {
  errorText: SearchRequest.shape.query.describe(
    "겪고 있는 에러 메시지나 증상을 그대로 붙여 넣는다. 스택트레이스 전체보다 핵심 줄이 잘 맞는다.",
  ),
  project: SearchRequest.shape.project.describe(
    "특정 프로젝트의 사례로 좁힐 때만 채운다. 비우면 전체 프로젝트에서 찾는다(권장).",
  ),
};

/**
 * ⚠️ description 변경은 **계약 변경**이다(specs/07 "description 작성 규칙", G6).
 * 스텁 시절의 마지막 두 문장("현재 이 도구는 검색 기반이라 원인 가설과 해결 절차를 생성하지
 * 않는다")은 이제 **거짓**이므로 지웠다 — 그대로 두면 에이전트가 이 도구를 부르고도
 * 답변을 무시하고 get_record부터 연다. tool-selection eval 재실행 대상이다(T-016).
 */
export const SUGGEST_RESOLUTION_DESCRIPTION =
  "에러 텍스트를 그대로 넘기면 과거 기록을 검색해 **인용이 달린 원인 가설과 해결 절차**를 만들어 준다. " +
  "'이 에러 어떻게 고치나'를 한 번에 묻고 싶을 때 부르는 상위 도구다 — " +
  "검색 목록만 훑고 직접 고르고 싶으면 search_knowledge를 부른다. " +
  "답변의 모든 주장에는 `[REC-<recordId>#<섹션>]` 인용이 붙고, 그 recordId 목록이 함께 온다. " +
  "근거가 임계값에 못 미치면 답을 지어내지 않고 `found: false`로 답한다. " +
  "그때는 직접 해결한 뒤 record_knowledge로 기록하라.";

/**
 * 근거가 없을 때의 응답. **`found:false`는 이 도구의 판단이 아니라 `/v1/answer`의 판단이다.**
 * 핵심 루프(없음 → 직접 해결 → record_knowledge)를 닫는 것이 이 문구의 목적이다.
 */
const NOT_FOUND_LINES = [
  "found: false",
  "suggestRecord: true",
  "근거가 될 만한 과거 사례를 찾지 못했다. 지식보관소에 이 문제의 기록이 아직 없다는 뜻이며, " +
    "없는 근거로 해결책을 지어내지 않는다. 직접 해결한 뒤 record_knowledge로 기록하면 " +
    "다음 프로젝트가 같은 자리를 다시 파지 않는다.",
];

const FOUND_HEADER = "found: true (아래 답변은 인용된 기록에만 근거한다)";

const FOUND_FOOTER =
  "위 답변의 각 주장에는 `[REC-<recordId>#<섹션>]` 인용이 붙어 있고, 그 아래가 인용된 기록 목록이다. " +
  "적용하기 전에 근거를 확인하려면 recordId로 get_record를 불러 전문을 읽어라. " +
  "해결에 도움이 됐는지는 give_feedback으로 알려주고, 답이 맞지 않았다면 " +
  "직접 해결한 뒤 record_knowledge로 기록하라.";

export function registerSuggestResolution(server: McpServer, context: McpContext): void {
  server.registerTool(
    "suggest_resolution",
    { title: "에러 해결 제안", description: SUGGEST_RESOLUTION_DESCRIPTION, inputSchema },
    async (args) => {
      try {
        /*
         * `read()`로 보낸다 — `/v1/answer`는 아무것도 저장하지 않는 멱등 요청이라
         * `assertIdempotent`의 레코드 변경 경로에 해당하지 않는다.
         * `stream:false`인 이유는 MCP 도구가 결과를 **한 번에** 돌려주는 계약이기 때문이다.
         * SSE는 HTTP 소비자(web UI)를 위한 것이고, 여기서 열면 프레임을 다시 합쳐야 한다.
         */
        const raw = await context.coreApi.read({
          method: "POST",
          path: "/v1/answer",
          body: AnswerRequest.parse({
            query: args.errorText,
            ...(args.project === undefined ? {} : { project: args.project }),
            stream: false,
          }),
        });

        const answer = AnswerResponse.parse(raw);
        if (!answer.found) return textResult(...NOT_FOUND_LINES);

        // 머리말·꼬리말도 NFR-03 예산 안에서 낸다 — 답변·인용 예산을 그만큼 줄인다.
        const overhead = estimateTokens(`${FOUND_HEADER}\n${FOUND_FOOTER}\n`).high;
        return textResult(
          FOUND_HEADER,
          renderAnswer(answer.answer, answer.citations, MCP_SEARCH_TOKEN_BUDGET - overhead),
          FOUND_FOOTER,
        );
      } catch (error: unknown) {
        return toToolError("suggest_resolution", error);
      }
    },
  );
}
