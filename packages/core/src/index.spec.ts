import { describe, expect, it } from "vitest";

import { DEFAULT_SEVERITY, PACKAGE_NAME } from "./index.js";

describe("@sentinel/core smoke", () => {
  it("패키지가 로드되고 contracts 의존이 동작한다", () => {
    expect(PACKAGE_NAME).toBe("@sentinel/core");
    expect(DEFAULT_SEVERITY).toBe("NOTE");
  });
});
