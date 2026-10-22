/**
 * T-051 (P1 보안 리뷰 S1). 그 전까지 **평문으로 저장되고 Voyage·Anthropic으로 나가던** 시크릿 모양들.
 * 리뷰가 실측한 통과 사례를 그대로 옮겼다. 픽스처는 전부 가짜다(`FAKE`/`0000` 마커).
 *
 * 두 표를 함께 둔다. 잡아야 할 것만 늘리면 규칙이 넓어지는 방향으로만 움직여
 * 트러블슈팅 문장 자체가 지워지기 시작한다 — 그건 검색 품질을 깎는 다른 종류의 실패다.
 */
import { describe, expect, it } from "vitest";

import { applyMasking } from "./masking.js";
import { sanitize } from "./sanitize.js";

const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJGQUtFMDAwMCJ9.FAKESIGNATURE0000abc";

describe("sanitize — 추가 시크릿 종류 (T-051)", () => {
  it.each([
    ["앵커 없는 JWT", `토큰 ${JWT} 가 만료됨`, "토큰 [MASKED:jwt] 가 만료됨"],
    ["쿠키 안의 JWT", `Cookie: session=${JWT}`, "Cookie: session=[MASKED:jwt]"],
    [
      "postgres URI",
      "postgres://admin:S3cr3tP%40ss@db.internal:5432/app",
      "postgres://[MASKED:db-credentials]@db.internal:5432/app",
    ],
    [
      "SQLAlchemy 드라이버 접미사",
      "postgresql+psycopg2://app:FAKE0000pw@db/x",
      "postgresql+psycopg2://[MASKED:db-credentials]@db/x",
    ],
    [
      "mysql URI",
      "mysql://root:hunter2pass@db:3306/x",
      "mysql://[MASKED:db-credentials]@db:3306/x",
    ],
    [
      "redis 비밀번호만",
      "redis://:myRedisPassw0rd@cache:6379",
      "redis://:[MASKED:db-credentials]@cache:6379",
    ],
    [
      "https userinfo",
      "https://user:p4ssword@git.example.com/repo.git",
      "https://[MASKED:url-credentials]@git.example.com/repo.git",
    ],
    ["DB_PASSWORD", "DB_PASSWORD=Sup3rS3cret!", "DB_PASSWORD=[MASKED:credential]"],
    ["JWT_SECRET", "JWT_SECRET=abcdefFAKE0000", "JWT_SECRET=[MASKED:credential]"],
    ["YAML PASSWORD", "PASSWORD: p@ssw0rd123", "PASSWORD: [MASKED:credential]"],
    ["camelCase 키", "dbPassword: hunter2FAKE", "dbPassword: [MASKED:credential]"],
    ["token=", "token=abc123FAKE0000", "token=[MASKED:credential]"],
    [
      "GITHUB_TOKEN",
      "GITHUB_TOKEN=ghp_FAKE0000FAKE0000FAKE0000FAKE0000FAKE",
      "GITHUB_TOKEN=[MASKED:api-key]",
    ],
    [
      "떠 있는 ghp_",
      "clone with ghp_FAKE0000FAKE0000FAKE0000FAKE0000FAKE now",
      "clone with [MASKED:api-key] now",
    ],
    ["GitLab PAT", "glpat-FAKE0000FAKE0000FAKE", "[MASKED:api-key]"],
    ["Slack 토큰", "xoxb-0000FAKE-0000FAKE0000-FAKEFAKEFAKE", "[MASKED:api-key]"],
    ["Google API 키", "AIzaSyFAKE0000FAKE0000FAKE0000FAKE00000", "[MASKED:api-key]"],
    ["Stripe 라이브 키", "sk_live_FAKE0000FAKE0000FAKE", "[MASKED:api-key]"],
    [
      "Basic 인증 헤더",
      "Authorization: Basic YWRtaW46aHVudGVyMg==",
      "Authorization: Basic [MASKED:credential]",
    ],
    ["curl -u", "curl -u admin:hunter2 https://x", "curl -u admin:[MASKED:credential] https://x"],
    [
      "복수형 API_KEYS",
      "SENTINEL_API_KEYS=proj:skb_FAKE0000",
      "SENTINEL_API_KEYS=[MASKED:api-key]",
    ],
    [
      "한국어 문장 속 비밀번호",
      "비밀번호는 hunter2Secret 입니다",
      "비밀번호는 [MASKED:credential] 입니다",
    ],
    ["한국어 비밀번호 뒤 문장부호", "암호: Fake0000! 였다.", "암호: [MASKED:credential] 였다."],
  ])("%s", (_name, input, expected) => {
    const { text, flags } = sanitize(input);
    expect(text).toBe(expected);
    expect(flags).toEqual(["secret-masked"]);
  });

  it.each([
    [
      "PEM, 실제 개행",
      "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAFAKE0000\nABCDEFFAKE0000==\n-----END RSA PRIVATE KEY-----",
    ],
    [
      "PEM, JSON 이스케이프 개행",
      '"key": "-----BEGIN PRIVATE KEY-----\\nMIIEvQIBADANFAKE0000\\n-----END PRIVATE KEY-----\\n"',
    ],
    [
      "OpenSSH 키",
      "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAAFAKE0000\n-----END OPENSSH PRIVATE KEY-----",
    ],
    [
      "끝 줄 없이 잘린 PEM",
      "로그: -----BEGIN PRIVATE KEY-----\nMIIEvQIBADANFAKE0000\nAAAAFAKE0000",
    ],
  ])("개인키 본문이 남지 않는다 — %s", (_name, input) => {
    const { text } = sanitize(input);
    expect(text).toContain("[MASKED:private-key]");
    expect(text).not.toMatch(/FAKE0000|b3BlbnNz/);
  });
});

describe("sanitize — 추가 규칙의 오탐 방지 (T-051)", () => {
  it.each([
    "https://unpkg.com/react@18.3.1/umd/react.js",
    "https://www.npmjs.com/package/@types/node",
    "https://host:8080/pkg/@scope/x",
    "git clone git@github.com:org/repo.git",
    "commit 3f786850e387550fdab836ed7e6dc881de23001b 에서 수정",
    "max_tokens: 2048 으로 낮췄다",
    "token_type: bearer",
    "TOKEN_EXPIRY=3600",
    "비밀번호 변경 후 재시도했다",
    "토큰 만료로 401이 났다",
    "암호화 설정을 확인",
    "cat /etc/passwd: Permission denied",
    "Basic authentication failed for user",
    "postgres://localhost:5432/app",
    "https://example.com/a?x=1:2",
    "the secret ingredient",
    "password: <your-password>",
  ])("%s", (input) => {
    expect(applyMasking(input, false)).toEqual({ text: input, masked: [] });
  });
});
