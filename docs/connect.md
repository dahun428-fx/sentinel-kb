# 다른 프로젝트에 sentinel-kb 연결하기

## 1. 키 발급
프로젝트별 키를 발급한다(키에 project 클레임이 들어있어 기록이 자동 스코핑된다).

## 2. .mcp.json
```json
{
  "mcpServers": {
    "sentinel-kb": {
      "type": "http",
      "url": "https://<domain>/mcp",
      "headers": { "Authorization": "Bearer ${SENTINEL_KB_KEY}" }
    }
  }
}
```

## 3. 해당 프로젝트 CLAUDE.md에 한 줄
> 디버깅을 시작하기 전에 `sentinel-kb.search_knowledge`로 과거 사례를 확인하고,
> 해결한 뒤에는 `record_knowledge`로 기록한다.
> 에이전트 산출물이 의도와 벌어졌다면 `type: "divergence"`로 기록한다(모델·도구·재현 조건 포함).

이 세 줄이 연결의 전부다. **이 계약의 단순함이 범용성의 실체**다.

## 3.5 지원 클라이언트
1차 타깃은 **Claude Code**(.mcp.json의 커스텀 헤더 지원). 웹 클라이언트의 원격 커넥터는
OAuth를 요구할 수 있어 현 버전 범위 밖이다 — 필요 시 OAuth 지원을 백로그로 다룬다. (감사 B-3)

## 4. 확인
`pnpm mcp:ping` → 도구 5개가 나오면 연결 완료.
