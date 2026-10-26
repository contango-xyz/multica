// @vitest-environment node
import { describe, expect, it } from "vitest";
import { appPathForWebUrl } from "./web-link";

const APP = "https://srv.example.test";

describe("appPathForWebUrl", () => {
  it("maps our links to the in-app path", () => {
    expect(appPathForWebUrl("https://srv.example.test/acme/issues/abc?x=1#c", APP)).toBe("/acme/issues/abc?x=1#c");
  });
  it.each([
    "https://evil.example.test/acme/issues/abc",
    "http://srv.example.test/acme",
    "https://srv.example.test.evil.test/x",
    "not a url",
  ])("refuses %s", (u) => expect(appPathForWebUrl(u, APP)).toBeNull());
  it("refuses the bare origin", () => expect(appPathForWebUrl("https://srv.example.test/", APP)).toBeNull());
});
