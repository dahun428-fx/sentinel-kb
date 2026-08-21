import { describe, expect, it } from "vitest";

import { VERSION } from "./version.js";

describe("VERSION", () => {
  it("semver 형식이다", () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("0.0.1이다", () => {
    expect(VERSION).toBe("0.0.1");
  });
});
