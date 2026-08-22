/**
 * **skip은 통과가 아니다** — T-010 F-5가 남긴 게이트다 (T-026 인계 6).
 *
 * `search-indexes.int.spec.ts`·`retrieve.int.spec.ts`·`search.int.spec.ts`는 docker가 없으면
 * `describe.skipIf`로 통째로 건너뛰고 **exit 0**을 낸다. stderr 배너를 찍긴 하지만
 * **배너는 게이트가 아니다.** 러너 로그를 사람이 읽지 않으면 "docker가 없으니 그린"이
 * 그대로 머지된다. 실제로 그 Acceptance들은 그 환경에서 **판정되지 않았다.**
 *
 * 그래서 `REQUIRE_DOCKER=1`을 켠 곳(=CI)에서는 docker 부재를 **하드 실패로 승격한다.**
 * 로컬은 기본 off라 docker 없이도 개발할 수 있다 — 판정처를 CI 하나로 모으는 것이 요점이지
 * 모두를 불편하게 만드는 것이 아니다.
 *
 * `packages/core/src/testing/atlas-local.ts`의 `dockerAvailable()`을 import하지 않고 3줄을
 * 다시 쓴 이유: tools 프로젝트가 packages/core를 참조하면 `tsc -b`에 프로젝트 참조를
 * 추가해야 하는데 그건 이 태스크 범위(`packages/**` 수정 금지) 밖이다.
 */
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

/** `1|true|yes|on` (대소문자 무시)일 때만 켜진다. `.env.example`의 다른 불리언과 같은 규약이다. */
function isEnabled(raw: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test(raw?.trim() ?? "");
}

export function dockerAvailable(): boolean {
  return spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], { encoding: "utf8" })
    .status === 0;
}

const required = isEnabled(process.env["REQUIRE_DOCKER"]);

describe("REQUIRE_DOCKER 게이트 (T-010 F-5 / T-026)", () => {
  it(
    required
      ? "REQUIRE_DOCKER가 켜져 있으므로 docker 데몬에 반드시 닿아야 한다"
      : "REQUIRE_DOCKER가 꺼져 있다 — docker 의존 통합 테스트는 skip될 수 있고, 그것은 통과가 아니다",
    () => {
      if (!required) {
        // 로컬에서는 게이트를 강제하지 않는다. 다만 상태를 남겨 둔다.
        expect(required).toBe(false);
        return;
      }
      expect(
        dockerAvailable(),
        [
          "REQUIRE_DOCKER=1인데 docker 데몬에 닿지 못했다.",
          "이 러너에서는 atlas-local이 필요한 통합 테스트들이 전부 skip되고,",
          "그 skip은 '통과'가 아니라 '판정되지 않음'이다. 러너에 docker를 붙이거나,",
          "판정 불가를 인정하고 REQUIRE_DOCKER를 끈 채로 결과를 보고하라.",
        ].join(" "),
      ).toBe(true);
    },
  );
});
