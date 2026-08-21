# 04 — HTTP API 계약

Base: `/v1`. 인증: `Authorization: Bearer <key>` → `{ project }` 클레임 해석 (NFR-04).
모든 요청/응답은 `packages/contracts`의 Zod 스키마로 검증한다. **스키마가 단일 소스.**

| Method | Path | 요약 |
|---|---|---|
| POST | `/v1/records` | 레코드 생성. project는 키에서 주입하며 **바디에 `project`가 오면 400 거부**. 새니타이즈 통과 후 저장 + embed job |
| GET | `/v1/records/:id` | 단건 조회 (본문 포함) |
| PATCH | `/v1/records/:id` | 수정. 본문 섹션 변경 시 재임베딩 job |
| GET | `/v1/records` | 목록/필터 (project, type, tags, cursor 페이지네이션). **본문 없는 요약**(`summary` 포함) |
| POST | `/v1/search` | 하이브리드 검색. `{query, type?, project?, limit}` → `{results:[{recordId,title,summary,section,score,type,project,flags}]}` |
| POST | `/v1/answer` | RAG 생성 (SSE 스트리밍 옵션, `stream` 플래그). `{query, project?, stream?}` → 인용 포함 답변 or `{found:false, message, suggestRecord:true}` |
| POST | `/v1/feedback` | `{recordId, query, helped, note?}` |
| GET | `/health` | `{status, mongo, embeddingVersion, version}` (인증 불요) |

## 규약
- 에러: `{error:{code, message, details?}}`, code는 SCREAMING_SNAKE.
- `summary`는 서버가 생성(첫 2문장 또는 LLM 요약 캐시) — 클라이언트가 본문을 받지 않고도 판단 가능해야 함(NFR-03의 기반).
- 페이지네이션은 cursor(`createdAt+_id`) 방식. offset 금지.
- 레이트리밋: 키당 60 req/min (nginx).
- `project` 크로스 조회는 허용(지식 공유가 목적), **쓰기는 자기 project로만**.
- 바디의 `project`를 조용히 무시하지 않고 400으로 거부하는 이유: 무시는 confused deputy를 만든다.
  클라이언트가 `project:"B"`로 보내면 201과 함께 A에 저장되고 요청자는 B에 썼다고 믿는다.
  오배치는 `chunks.meta.project`(벡터 인덱스 필터 필드)까지 오염시키며, specs/02 마이그레이션 규칙이
  인플레이스 갱신을 금지하므로 정정 비용이 크다. 스키마의 `.strict()`가 이를 강제한다.

## OpenAPI
`packages/contracts`에서 zod-to-openapi로 생성, `/v1/openapi.json` 서빙. 수기 작성 금지.
