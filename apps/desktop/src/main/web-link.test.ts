// @vitest-environment node
import { describe, expect, it } from "vitest";
import { decideAppPath, decideWebLink } from "./web-link";

const APP = "https://srv.example.test";

describe("decideWebLink", () => {
  it("routes our links to the in-app path", () => {
    expect(decideWebLink("https://srv.example.test/acme/issues/abc?x=1#c", APP)).toEqual({
      kind: "route",
      path: "/acme/issues/abc?x=1#c",
    });
  });

  it("treats http on our host as ours", () => {
    expect(decideWebLink("http://srv.example.test/acme", APP)).toEqual({ kind: "route", path: "/acme" });
  });

  it.each([
    "https://srv.example.test/",
    "https://srv.example.test",
    "http://srv.example.test/",
    "https://srv.example.test/login",
    "https://srv.example.test/login?next=%2Facme",
    "https://srv.example.test/desktop/latest-mac.yml",
    "https://srv.example.test/desktop",
    "https://srv.example.test/api/me",
    "https://srv.example.test/api",
  ])("only focuses the app for %s (never hands our host back to the OS)", (u) => {
    expect(decideWebLink(u, APP)).toEqual({ kind: "focus" });
  });

  it.each([
    "https://evil.example.test/acme/issues/abc",
    "https://srv.example.test.evil.test/x",
    "not a url",
  ])("sends %s to the browser", (u) => expect(decideWebLink(u, APP)).toEqual({ kind: "external" }));

  it("does not treat look-alike paths as non-app paths", () => {
    expect(decideWebLink("https://srv.example.test/desktops/x", APP)).toEqual({ kind: "route", path: "/desktops/x" });
    expect(decideWebLink("https://srv.example.test/login-help", APP)).toEqual({ kind: "route", path: "/login-help" });
  });

  it("only focuses when runtime config is missing", () => {
    expect(decideWebLink("https://srv.example.test/acme", null)).toEqual({ kind: "focus" });
    expect(decideWebLink("https://evil.example.test/x", null)).toEqual({ kind: "focus" });
  });
});

describe("decideAppPath", () => {
  it("routes an in-app path with query and hash", () => {
    expect(decideAppPath("/acme/issues/abc?x=1#c")).toEqual({ kind: "route", path: "/acme/issues/abc?x=1#c" });
  });

  it.each([
    "/",
    "/login",
    "/login?next=%2Facme",
    "/desktop/x",
    "/api/x",
    "//evil.test/x",
    "/\\evil.test/x",
    "https://evil.test/x",
    "",
    "acme/issues",
    "/\t/evil.test/x",
    "/\n//evil.test",
    "/\r/evil.test",
    "/a\u0000b",
    "/a\u007fb",
    "/\t/[",
  ])("only focuses for %j", (p) => {
    expect(decideAppPath(p)).toEqual({ kind: "focus" });
  });

  it("focuses instead of throwing when the URL parser throws", () => {
    expect(() => decideAppPath("/\t/[")).not.toThrow();
    expect(decideAppPath("/\t/[")).toEqual({ kind: "focus" });
  });
});
