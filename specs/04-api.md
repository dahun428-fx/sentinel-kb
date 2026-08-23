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
| GET | `/v1/articles` | 아티클 목록. **기본은 `published`만.** `status=candidate\|draft`를 **명시해야** 후보 큐가 보인다. **본문 없는 요약** |
| GET | `/v1/articles/:id` | 단건 조회 (본문 포함) |
| PATCH | `/v1/articles/:id` | 편집. `candidate`·`draft`에서만 허용 |
| POST | `/v1/articles/:id/publish` | 발행. `publishedAt`은 **서버가 찍는다** — 클라이언트가 보내면 400 |
| GET | `/health` | `{status, mongo, embeddingVersion, version}` (인증 불요) |

> **아티클 오퍼레이션 4건 정정 (인간 비준 대상, T-029·T-031·T-032·T-033 인계).**
> M7 태스크 넷이 **이 표에 아티클 표면이 없다는 같은 벽**에서 멈춰 있었다.
> T-036의 양방향 드리프트 가드가 `pnpm verify` 안에서 돌아 라우트만 추가하는 우회가 막혀 있었고,
> CLAUDE.md가 "스펙 없는 신규 API 추가"를 금지하므로 **스펙을 먼저 고치는 것이 규약상 유일한 경로**다.
>
> 세 결정의 근거:
> 1. **목록은 본문 없는 요약이다.** `GET /v1/records`가 같은 이유로 그렇다 —
>    본문을 목록에 실으면 NFR-03이 재발하고, `RecordSummary`를 따로 둔 이유가 무의미해진다.
> 2. **기본이 `published`이고 후보 큐는 명시해야 보인다.** T-033 Acceptance 3이
>    "candidate는 공개 목록에 노출되지 않는다"이므로 **필터를 빠뜨렸을 때의 결과가 안전한 쪽**이어야 한다.
>    반대로 두면 파라미터 하나를 잊는 순간 미발행 초안이 공개된다.
> 3. **인증된 `/v1` 표면이다.** 이 표에서 비인증은 `/health` 하나뿐이고 그것은 **의도적으로 `/v1` 밖**에 있다 —
>    위치가 곧 규약이다(T-036). 별도 내부 도구로 빼면 인증 체계를 하나 더 만들어야 하고,
>    후보 큐도 다른 표면과 같이 project로 스코프되는 편이 일관된다.
>
> **`publishedAt`을 서버가 찍는 이유**: `ArticleSchema.refine`이 `body`·`publishedAt` 없는 `published`를
> 거부하는데, 클라이언트가 그 값을 보내면 **배치가 세 겹으로 막은 자동 발행 금지가 HTTP 표면에서 뚫린다.**

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
