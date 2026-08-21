# T-018: generator — 인용 강제 + 임계값 게이트
refs: specs/03-rag-pipeline.md §4
M: M4 | deps: T-011

## Scope
- `core/src/generator/`: 컨텍스트 조립 + 시스템 프롬프트(4개 필수 조항) + 호출
- 임계값 게이트: retriever가 반환한 **융합 전 cosine 최고점** < SIMILARITY_THRESHOLD → 생성 스킵, `{found:false, suggestRecord:true}` (RRF 점수와 비교 금지, 감사 B-1)
- injection-suspect 청크는 생성 컨텍스트에서 제외
- 프롬프트는 파일로 분리(`prompts/answer.md`)해 버전 관리

## Out of scope
- HTTP/SSE, 후처리 검증(T-020)

## Acceptance
- [ ] 임계값 미달 입력 → 생성 호출이 아예 발생하지 않음(스파이 검증)
- [ ] 플래그된 청크가 컨텍스트에서 제외됨을 검증
- [ ] 프롬프트 4개 필수 조항이 모두 포함되는 스냅샷 테스트
- [ ] `pnpm verify` 그린

## Context budget
- 읽기: specs/03 §4, packages/core/src/generator/**
