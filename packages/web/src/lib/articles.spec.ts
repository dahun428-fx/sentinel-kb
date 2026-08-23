/**
 * T-033 Acceptance 3의 관측 경로다.
 *
 * "candidate 상태 아티클은 공개 목록에 노출되지 않는다" — 서버가 이미 보장하지만
 * (`ListArticlesQuery.status`의 `.default("published")`), **웹이 `status`를 붙이면 그 보장이
 * 뚫린다.** 그래서 여기서 재는 것은 필터 로직이 아니라 **웹이 만드는 경로 문자열**이다.
 *
 * 기대값에 측정 대상 상수를 쓰지 않는다(T-041 래칫) — 경로 문면은 전부 리터럴이다.
 */
import { describe, expect, it } from "vitest";

import {
  articleEditHref,
  articleExportHref,
  articleHref,
  articlePublishPath,
  articleQueueHref,
  articleResourcePath,
  articleStatusLabel,
  canEditArticle,
  canPublishArticle,
  editErrorMessage,
  formatArticleDate,
  isQueueStatus,
  parseCursor,
  parseQueueStatus,
  publicArticlesHref,
  publicArticlesPath,
  publishBlockReason,
  publishRequestBody,
  queueArticlesPath,
} from "./articles";

describe("공개 목록 경로 (Acceptance 3)", () => {
  it("status를 싣지 않는다 — 서버 기본값(published)이 그대로 적용된다", () => {
    expect(publicArticlesPath()).toBe("/v1/articles");
    expect(publicArticlesPath()).not.toContain("status");
  });

  it("커서를 붙여도 status는 여전히 없다", () => {
    expect(publicArticlesPath("abc123")).toBe("/v1/articles?cursor=abc123");
    expect(publicArticlesPath("abc123")).not.toContain("status");
  });

  it("커서를 URL 인코딩한다 — 커서는 서버가 만든 불투명 문자열이다", () => {
    expect(publicArticlesPath("a b+c")).toBe("/v1/articles?cursor=a%20b%2Bc");
  });

  it("공개 목록 화면 링크에도 status가 없다", () => {
    expect(publicArticlesHref()).toBe("/articles");
    expect(publicArticlesHref("next")).toBe("/articles?cursor=next");
    expect(publicArticlesHref("next")).not.toContain("status");
  });
});

describe("후보 큐 경로", () => {
  it("status를 명시한다 — specs/04: 명시해야 후보 큐가 보인다", () => {
    expect(queueArticlesPath("candidate")).toBe("/v1/articles?status=candidate");
    expect(queueArticlesPath("draft")).toBe("/v1/articles?status=draft");
  });

  it("커서와 함께 써도 status가 남는다", () => {
    expect(queueArticlesPath("draft", "c1")).toBe("/v1/articles?status=draft&cursor=c1");
  });

  it("큐 화면 링크", () => {
    expect(articleQueueHref("candidate")).toBe("/articles/queue?status=candidate");
  });
});

describe("parseQueueStatus", () => {
  it("published는 큐 상태가 아니다 — 발행물이 대기열에 섞이지 않는다", () => {
    expect(isQueueStatus("published")).toBe(false);
    expect(parseQueueStatus("published")).toBe("candidate");
  });

  it("rejected도 큐 상태가 아니다", () => {
    expect(isQueueStatus("rejected")).toBe(false);
    expect(parseQueueStatus("rejected")).toBe("candidate");
  });

  it("candidate·draft만 통과한다", () => {
    expect(parseQueueStatus("candidate")).toBe("candidate");
    expect(parseQueueStatus("draft")).toBe("draft");
    expect(parseQueueStatus(" draft ")).toBe("draft");
  });

  it("없거나 모르는 값이면 기본값으로 되돌린다 — URL을 손댔다고 에러 화면을 내지 않는다", () => {
    expect(parseQueueStatus(undefined)).toBe("candidate");
    expect(parseQueueStatus("nope")).toBe("candidate");
    expect(parseQueueStatus(["draft", "candidate"])).toBe("draft");
  });
});

describe("parseCursor", () => {
  it("빈 값은 커서 없음이다", () => {
    expect(parseCursor(undefined)).toBeUndefined();
    expect(parseCursor("  ")).toBeUndefined();
    expect(parseCursor("c1")).toBe("c1");
  });
});

describe("발행 요청 바디 (specs/04: publishedAt은 서버가 찍는다)", () => {
  it("키가 하나도 없다 — 클라이언트가 보낼 정보가 없다", () => {
    expect(Object.keys(publishRequestBody())).toEqual([]);
  });

  it("두 번 불러도 같은 빈 바디다", () => {
    expect(publishRequestBody()).toEqual({});
  });
});

describe("편집 게이트 (specs/04: candidate·draft에서만)", () => {
  it("published에는 편집이 열리지 않는다", () => {
    expect(canEditArticle("published")).toBe(false);
  });

  it("rejected에도 열리지 않는다 — 사람이 내린 판단을 지우는 일이다", () => {
    expect(canEditArticle("rejected")).toBe(false);
  });

  it("candidate·draft에는 열린다", () => {
    expect(canEditArticle("candidate")).toBe(true);
    expect(canEditArticle("draft")).toBe(true);
  });
});

describe("발행 게이트 (specs/08 §0-5: 전자동 발행 금지)", () => {
  it("본문 있는 draft만 발행할 수 있다", () => {
    expect(canPublishArticle({ status: "draft", body: "본문" })).toBe(true);
  });

  it("candidate는 발행할 수 없다 — 아무도 쓰지 않은 글이다", () => {
    expect(canPublishArticle({ status: "candidate", body: "본문" })).toBe(false);
  });

  it("본문 없는 draft는 발행할 수 없다", () => {
    expect(canPublishArticle({ status: "draft" })).toBe(false);
    expect(canPublishArticle({ status: "draft", body: "   " })).toBe(false);
  });

  it("이미 발행된 것은 다시 발행할 수 없다", () => {
    expect(canPublishArticle({ status: "published", body: "본문" })).toBe(false);
  });

  it("못 누르는 이유를 문장으로 알려준다 — 버튼만 감추면 아무도 모른다", () => {
    expect(publishBlockReason({ status: "draft", body: "본문" })).toBeNull();
    expect(publishBlockReason({ status: "candidate" })).toContain("후보");
    expect(publishBlockReason({ status: "published", body: "x" })).toContain("이미");
    expect(publishBlockReason({ status: "rejected", body: "x" })).toContain("반려");
    expect(publishBlockReason({ status: "draft", body: "" })).toContain("본문");
  });
});

describe("화면 경로와 표기", () => {
  it("상세·편집·내보내기 링크", () => {
    expect(articleHref("abc")).toBe("/articles/abc");
    expect(articleEditHref("abc")).toBe("/articles/abc/edit");
    expect(articleExportHref("abc")).toBe("/articles/abc/export");
  });

  it("core-api 리소스 경로", () => {
    expect(articleResourcePath("abc")).toBe("/v1/articles/abc");
    expect(articlePublishPath("abc")).toBe("/v1/articles/abc/publish");
  });

  it("경로에 들어가는 id를 인코딩한다", () => {
    expect(articleHref("a/b")).toBe("/articles/a%2Fb");
    expect(articleResourcePath("a/b")).toBe("/v1/articles/a%2Fb");
  });

  it("상태 라벨은 네 상태 전부 있다", () => {
    expect(articleStatusLabel("candidate")).toBe("후보");
    expect(articleStatusLabel("draft")).toBe("초안");
    expect(articleStatusLabel("published")).toBe("발행됨");
    expect(articleStatusLabel("rejected")).toBe("반려");
  });

  it("날짜는 UTC 고정 포맷 — 하이드레이션이 타임존으로 흔들리지 않는다", () => {
    expect(formatArticleDate(new Date("2026-08-21T23:30:00.000Z"))).toBe("2026-08-21");
  });
});

describe("editErrorMessage", () => {
  it("아는 코드는 사람 문장으로 옮긴다", () => {
    expect(editErrorMessage("ARTICLE_NOT_EDITABLE")).toContain("편집할 수 없는");
  });

  it("모르는 코드는 감추지 않고 그대로 드러낸다", () => {
    expect(editErrorMessage("SOMETHING_NEW")).toContain("SOMETHING_NEW");
  });
});
