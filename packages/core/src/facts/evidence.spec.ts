/**
 * 스니펫 추출 테스트. 관심사는 두 가지뿐이다:
 * **한국어 산문 속에서 경계를 정확히 잡는가**, 그리고 **허용목록 밖은 통과하지 못하는가**.
 */
import { describe, expect, it } from "vitest";

import { extractSnippets } from "./evidence.js";
import type { EvidenceKind } from "./types.js";

function texts(kind: EvidenceKind, body: string): string[] {
  return extractSnippets("aaaaaaaaaaaaaaaaaaaa0001", "symptom", body)
    .filter((snippet) => snippet.kind === kind)
    .map((snippet) => snippet.text);
}

describe("명령어", () => {
  it("한국어 조사 앞에서 끊는다", () => {
    expect(texts("command", "이후 pnpm install --force로 재설치하니 바이너리가 배치됐다.")).toEqual([
      "pnpm install --force",
    ]);
  });

  it("한 문장에 든 두 명령어를 각각 뽑는다", () => {
    expect(
      texts(
        "command",
        "진단은 dig SRV _mongodb._tcp.cluster0.example.net 와 nc -vz node0.example.net 27017 두 명령으로 갈랐다.",
      ),
    ).toEqual(["dig SRV _mongodb._tcp.cluster0.example.net", "nc -vz node0.example.net 27017"]);
  });

  it("인자 없는 도구 이름 단독은 명령어가 아니다", () => {
    expect(texts("command", "pnpm 자체는 문제가 없었다.")).toEqual([]);
  });

  it("문장 구분자에서 멈춘다 — 영문 본문에서 문단을 삼키지 않는다", () => {
    expect(texts("command", "We ran git status. Then everything looked fine.")).toEqual([
      "git status",
    ]);
  });

  it("허용목록 밖의 실행 파일은 명령어로 보지 않는다", () => {
    expect(texts("command", "그다음 frobnicate --all 을 돌렸다.")).toEqual([]);
  });
});

describe("에러 원문", () => {
  it("따옴표 안의 에러 원문을 그대로 뽑는다", () => {
    expect(
      texts("error", "에러 원문: 'MongoServerSelectionError: Server selection timed out after 5000 ms'."),
    ).toContain("MongoServerSelectionError: Server selection timed out after 5000 ms");
  });

  it("따옴표 없이 떠 있는 에러 클래스도 잡는다", () => {
    expect(texts("error", "TypeError: cannot read properties of undefined 가 났다.")).toContain(
      "TypeError: cannot read properties of undefined",
    );
  });

  it("errno는 허용목록에 있는 것만 인정한다", () => {
    expect(texts("error", "ECONNREFUSED 가 반복됐다.")).toContain("ECONNREFUSED");
    // 평범한 대문자 단어가 에러 코드로 둔갑하면 발행물에 오탐이 남는다.
    expect(texts("error", "EXAMPLE 은 예시일 뿐이다.")).toEqual([]);
  });

  it("에러 신호가 없는 인용부호는 에러가 아니다", () => {
    expect(texts("error", "담당자는 '다음 주에 보자'고 했다.")).toEqual([]);
  });
});

describe("경로·수치·버전·URL", () => {
  it("파일 경로를 뽑는다", () => {
    const found = texts("path", "packages/contracts/src/record.ts 를 고치고 pnpm-lock.yaml 을 갱신했다.");
    expect(found).toContain("packages/contracts/src/record.ts");
    expect(found).toContain("pnpm-lock.yaml");
  });

  it("수치+단위는 닫힌 단위 어휘일 때만 뽑는다", () => {
    expect(texts("metric", "타임아웃이 30초에서 5000 ms로 줄었다.")).toEqual(["30초", "5000 ms"]);
    expect(texts("metric", "포트는 27017 이다.")).toEqual([]);
  });

  it("버전은 v접두사·세 자리·제품명 중 하나가 있어야 한다", () => {
    expect(texts("version", "pnpm 10.x 에서만 재현된다.")).toContain("pnpm 10.x");
    expect(texts("version", "v1.2.3 으로 올렸다.")).toContain("v1.2.3");
    // 임계값 0.62는 버전이 아니다.
    expect(texts("version", "임계값 0.62로 두었다.")).toEqual([]);
  });

  it("쿼리스트링·userinfo가 붙은 URL은 후보에서 뺀다", () => {
    expect(texts("url", "문서는 https://example.com/docs/mongo 에 있다.")).toEqual([
      "https://example.com/docs/mongo",
    ]);
    expect(texts("url", "https://example.com/cb?api_key=abcd1234efgh5678 로 호출했다.")).toEqual([]);
    expect(texts("url", "https://user:pw@example.com/x 로 붙었다.")).toEqual([]);
  });
});

describe("중복·포함 관계", () => {
  it("긴 스니펫에 포함된 짧은 스니펫은 따로 세지 않는다", () => {
    const all = extractSnippets(
      "aaaaaaaaaaaaaaaaaaaa0001",
      "symptom",
      "에러 원문: 'MongoServerSelectionError: Server selection timed out after 5000 ms'.",
    ).map((snippet) => snippet.text);
    expect(all).not.toContain("5000 ms");
  });

  it("같은 (레코드, 섹션)에서 같은 텍스트는 한 번만 나온다", () => {
    const all = extractSnippets(
      "aaaaaaaaaaaaaaaaaaaa0001",
      "resolution",
      "pnpm install --force 로 고쳤고, 안 되면 다시 pnpm install --force 를 돌린다.",
    );
    expect(all.filter((snippet) => snippet.text === "pnpm install --force")).toHaveLength(1);
  });
});

describe("정렬", () => {
  /**
   * 종류가 아니라 **본문 등장 순서**로 정렬된다. 규칙 순서로 나가면 같은 문장을 읽는
   * 사람과 순서가 어긋나고, 무엇보다 정렬 지점이 사라져도 아무 테스트가 깨지지 않는다.
   */
  it("종류가 달라도 본문 등장 순서를 따른다", () => {
    const all = extractSnippets(
      "aaaaaaaaaaaaaaaaaaaa0001",
      "resolution",
      "pnpm install --force 를 돌리자 TypeError: cannot read properties of undefined 가 났다.",
    );
    expect(all.map((snippet) => snippet.kind)).toEqual(["command", "error"]);
  });
});

describe("스크린 통과 실패는 후보가 되지 않는다", () => {
  it("자격증명이 든 URI는 어떤 종류로도 나오지 않는다", () => {
    const all = extractSnippets(
      "aaaaaaaaaaaaaaaaaaaa0001",
      "symptom",
      "접속 문자열은 mongodb://appuser:Str0ng Pass@cluster0.example.net/sentinel 였다.",
    );
    for (const snippet of all) {
      expect(snippet.text).not.toContain("Str0ng");
      expect(snippet.text).not.toContain("appuser");
    }
  });
});
