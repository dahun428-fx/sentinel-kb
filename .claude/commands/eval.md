---
description: eval 실행 및 리포트 요약. 사용법 /eval [retrieval|generation|tools|injection|all]
---

1. 해당 eval 스크립트 실행 (`pnpm eval:*`)
2. `eval/reports/`의 신규 리포트와 `eval/baselines.json` 비교
3. 하락이 있으면 eval-analyst 에이전트를 호출해 원인 가설을 받는다
4. 표로 요약 출력: 지표 / 이전 / 현재 / 델타 / 판정
5. **기준선 파일은 수정하지 않는다.** 상향은 사람이 승인한다
