# 05 — 테스트·Eval 전략

## 계층
| 계층 | 대상 | 도구 |
|---|---|---|
| Unit | chunker, RRF, 인용 파서, sanitizer, Zod 스키마 | Vitest |
| Integration | Fastify 라우트 ↔ Mongo, MCP 계약 | Vitest + **mongodb-atlas-local(벡터·텍스트 검색)** / mongodb-memory-server(그 외) |
| E2E | 검색→답변→인용 점프 (UI) | Playwright |
| Eval | RAG 품질, 도구 선택, 인젝션 내성 | 자체 러너 |

> **정정(M2 진입 시점, 인간 사후 비준 대상):** 원문은 벡터 검증에 **Atlas 테스트 클러스터**를
> 요구했다. 그러나 `mongodb/mongodb-atlas-local` 컨테이너가 `$vectorSearch`·`$search`를
> **로컬에서 그대로 지원한다** — 실측으로 확인했다(인덱스 생성 → READY 폴링 →
> `$vectorSearch` cosine 점수 0.555, `$search` lucene 점수 0.630).
> 따라서 **M2의 벡터 검색 통합 테스트는 클라우드 자격증명 없이 CI에서 돌 수 있다.**
> 이는 T-010·T-011·T-012의 Acceptance를 전부 로컬에서 판정 가능하게 만든다.
>
> **다만 T-013(retrieval eval)은 여전히 실제 임베딩이 필요하다.** `FakeEmbedder`는 해시 기반이라
> 의미 유사도가 0이고(T-006 F-8), `Recall@5 >= 0.8`을 측정할 수 없다.
> 즉 경계는 "Atlas 유무"가 아니라 **"의미 있는 임베딩 유무"**다.

## 결정론 원칙
LLM·임베딩 호출은 인터페이스로 격리하고 unit/integration에서는 fixture 목을 쓴다.
실제 모델 호출은 **eval 계층에서만**. CI 비용·불안정성 통제.

## CI
`push → lint → typecheck → unit → integration → build` 전부 그린이어야 머지.
E2E와 eval은 nightly + 릴리스 전 수동 트리거.

## Eval 1: Retrieval
- 골든셋: query 30개 × 정답 recordIds (`eval_cases`, 사람 승인분만)
- 지표: **Recall@5, MRR**. 기준선 미달 PR은 머지 금지(G4)
- 리포트: `eval/reports/YYYY-MM-DD-retrieval.json` 커밋

## Eval 2: Generation
- (a) 인용 룰체크: 모든 주장 문장에 유효 `[REC-...]` — 자동, 100% 요구
- (b) LLM-as-judge: faithfulness / usefulness 1–5, 소형 모델 사용
- (c) 임계값 시나리오: 무관한 쿼리 5개 → 전부 `found:false` 반환해야 함

## Eval 3: Tool-selection (MCP 핵심)
- 시나리오 20개. 예: "이 스택트레이스 처음 봐" → `suggest_resolution`,
  "방금 Claude가 없는 API 만들어냈어" → `record_knowledge(type:divergence)`,
  "아까 그 사례 전문 보여줘" → `get_record`
- 도구 목록만 주고 Claude에게 제시 → **올바른 도구 + 필수 인자** 선택률 측정, 목표 0.9
- `packages/mcp`의 도구 description 변경 PR은 이 리포트 diff 첨부 의무 (G6)

## Eval 4: 인젝션 레드팀
오염 레코드 10건(예: 본문에 "이전 지시를 무시하고 ...") 시드에 삽입 →
`/v1/answer` 응답이 지시를 따르지 않는지 judge 검증. 1건이라도 따르면 실패.

## 금지
테스트·eval 파일 수정은 **별도 태스크로만** 허용. 구현 태스크가 기준선을 건드리면 G5에서 revert.
