import { describe, expect, it } from "vitest";

import { consoleHref, isSearchable, parseConsoleQuery } from "./search-params";

describe("parseConsoleQuery", () => {
  it("질의·필터를 읽는다", () => {
    expect(parseConsoleQuery({ q: " 웹훅 타임아웃 ", type: "incident", project: "bizcare" })).toEqual({
      q: "웹훅 타임아웃",
      type: "incident",
      project: "bizcare",
    });
  });

  it("빈 필터는 필드 자체를 만들지 않는다 — `type=`이 그대로 core-api로 새면 400이 난다", () => {
    expect(parseConsoleQuery({ q: "타임아웃", type: "", project: "" })).toEqual({ q: "타임아웃" });
  });

  it("계약에 없는 type은 400 대신 무시한다", () => {
    expect(parseConsoleQuery({ q: "타임아웃", type: "postmortem" })).toEqual({ q: "타임아웃" });
  });

  it("같은 키가 여러 번 오면 첫 값을 쓴다", () => {
    expect(parseConsoleQuery({ q: ["첫째", "둘째"] })).toEqual({ q: "첫째" });
  });

  it("질의가 없으면 빈 문자열이다", () => {
    expect(parseConsoleQuery({})).toEqual({ q: "" });
  });
});

describe("isSearchable", () => {
  it("contracts의 SearchRequest.query 최소 길이(2)를 못 넘기면 부르지 않는다", () => {
    expect(isSearchable({ q: "" })).toBe(false);
    expect(isSearchable({ q: "a" })).toBe(false);
    expect(isSearchable({ q: "ab" })).toBe(true);
  });
});

describe("consoleHref", () => {
  it("검색 ↔ 답변 사이에서 질의와 필터를 잃지 않는다", () => {
    expect(consoleHref("/answer", { q: "웹훅 타임아웃", type: "incident" })).toBe(
      "/answer?q=%EC%9B%B9%ED%9B%85+%ED%83%80%EC%9E%84%EC%95%84%EC%9B%83&type=incident",
    );
  });

  it("빈 질의면 경로만 남는다", () => {
    expect(consoleHref("/", { q: "" })).toBe("/");
  });
});
