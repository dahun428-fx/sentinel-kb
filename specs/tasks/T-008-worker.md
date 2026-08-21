# T-008: jobs 큐 + 임베딩 워커
refs: specs/03-rag-pipeline.md §1, specs/01 (큐 결정)
M: M1 | deps: T-005, T-006

## Scope
- `jobs` 컬렉션 폴링 워커: `findOneAndUpdate`로 원자적 클레임(status: pending→running)
- record 로드 → chunker → embedder → chunks upsert(유니크 키로 멱등)
- 실패 시 attempts++ / 3회 초과 시 `dead`, record는 그대로 둔다
- graceful shutdown (SIGTERM 시 진행 중 잡 완료 후 종료)

## Out of scope
- 벡터 인덱스 정의 (T-010)

## Acceptance
- [ ] 통합 테스트: job 처리 후 chunks 개수와 섹션이 chunker 출력과 일치
- [ ] 같은 job 2회 처리해도 chunks 중복 생성 안 됨(멱등)
- [ ] 임베더 실패 주입 → attempts 증가, 3회 후 dead
- [ ] 동시 워커 2개 기동 시 같은 job 중복 처리 없음
- [ ] `pnpm verify` 그린

## Context budget
- 읽기: specs/03 §1, packages/worker/**, packages/core/src/{chunker,embedder}/**
