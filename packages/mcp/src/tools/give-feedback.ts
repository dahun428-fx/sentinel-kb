/**
 * `give_feedback` — specs/07 §5. 골든셋 **후보**로만 적재된다(자동 승격 금지, specs/02).
 *
 * ---
 * ## ⚠ `query` 인자에 대하여 (T-015 결정 — 인계 필요)
 *
 * `specs/07:35`의 인자 목록은 `recordId`, `helped`, `note?` 셋뿐인데,
 * HTTP 계약은 `query`를 **필수**로 요구한다 (`specs/04:14`의 `{recordId, query, helped, note?}`,
 * `contracts/feedback.ts`의 `FeedbackRequest.query = z.string().min(1)`).
 * 셋만 보내면 `POST /v1/feedback`이 400으로 거부하므로 specs/07의 목록만으로는
 * **이 도구를 구현할 수 없다.**
 *
 * `query`를 채우는 쪽을 택한 근거:
 * 1. CLAUDE.md가 "API 계약은 `packages/contracts`의 Zod 스키마가 단일 소스"라고 정한다.
 * 2. specs/07 §5가 말하는 목적 자체가 "골든셋 후보로 적재"이고, 골든셋 케이스는
 *    **(질의, 기대 레코드) 쌍**이다. query가 없으면 적재된 후보가 eval 케이스가 될 수 없다.
 * 3. T-022 Acceptance("같은 `(recordId, query)` 중복 피드백은 upsert")가 query를
 *    **식별자의 일부**로 쓴다 — 없으면 그 Acceptance가 성립하지 않는다.
 * 즉 specs/07 §5의 목록은 모순이 아니라 **누락**으로 읽는 것이 정합적이다.
 * 스펙 문면 정정 대상으로 인계한다(Findings F-2).
 *
 * ## 엔드포인트는 아직 없다
 * `POST /v1/feedback`은 T-022의 몫이고 지금은 404다(T-007 F-8). 이 도구는 계약대로 호출하고
 * 실패를 그대로 보고한다 — 호출하지 않는 스텁으로 두면 T-022가 붙이는 순간
 * "도구는 있는데 아무 데도 안 보내는" 상태를 아무도 알아채지 못한다.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { FeedbackRequest } from "@sentinel/contracts";

import type { McpContext } from "../server.js";
import { textResult, toToolError } from "./result.js";

const inputSchema = {
  recordId: FeedbackRequest.shape.recordId.describe(
    "평가할 기록의 24자 recordId. search_knowledge나 suggest_resolution이 돌려준 값을 그대로 쓴다.",
  ),
  query: FeedbackRequest.shape.query.describe(
    "그 기록을 찾을 때 썼던 검색 질의를 그대로 넣는다. (질의, 기록) 쌍이 검색 품질 골든셋 후보의 단위라 비워둘 수 없다.",
  ),
  helped: FeedbackRequest.shape.helped.describe(
    "그 기록이 실제 해결에 쓰였으면 true. 검색에는 걸렸지만 관련 없었으면 false — false도 검색 품질에 똑같이 필요하다.",
  ),
  note: FeedbackRequest.shape.note.describe(
    "선택. 어느 부분이 맞았는지/왜 빗나갔는지 한두 줄. 검색 품질을 고칠 사람이 읽는다.",
  ),
};

export const GIVE_FEEDBACK_DESCRIPTION =
  "검색으로 받은 기록이 실제 해결에 도움이 됐는지 표시한다. " +
  "**문제를 다 해결한 뒤**, 실제로 근거로 쓴 기록(또는 헛다리를 짚게 만든 기록)에 대해 한 번 부른다. " +
  "기록을 고치거나 지우지 않는다 — 새 기록을 남기려면 record_knowledge를, 다시 찾으려면 search_knowledge를 부른다. " +
  "이 신호는 검색 품질 골든셋 **후보**로만 쌓이고 승격은 사람이 검토해서 한다.";

export function registerGiveFeedback(server: McpServer, context: McpContext): void {
  server.registerTool(
    "give_feedback",
    { title: "검색 결과 유용성 피드백", description: GIVE_FEEDBACK_DESCRIPTION, inputSchema },
    async (args) => {
      try {
        // 상태를 만드는 POST라 `write()`다. `read()`의 재시도는 이 경로에 어울리지 않는다.
        await context.coreApi.write({
          method: "POST",
          path: "/v1/feedback",
          body: FeedbackRequest.parse({
            recordId: args.recordId,
            query: args.query,
            helped: args.helped,
            ...(args.note === undefined ? {} : { note: args.note }),
          }),
        });
        return textResult(
          `피드백을 기록했다: ${args.recordId} helped=${String(args.helped)}`,
          "검색 품질 골든셋 후보로 쌓였다. 승격은 사람이 검토한 뒤에 이뤄진다.",
        );
      } catch (error: unknown) {
        return toToolError("give_feedback", error);
      }
    },
  );
}
