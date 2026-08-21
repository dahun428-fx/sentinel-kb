# T-032: 다이어그램 생성 + 컴파일 검증 루프
refs: specs/08-publishing.md §5.2
M: M7 | deps: T-031

## Scope
- LLM이 원인 연쇄·타임라인 mermaid 생성 → mermaid 파서로 컴파일 검증 → 실패 시 에러 포함 재생성(최대 2회) → 재실패 시 해당 다이어그램 생략
- 생성 다이어그램의 노드 라벨이 facts·레코드 원문에서만 오도록 프롬프트 제약

## Acceptance
- [ ] 깨진 mermaid를 반환하는 모의 LLM에 대해 재시도 후 생략 처리됨
- [ ] 유효 다이어그램은 body에 코드 블록으로 삽입됨
- [ ] `pnpm verify` 그린

## Context budget
- 읽기: specs/08 §5.2, packages/core/src/publisher/**
