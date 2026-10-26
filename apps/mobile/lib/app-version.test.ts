// @vitest-environment node
import { describe, expect, it } from "vitest";
import { describeAppVersion } from "./app-version";

const base = {
  version: "0.6.1",
  build: "12",
  isEnabled: true,
  isEmbeddedLaunch: true,
  updateId: "0190aaaa-bbbb-cccc-dddd-eeeeffff0000",
  createdAt: new Date("2026-10-26T18:30:00Z"),
};

describe("describeAppVersion", () => {
  it("formats version and build", () => {
    expect(describeAppVersion(base).version).toBe("0.6.1 (12)");
  });
  it("omits a missing build and falls back for a missing version", () => {
    expect(describeAppVersion({ ...base, build: null }).version).toBe("0.6.1");
    expect(describeAppVersion({ ...base, version: null, build: null }).version).toBe("—");
  });
  it("says Built-in for an embedded launch", () => {
    expect(describeAppVersion(base).running).toBe("Built-in");
  });
  it("says Built-in when there is no update id", () => {
    expect(
      describeAppVersion({ ...base, isEmbeddedLaunch: false, updateId: null }).running,
    ).toBe("Built-in");
  });
  it("describes a downloaded update with date and short id", () => {
    expect(describeAppVersion({ ...base, isEmbeddedLaunch: false }).running).toBe(
      "Update 2026-10-26 (0190aaaa)",
    );
  });
  it("tolerates a missing createdAt", () => {
    expect(
      describeAppVersion({ ...base, isEmbeddedLaunch: false, createdAt: null }).running,
    ).toBe("Update — (0190aaaa)");
  });
  it("says Development build when updates are disabled", () => {
    expect(describeAppVersion({ ...base, isEnabled: false }).running).toBe("Development build");
  });
  it("uses supplied labels", () => {
    const labels = { builtIn: "B", development: "D", update: (d: string, i: string) => `U${d}${i}` };
    expect(describeAppVersion({ ...base, isEmbeddedLaunch: false }, labels).running).toBe(
      "U2026-10-260190aaaa",
    );
  });
});
