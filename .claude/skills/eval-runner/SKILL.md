---
name: eval-runner
description: RAG eval(retrieval, generation), tool-selection eval, 인젝션 레드팀 eval을 실행하거나 리포트를 해석하거나 골든셋을 추가할 때 반드시 사용한다. 지표 정의, 기준선 관리 규칙, 회귀 판정, 골든셋 오염 방지 원칙을 다룬다. eval·품질 지표·회귀·골든셋 관련 작업이면 이 스킬을 먼저 읽는다.
---

# Eval Runner

이 프로젝트에서 eval은 테스트보다 중요하다. RAG는 "돌아가는데 나쁜" 상태가 기본값이기 때문이다.

## 네 가지 eval

| 명령 | 대상 | 핵심 지표 | 기준선 |
|---|---|---|---|
| `pnpm eval:retrieval` | 검색 | Recall@5, MRR | 0.8 (M2) → 0.85 |
| `pnpm eval:generation` | 답변 | 인용 룰체크, judge faithfulness/usefulness | 인용 100% |
| `pnpm eval:tools` | MCP 도구 선택 | 정확도(도구+필수인자) | 0.85 (M3) → 0.9 |
| `pnpm eval:injection` | 방어 | 방어 성공률 | 10/10 |

## 기준선 규칙
- `eval/baselines.json`이 회귀 판정의 기준이다
- **기준선 하향은 절대 자동으로 하지 않는다.** 사람이 결정한다
- 상향(개선 반영)도 사람 승인. 에이전트는 리포트만 낸다
- 리포트는 `eval/reports/{date}-{kind}.json`으로 커밋한다 — 시계열이 곧 포트폴리오 자산

## 골든셋 관리
- `eval_cases`에 들어가려면 `approvedBy: "human"`이 필요하다
- 피드백에서 온 케이스는 **후보**일 뿐이다. `pnpm eval:approve`로 사람이 승격한다
- 골든셋이 오염되면 루프 전체가 무의미해진다. 여기가 가장 지키기 쉬운 곳이자 가장 치명적인 곳

## 회귀가 났을 때
1. eval-analyst 에이전트 호출
2. **케이스 단위로** 원인을 좁힌다("전반적 하락"은 분석이 아니다)
3. retrieval 하락과 generation 하락을 구분한다 — 원인 계층이 다르다
4. 파라미터 스윕이 필요하면 별도 태스크로 만든다

## 절대 금지
- 통과시키려고 골든셋·시나리오·기준선을 수정하는 것
- 구현 태스크에서 eval 파일을 함께 건드리는 것 (별도 태스크로만)
