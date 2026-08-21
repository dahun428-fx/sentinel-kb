# T-023: Web 읽기 UI (검색·열람)
refs: FR-08, specs/01
M: M5 | deps: T-012

## Scope
- Next.js App Router: 검색 콘솔(쿼리+필터), 결과 목록, 레코드 상세, 인용 클릭 시 해당 레코드로 이동
- core-api 소비(직접 DB 접근 금지)
- 서버 컴포넌트 우선, 키는 서버에서만 사용(NFR-03/04)

## Out of scope
- 위저드·대시보드(FR-09, P2)

## Acceptance
- [ ] Playwright E2E 3개: 검색→상세 이동 / 필터 적용 / 인용 점프
- [ ] 클라이언트 번들에 API 키 문자열이 없음을 검증하는 테스트
- [ ] Lighthouse 접근성 90+ (검색·상세 페이지)
- [ ] `pnpm verify` 그린

## Context budget
- 읽기: specs/01, specs/04, packages/web/**
