# 00 — 제품 정의

## 문제
1. 트러블슈팅 지식이 프로젝트별로 파편화되어 재발 시 처음부터 다시 판다.
2. AI 에이전트가 프로젝트마다 같은 이격(환각 API, 잘못된 버전 가정, 스펙 드리프트)을 반복하는데 어디에도 기록되지 않는다.
3. 지식이 사람용 문서로만 있으면 에이전트가 소비하지 못한다. 에이전트가 읽고 쓰는 형태여야 루프가 닫힌다.

## 핵심 루프
```
에러 조우 → search_knowledge → (있음) 해결 절차 적용 / (없음) 직접 해결 → record_knowledge
이격 발견 → record_knowledge(type: divergence) → 다음 프로젝트의 CLAUDE.md·스킬로 환류
```
각 프로젝트 CLAUDE.md에 "디버깅 전 search, 해결 후 record" 한 줄로 연결된다.

## 기능 요구사항
| ID | 요구사항 | P |
|---|---|---|
| FR-01 | 레코드 CRUD: `incident`(symptom/rootCause/resolution/prevention) + `divergence`(expected/actual/context/correction), 공통 `project, tags, severity` | P0 |
| FR-02 | 인제스트: 저장 시 섹션 청킹 → 비동기 워커가 임베딩·인덱싱 | P0 |
| FR-03 | 하이브리드 검색 (vector + text + RRF), `project`·`type` 필터 | P0 |
| FR-04 | RAG 답변: 인용 강제, 임계값 미달 시 "사례 없음 + 기록 제안" | P0 |
| FR-05 | MCP 서버: 도구 5개, Streamable HTTP + Bearer | P0 |
| FR-06 | 새니타이즈 게이트: 시크릿 마스킹, 인젝션 의심 텍스트 플래그 | P0 |
| FR-07 | 피드백: 검색 결과가 실제 해결에 쓰였는지 마킹 | P1 |
| FR-08 | Web UI: 열람·검색 콘솔 (읽기 중심) | P1 |
| FR-09 | 포스트모템 위저드 · 재발 패턴 대시보드 | P2 |
| FR-10 | 시드: 실사례 20 + 공개 포스트모템 20 + 이격 10 | P0 |

## 비기능 요구사항
| ID | 요구사항 |
|---|---|
| NFR-01 | 검색 API p95 < 1.5s / MCP 도구 p95 < 2s |
| NFR-02 | 근거 없는 해결책 생성 금지 |
| NFR-03 | MCP search 응답 <= 약 800 토큰 (요약+ID만) |
| NFR-04 | 모든 외부 표면 Bearer 인증, 프로젝트별 키 |
| NFR-05 | 검색 응답 본문은 data 프레이밍, 지시로 해석 금지 |
| NFR-06 | 임베딩 모델 교체 가능 (embeddingVersion) |
| NFR-07 | EC2 장애 시 데이터 무손실 (stateless 서버) |

## 성공 지표
| 지표 | 목표 |
|---|---|
| Recall@5 | >= 0.85 |
| Tool-selection 정확도 | >= 0.9 |
| Grounding 인용률 | 100% |
| 도그푸딩 실기록 (4주) | >= 30건, 적중 >= 5건 |
| 태스크 자동 완결률 | >= 70% |
