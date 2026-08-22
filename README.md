# sentinel-kb

여러 프로젝트의 AI 에이전트와 개발자가 공유하는 트러블슈팅 지식 보관소.
같은 장애와 **같은 AI 개발 이격(divergence)** 을 반복하지 않는 것이 목표.

- 1차 인터페이스: **MCP 서버** (Streamable HTTP)
- 2차: Web UI (읽기 중심), HTTP API
- 스택: Node/Fastify · MongoDB Atlas Vector Search · Claude API · Next.js · AWS EC2

## 연결하기

다른 프로젝트에서 이 지식보관소에 붙이려면 `docs/connect.md`를 따른다.
`.mcp.json`(HTTP + stdio 두 전송)과 프로젝트 `CLAUDE.md`에 넣을 프로토콜 문구가 거기 있다.
이 레포 루트의 `.mcp.json`이 자기 자신을 연결한 정본 예시다.

자세한 계획은 `specs/` 참조. 개발 규칙은 `CLAUDE.md`.
