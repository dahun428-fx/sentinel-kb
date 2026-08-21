# 02 — 데이터 모델

## records
```ts
{
  _id: ObjectId,
  type: "incident" | "divergence",
  project: string,              // 인증 키의 project 클레임에서 자동 주입
  title: string,
  severity: "SEV1"|"SEV2"|"SEV3"|"NOTE",
  tags: string[],
  // incident
  symptom?: string,
  rootCause?: string,
  resolution?: string,
  prevention?: string,
  // divergence (AI 개발 이격)
  expected?: string,            // 의도한 것 / 스펙
  actual?: string,              // 에이전트가 만든 것
  context?: { model?: string, tool?: string, framework?: string },
  correction?: string,          // 교정 방법 (프롬프트·스펙·스킬 수정)
  sanitizeFlags: string[],      // "secret-masked" | "injection-suspect"
  relations: [{                 // ADR-07 단계 0: 명시적 관계 (기록자가 연결, LLM 자동 추출 금지)
    type: "recurrence_of" | "same_root_cause" | "related" | "corrects",
    targetRecordId: ObjectId, note?: string }],
  status: "draft" | "published",
  embeddingVersion: number,
  createdAt: Date, updatedAt: Date
}
```
`correction`이 시스템 고유 가치다. 다음 프로젝트의 CLAUDE.md·스킬로 환류되는 지식.

## chunks
```ts
{
  _id, recordId: ObjectId,
  section: "symptom"|"rootCause"|"resolution"|"prevention"|"expected"|"actual"|"correction",
  text: string,
  embedding: number[],          // EMBEDDING_DIM
  meta: { type, project, severity, tags, sanitizeFlags },
  embeddingVersion: number
}
```

## 인덱스
- chunks: Atlas Vector Search `vec_idx` — path embedding, cosine, dim=EMBEDDING_DIM,
  filter 필드: meta.type, meta.project, embeddingVersion
- chunks: Atlas Search `text_idx` — path text (lucene.standard)
- records: {project:1, type:1, createdAt:-1}, {tags:1}
- jobs: {status:1, createdAt:1}

## 마이그레이션 규칙
임베딩 모델 교체 = EMBEDDING_VERSION 증가 → 전체 재임베딩(신규 버전 삽입) →
검색 필터를 신버전으로 스왑 → 구버전 청크 삭제. **인플레이스 갱신 금지**(무중단 보장).

## feedbacks / eval_cases
```ts
feedbacks: { _id, recordId, query, helped: boolean, note?, project, createdAt }
eval_cases: { _id, query, expectedRecordIds: ObjectId[], type?, note?, approvedBy: "human" }
```
eval_cases는 **사람 승인 없이 자동 추가 금지** (eval 오염 시 루프 전체가 무의미해짐).
