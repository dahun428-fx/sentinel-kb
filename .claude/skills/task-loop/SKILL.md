---
name: task-loop
description: sentinel-kb의 태스크 스펙(specs/tasks/T-xxx.md)을 수행할 때 반드시 사용한다. 구현 루프의 게이트 순서, 재시도 한도, BLOCKED 판정 기준, PR 규약을 정의한다. "T-005 구현해줘", "다음 태스크 진행", "/task" 같은 요청이면 무조건 이 스킬을 먼저 읽는다.
---

# Task Loop

한 태스크 = 한 세션 = 한 PR. 컨텍스트를 태스크마다 리셋하는 것이 드리프트 방지의 핵심이다.

## 루프

```
PLAN → IMPLEMENT → VERIFY → (실패 시 최대 3회 IMPLEMENT 복귀) → REVIEW → PR
```

### 1. PLAN
태스크 스펙 + refs + Context budget 파일만 읽는다. 계획 3–7줄 선언:
건드릴 파일, 접근 방식, Acceptance를 어떻게 충족할지.

**Context budget은 아래 셋을 항상 포함한다 — 태스크 파일에 안 적혀 있어도 그렇다.**
1. 그 태스크의 `## Findings`가 **읽거나 고치라고 지시한 파일**
2. CLAUDE.md가 요구하는 계약 파일 — 타입을 다루면 `packages/contracts/**`
3. 태스크가 수정하는 코드의 **기존 테스트 파일**

> 근거(T-010 R-1, T-011 R-5 — **같은 문제가 두 번 났다**): 태스크 파일이 스스로 모순되는 일이
> 반복됐다. T-010은 Findings가 `embedder/config.ts` 분할을 지시하는데 budget이 `db/**`만 허용했고,
> T-011은 Findings가 `db/search-indexes.int.spec.ts` 수정을 지시하는데 budget이 `retriever/**`만
> 허용했다. 둘 다 구현자가 "중단 사유(budget 밖 파일이 반드시 필요)"에 해당했지만 밀어붙였고,
> G5가 매번 "변경은 정당, 절차는 위반"으로 판정했다. **구현자 귀책이 아니라 스펙 생성 규약의 결함이다.**
> 위 3항은 그 결함을 닫는다. 그래도 부족하면 그때는 **진짜 스펙 결함이니 멈춰라.**

### 2. IMPLEMENT
implementer 에이전트. 최소 diff. 스코프 밖은 `## Findings`로 기록만.

### 3. VERIFY
verifier 에이전트. Acceptance 항목별 판정. **구현자가 자기 결과를 판정하지 않는다.**

### 4. 게이트
| 게이트 | 판정 | 실패 시 |
|---|---|---|
| G1 정적 | lint + typecheck | 자동 재시도 |
| G2 테스트 | unit + integration | 자동 재시도 |
| G3 계약 | contracts breaking change | **BLOCKED** (인간 승인) |
| G4 Eval | 기준선 이상 | eval-analyst 분석 후 1회 재시도, 이후 BLOCKED |
| G5 스펙정합 | spec-reviewer diff 대조 | 스코프 초과분 revert |
| G6 MCP계약 | 도구 스키마·description 변경 | **BLOCKED** (인간 승인) |

### 5. BLOCKED 처리
태스크 파일 상단에 추가하고 종료:
```
STATUS: BLOCKED
사유: <한 줄>
실패 로그: <핵심 3줄>
필요한 결정: <사람이 답해야 할 질문>
```
추측으로 밀어붙이지 않는다. 막힌 채로 도는 것보다 멈추는 게 싸다.

### 6. PR
- 제목: `T-xxx: 태스크 제목`
- 본문: Acceptance 항목별 근거 / 변경 파일 / Findings / eval diff(해당 시)

### 7. 계측
`eval/loop-log.jsonl`에 1줄 append:
`{"taskId","attempts","failedGate","turns","status","ts","planLines","filesRead"}`
이 로그가 자동 완결률 지표의 원천이다. 빠뜨리지 않는다.

`planLines`(PLAN 줄 수)와 `filesRead`(실제로 읽은 파일 경로 배열)는 **verifier가
"PLAN 3–7줄 선언 + Context budget 준수"를 기계 판정할 수 있게 하는 유일한 근거원**이다.
이 두 필드가 없으면 해당 Acceptance는 판정 불가가 된다 (T-000 F-2).
`filesRead`는 태스크 스펙의 Context budget과 대조되므로 축소 신고하지 않는다.

## 중단 사유 (즉시)
- 테스트·eval·baselines를 고쳐서 통과시키려는 유혹이 생겼을 때
- Context budget 밖 파일이 반드시 필요할 때 (스펙 결함)
- Acceptance가 판정 불가능할 때 (스펙 결함)
