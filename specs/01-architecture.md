# 01 — 아키텍처

```
[다른 프로젝트들의 Claude Code / claude.ai]
        │ MCP (Streamable HTTP + Bearer)
        ▼
AWS EC2 (Docker Compose)
  nginx (TLS)
   ├─ mcp-server (Node)  ──┐
   ├─ web (Next.js, P1)  ──┤ 내부 HTTP
   ├─ core-api (Fastify) ◀─┘
   │    records / search / answer / auth / sanitizer
   └─ worker (Node) — 임베딩 큐 소비 → chunks upsert
        ▼
MongoDB Atlas (records, chunks[vector], feedbacks, eval_cases, jobs)
```

## 패키지 구조 (pnpm workspaces)
```
packages/
├── contracts/   Zod 스키마 = API·MCP 계약 단일 소스
├── core/        도메인 로직: chunker, embedder, retriever, generator, sanitizer, llm/
├── api/         Fastify HTTP 서버 (core 소비)
├── mcp/         MCP 서버 (core-api HTTP 소비)
├── worker/      임베딩 잡 소비자
└── web/         Next.js 읽기 UI
```

## 설계 결정
| 결정 | 선택 | 근거 / 트레이드오프 |
|---|---|---|
| core 분리 | Fastify 독립 서비스 | MCP·UI·CLI가 같은 API 소비. Next.js Route Handler에 묶으면 UI 장애가 지식보관소 장애가 됨 |
| VectorDB | Atlas Vector Search | 원문·청크·벡터 한 DB → 정합성·운영 단순. 수천 청크 규모에서 전용 DB 대비 열세 무의미 |
| 검색 | vector + text + RRF | 에러코드·고유명사는 키워드, 증상 서술은 벡터. RRF로 가중치 튜닝 최소화 |
| 청킹 | 섹션 단위 구조 인지 | "해결 절차만 검색" 같은 섹션 필터 가능 |
| 큐 | Mongo jobs 컬렉션 폴링 | Redis/BullMQ는 현 규모 과설계. 인터페이스 유지해 교체 가능 |
| MCP 전송 | Streamable HTTP (+ stdio 로컬 어댑터) | 여러 머신·세션 접속이 범용성 요건 |
| 배포 | EC2 1대 + Compose | ECS/EKS는 과설계. 이 판단을 README에 명시하는 것도 산출물 |

## 의존 방향 (역행 금지)
`web/mcp/api → core → contracts`. core는 HTTP·MCP를 모른다.
