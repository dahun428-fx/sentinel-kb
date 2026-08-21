# T-028: 포트폴리오 패키징
refs: 전체
M: M6 | deps: 전체

## Scope
- README 서사는 docs/portfolio/PORTFOLIO-WEAVE.md의 6단 구조(문제→결정→전환→사고→지표→재귀)를 따른다
- PR 본문의 결정 ID 참조(refs: ADR-x, 감사 x) 관례를 CONTRIBUTING에 명문화
- README: 문제 → 설계 결정 → 트레이드오프 → 지표 서사, 아키텍처·RAG 파이프라인 다이어그램
- eval 리포트 전/후 비교 그래프 (retrieval, tool-selection, generation)
- 루프 계측 회고: 자동 완결률, BLOCKED 사유 분포, "어떤 스펙 서술이 성공률을 올렸나"
- divergence 데이터 패턴 분석 글 초안
- 3분 데모 영상 스크립트: 서로 다른 프로젝트 2곳의 에이전트가 같은 지식으로 문제 해결

## Acceptance
- [ ] README에 설계 결정 5개 이상이 트레이드오프와 함께 기술됨
- [ ] eval 리포트 그래프 3종 생성 스크립트가 재실행 가능
- [ ] 루프 계측 JSONL에서 지표가 산출되고 README에 인용됨
- [ ] 데모 시나리오가 실제로 재현됨(녹화)

## Context budget
- 읽기: eval/reports/**, specs/**, README.md
