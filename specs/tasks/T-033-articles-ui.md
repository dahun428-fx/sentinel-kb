# T-033: 아티클 UI (블로그 렌더 + 편집·발행)
refs: specs/08-publishing.md §5.3, §7
M: M7 | deps: T-031, T-023

## Scope
- web /articles: 발행물 목록·상세 (Markdown + mermaid + 차트 렌더)
- draft 편집 화면: 본문 수정, 발행 버튼 (발행은 사람만)
- 편집 diff 요약을 editHistory에 기록
- 단일 HTML 내보내기

## Acceptance
- [ ] E2E: draft 편집 → 발행 → 목록 노출
- [ ] 차트 3종(bar/line/heatmap)과 mermaid가 렌더됨
- [ ] candidate 상태 아티클은 공개 목록에 노출되지 않음
- [ ] `pnpm verify` 그린

## Context budget
- 읽기: specs/08 §5.3, packages/web/**
