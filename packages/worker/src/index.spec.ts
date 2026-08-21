import { describe, expect, it } from "vitest";

import { DEPENDS_ON, PACKAGE_NAME } from "./index.js";

describe("@sentinel/worker smoke", () => {
  it("패키지가 로드되고 core 의존이 동작한다", () => {
    expect(PACKAGE_NAME).toBe("@sentinel/worker");
    expect(DEPENDS_ON).toContain("@sentinel/core");
  });
});
