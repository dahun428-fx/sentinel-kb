import { describe, expect, it } from "vitest";

import { DEPENDS_ON, PACKAGE_NAME } from "./index.js";

describe("@sentinel/web smoke", () => {
  it("패키지가 로드되고 core 의존이 동작한다", () => {
    expect(PACKAGE_NAME).toBe("@sentinel/web");
    expect(DEPENDS_ON).toContain("@sentinel/core");
  });
});
