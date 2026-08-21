# T-006: embedder 추상화 + provider 구현
refs: specs/03-rag-pipeline.md, NFR-06
M: M1 | deps: T-002

## Scope
- `core/src/embedder/index.ts`: `interface Embedder { embed(texts: string[]): Promise<number[][]>; dim: number; version: number }`
- provider 1종 구현 + env 기반 팩토리 (`EMBEDDING_PROVIDER`)
- 배치 최대 32, 429/5xx 지수백오프 재시도 3회
- 테스트용 `FakeEmbedder` (해시 기반 결정론적 벡터) export

## Out of scope
- 워커 통합 (T-008)

## Acceptance
- [ ] 배치 분할 테스트: 100개 입력 → 4회 호출
- [ ] 재시도 테스트: 429 두 번 후 성공
- [ ] 모델명이 코드에 하드코딩되지 않았음(grep 기반 테스트)
- [ ] `pnpm verify` 그린

## Context budget
- 읽기: specs/03, .env.example, packages/core/src/embedder/**
