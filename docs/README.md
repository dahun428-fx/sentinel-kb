# 산출물 색인

## 분석 단계
| 문서 | 내용 |
|---|---|
| analysis/SRS.md | 소프트웨어 요구사항 명세서 — 범위·용어·기능(FR)·비기능(NFR)·인수기준 |
| analysis/USE-CASES.md | 유스케이스 명세서 — 액터, UC-01~08의 기본·대안·예외 흐름 |
| analysis/RTM.md | 요구사항 추적성 매트릭스 — 요구사항→설계→태스크→검증 |

## 설계 단계
| 문서 | 내용 |
|---|---|
| design/SAD.md | 시스템 아키텍처 설계서 — 4+1 뷰, 보안·성능 설계, ADR 6건 |
| design/DB-DESIGN.md | 데이터베이스 설계서 — ERD, 데이터 사전, 인덱스, 마이그레이션 |
| design/INTERFACE-SPEC.md | 인터페이스 설계서 — HTTP API, MCP 도구, 주요 시퀀스 |

## 테스트·계획
| 문서 | 내용 |
|---|---|
| test/TEST-PLAN.md | 테스트 계획서 — 레벨별 전략, 테스트 케이스, 품질평가 기준, 종료 기준 |
| plan/WBS.md | WBS·일정·마일스톤 게이트·리스크 등록부 |

## 시각 자료
| 문서 | 내용 |
|---|---|
| diagrams.html | 도면집 15판 (브라우저에서 열면 렌더링) |
| EXECUTION-PLAN.md | 실행 계획 — 첫 주 순서, 루프 진단표 |
| connect.md | 다른 프로젝트에 MCP 연결하는 방법 |

> 루트 `README.md`의 아키텍처·의존 방향·RAG 다이어그램은 mermaid로 인라인돼 있고
> `tools/portfolio-docs.spec.ts`가 `packages/`·`docker-compose.yml`·`eslint.config.js` zone·
> `.env.example`에 대조한다. **도면집과 달리 그쪽은 깨지면 `pnpm verify`가 빨개진다.**

## 포트폴리오 (T-028)
| 문서 | 내용 |
|---|---|
| portfolio/PORTFOLIO-WEAVE.md | 설계 고민을 제품에 편입하는 다섯 채널 + README 6단 구조 |
| portfolio/METRICS.md | 루프 계측 회고 — 완결률 정의 문제, 게이트 분포, 계측 자체의 결함 |
| portfolio/DIVERGENCE-PATTERNS.md | divergence 10건의 패턴 분석 (아티클 초안) |
| portfolio/DEMO-SCRIPT.md | 3분 데모 스크립트 + **지금 재현되는 단계와 아닌 단계** |
| CONTRIBUTING.md | PR 본문의 결정 ID 참조 관례, 게이트, 하지 않는 것 |
| DECISIONS-PENDING.md | 인간 결정 대기 목록 (막고 있는 순서로) |

## 구현 스펙 (에이전트 소비용)
`specs/00~07` + `specs/tasks/T-000~028`. 분석·설계 문서가 "무엇을 왜"라면, specs는 "어떻게"이고 tasks는 "지금 무엇을"이다.
