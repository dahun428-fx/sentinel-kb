# prompts/style — 문체 few-shot

specs/08-publishing.md §0-4: "작성자가 쓴 실제 글 2~3편을 few-shot으로 넣어 개인 문체를 이식한다."

## 넣는 방법

이 디렉터리에 `.md` 파일을 떨어뜨리면 된다. `packages/core/src/publisher/style.ts`가
**파일 이름 순서로** 읽어 초안 프롬프트의 `<style-sample>` 블록에 싣는다.
`README.md`는 읽지 않는다.

- **자기가 쓴 글**을 넣는다. 남의 글을 넣으면 남의 문체가 이식된다.
- 2~3편이면 충분하다. 표본이 길수록 팩트 팩이 프롬프트 뒤로 밀린다
  (표본 1편당 `STYLE_SAMPLE_MAX_CHARS`자에서 잘린다).
- 표본은 **문체를 흉내 낼 대상**이지 내용의 출처가 아니다. 초안의 사실은 전부 팩트 팩에서 온다.

## 자동으로 버려지는 표본

로더가 표본마다 스크린을 돌린다. 걸리면 그 파일은 프롬프트에 실리지 않고
`lintReport.style.rejected`에 사유가 남는다.

| 사유 | 무엇에 걸렸나 |
|---|---|
| `secret-shape` | `containsSecretShape` — 자격증명·마스킹 라벨·불투명한 긴 토큰 (T-030 F-4) |
| `injection-detected` | `detectInjection` — 지시문 형상 (T-040) |
| `empty` | 빈 파일 |

블로그 글을 그대로 복사해 넣을 때 API 키나 접속 문자열이 딸려 오는 일이 실제로 있다.
버려졌다고 로더가 실패하지는 않지만, **표본 0편이면 §0-4의 스타일 주입은 이번 초안에
작동하지 않은 것**이고 그 사실이 리포트에 남는다.

## 디렉터리 위치를 바꾸려면

`STYLE_SAMPLES_DIR` 환경변수로 덮어쓴다. 기본값은 이 디렉터리다.
