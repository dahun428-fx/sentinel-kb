# T-057: suggest_resolution 답변이 잘리고 지연·재시도가 겹친다
refs: docs/plan/UPLIFT-PLAN.md §4-2 (A1 (Major), A4 (Major))
M: M4 | deps: T-019,T-015

## 배경

2026-10-22 P1 AI 리뷰(UPLIFT §4-2) 지적. 근거 위치는 리뷰가 코드에서 확인했고, 주요 건은 재확인했다.

- A1: `renderAnswer`(`packages/mcp/src/tools/format.ts:393-431`)의 water-fill이 작은 요구부터 채워 인용 제목이 답변보다 먼저 자리를
  가져간다. 인용 5개면 1,410자 답변 중 31자만 남는다(리뷰 실측). 머리·꼬리 문구 추정치가 388토큰(실제 111)이고, `oneLine()`이
  번호 절차와 여러 줄 명령을 한 줄로 접는다. 결과는 `found: true`에 "…"로 끝나는 한 구절이다.
- A4: MCP는 `/v1/answer`를 읽기 경로로 보고 10초 × 3회 재시도한다(`core-api-client.ts:116-118,212-227`, `config.ts:41-42`).
  서버 쪽은 Anthropic 8초 × 2회(`llm/config.ts:28-33`)라 한 번의 MCP 시도 안에 끝나지 않을 수 있고, 재시도마다 전체 파이프라인을
  다시 돈다. 최악은 약 30초 대기와 LLM 호출 6회다(지연은 미실측).

## Scope
- 답변 몫을 먼저 확보하고 인용 제목에 상한을 둔다. 머리·꼬리 추정 분리. 답변의 개행 유지(빈 줄 연속만 접기).
- `/v1/answer`는 재시도하지 않는 단일 호출 + 더 긴 타임아웃. `ANSWER_MAX_TOKENS`를 MCP 표시 예산에 맞춘다.
- LLM 총 시간(timeout × (retries+1))이 클라이언트 1회 타임아웃 안에 들어가게 맞춘다.

## Acceptance
1. 인용 5개에서도 답변 본문 N자 이상이 남는다(N은 태스크에서 정한다).
2. 여러 줄 절차가 줄 단위로 남는다.
3. `/v1/answer`가 5xx를 내도 MCP가 재시도하지 않는다.
4. `pnpm verify` 그린.

## Context budget
- 읽기: `packages/mcp/src/tools/{format.ts,suggest-resolution.ts}`, `packages/mcp/src/{core-api-client.ts,config.ts}`, `packages/core/src/llm/config.ts`, `packages/core/src/generator/config.ts`, `specs/07-mcp.md`, `specs/00-product.md` NFR-03

## 처리 메모
- P7 전에 처리한다. 그 전에는 `suggest_resolution` 대신 `search_knowledge` + `get_record`를 쓴다.

## 결과 (2026-10-22)

- **A1 배분**: 인용 제목에 개당 16토큰(추정) 상한만 떼어 두고 나머지를 답변에 준다. 리뷰 재현과 같은 1,410자 답변 기준
  인용 1/3/5/8개에서 남는 답변 525/426/347/198자(이전 312/157/31/한 구절). 전체는 NFR-03 800토큰 안.
- **A1 문구**: 머리·꼬리 추정 388 → 197토큰. 머리말은 "모든 내용이 인용에 근거한다"를 빼고 명령·코드는 get_record로 확인하라고 쓴다(S7 일부).
- **A1 줄 구조**: `tidyLines`로 줄을 살리고 빈 줄 연속만 접는다. 인용 머리줄처럼 생긴 답변 줄은 `> `로 무력화(기존 "목록 구조 위조 차단" 유지).
- **A4**: `/v1/answer`는 재시도 없는 경로 + 요청별 상한 30초. 서버 LLM 최대 16초를 덮는다.
- `ANSWER_MAX_TOKENS`(2048)는 웹 UI 스트리밍도 쓰므로 낮추지 않았다 (Findings F-1).
- `tools.int.spec.ts`의 고정 안내 리터럴은 문구 변경에 맞춰 고쳤다 — 검사 대상("그 밖의 문장이 없다")은 그대로다.
- 테스트: 단위 4건, 통합 1건. 배분·재시도를 되돌리면 단위 3·통합 1 실패.

## Findings
- **F-1** 실 LLM 지연은 미측정이다. P6에서 `/v1/answer` p95를 재고, 30초가 부족하면 이 상한을 조정한다.

STATUS: GREEN
