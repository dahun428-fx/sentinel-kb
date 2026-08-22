import { describe, expect, it } from "vitest";

import { classifyQueryKind } from "./query-kind.js";

/**
 * 이 분류가 틀리면 T-013이 재려는 것 자체가 재어지지 않는다 —
 * "lucene.standard가 한국어에서 얼마나 손실을 내는가"(T-010 F-6)의 분모가 이 함수다.
 */
describe("classifyQueryKind", () => {
  it("붙잡을 ASCII 토큰이 없는 순수 한국어 질의는 korean-prose다", () => {
    expect(classifyQueryKind("스트리밍이 중간에 끊긴다")).toBe("korean-prose");
    expect(classifyQueryKind("배포 후에 응답이 느려졌어요")).toBe("korean-prose");
  });

  it("영문 식별자·에러코드·설정키는 identifier다", () => {
    expect(classifyQueryKind("nginx proxy_buffering")).toBe("identifier");
    expect(classifyQueryKind("ECONNREFUSED")).toBe("identifier");
    expect(classifyQueryKind("E11000 duplicate key")).toBe("identifier");
  });

  it("혼합 질의는 identifier다 — 텍스트 경로가 붙잡을 토큰이 실제로 있다", () => {
    expect(classifyQueryKind("nginx 502 왜 나?")).toBe("identifier");
    expect(classifyQueryKind("MongoDB 연결이 안 됨")).toBe("identifier");
  });

  it("한국어에 붙은 숫자는 identifier로 치지 않는다 — 토큰이 순수 ASCII가 아니다", () => {
    // "3초"는 lucene.standard가 한국어 토큰으로 뭉개는 쪽이다. 이걸 identifier로 세면
    // korean-prose 그룹이 비어 버려 분해 집계 자체가 무의미해진다.
    expect(classifyQueryKind("응답이 3초 넘게 걸린다")).toBe("korean-prose");
  });

  /**
   * ⚠️ 이 경계가 없으면 `[A-Za-z0-9]{2,}`를 `{1,}`로 바꿔도 아무 테스트도 죽지 않는다
   * (뮤테이션 M11 생존으로 실제로 확인했다). 홀로 선 한 글자 ASCII 토큰은 **어느 문서에나
   * 있는 흔한 토큰**이라 텍스트 경로가 그것으로 정답을 찾아내지 못한다 —
   * 그런 질의를 identifier로 세면 korean-prose 그룹이 비어 분해 집계가 무의미해진다.
   */
  it("홀로 선 한 글자 ASCII 토큰은 식별자가 아니다", () => {
    expect(classifyQueryKind("메모리 사용량이 3 배로 튀었다")).toBe("korean-prose");
    expect(classifyQueryKind("서버 A 가 죽었다")).toBe("korean-prose");
    // 두 글자부터가 식별자다 — 경계를 양쪽에서 건다.
    expect(classifyQueryKind("서버 A1 이 죽었다")).toBe("identifier");
  });

  /**
   * ⚠️ 이것이 T-010 F-6 그 자체다. `lucene.standard`는 "E11000이"를 **한 토큰**으로 만들고,
   * 그 토큰은 본문의 `E11000`과 매칭되지 않는다. 조사가 붙은 순간 식별자는 더 이상
   * 텍스트 경로가 붙잡을 수 있는 것이 아니다 — 그래서 korean-prose로 센다.
   * (이 단언이 없으면 `ASCII_TOKEN` 검사를 통째로 지워도 아무 테스트도 죽지 않는다: 뮤테이션 M24.)
   */
  it("조사가 붙은 식별자는 한국어 토큰이다 — 순수 ASCII 토큰이 아니면 식별자가 아니다", () => {
    expect(classifyQueryKind("E11000이 떴다")).toBe("korean-prose");
    expect(classifyQueryKind("메모리가 100퍼센트까지 올라갔다")).toBe("korean-prose");
    // 조사를 떼면 텍스트 경로가 붙잡을 수 있다.
    expect(classifyQueryKind("E11000 이 떴다")).toBe("identifier");
  });

  it("영숫자가 하나도 없는 ASCII 토큰(구두점)은 식별자가 아니다", () => {
    expect(classifyQueryKind("배포가 됐는데 ... 왜 안 뜨지")).toBe("korean-prose");
  });

  it("한글도 ASCII 식별자도 없으면 other다 — 조용히 한쪽에 섞지 않는다", () => {
    expect(classifyQueryKind("???")).toBe("other");
    expect(classifyQueryKind("日本語のみ")).toBe("other");
  });
});
