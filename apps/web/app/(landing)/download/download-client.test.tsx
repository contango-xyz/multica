import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DownloadClient } from "./download-client";
import type { LatestRelease } from "@/features/landing/utils/github-release";

vi.mock("@/features/landing/i18n", () => ({
  useLocale: () => ({
    t: {
      download: {
        footer: {
          currentVersion: "Version {version}",
          releaseNotes: "Release notes {version}",
          allReleases: "All releases",
          versionUnavailable: "Version unavailable",
        },
      },
    },
  }),
}));
vi.mock("@/features/landing/utils/os-detect", () => ({
  detectOS: () => new Promise(() => {}),
}));
vi.mock("@/features/landing/components/landing-header", () => ({
  LandingHeader: () => null,
}));
vi.mock("@/features/landing/components/landing-footer", () => ({
  LandingFooter: () => null,
}));
vi.mock("@/features/landing/components/download/hero", () => ({
  DownloadHero: ({ detected }: { detected: { os: string } | null }) => (
    <div data-testid="hero">{detected?.os ?? "none"}</div>
  ),
}));
vi.mock("@/features/landing/components/download/all-platforms", () => ({
  AllPlatforms: () => <div data-testid="all-platforms" />,
}));
vi.mock("@/features/landing/components/download/cli-section", () => ({
  CliSection: () => <div data-testid="cli" />,
}));
vi.mock("@/features/landing/components/download/cloud-section", () => ({
  CloudSection: () => <div data-testid="cloud" />,
}));

const upstream: LatestRelease = {
  version: "v1.0.0",
  publishedAt: null,
  htmlUrl: "https://github.test/r/v1.0.0",
  assets: {},
};

describe("DownloadClient", () => {
  it("keeps the upstream page when the release is not fork-only", () => {
    render(<DownloadClient release={upstream} />);
    expect(screen.getByTestId("all-platforms")).toBeInTheDocument();
    expect(screen.getByTestId("cli")).toBeInTheDocument();
    expect(screen.getByText("All releases")).toBeInTheDocument();
    expect(screen.getByText("Release notes v1.0.0")).toBeInTheDocument();
  });

  it("shows only our Mac download in fork mode", async () => {
    render(
      <DownloadClient
        release={{
          ...upstream,
          version: "0.7.0-contango.4",
          htmlUrl: null,
          forkOnly: true,
          assets: { macArm64Dmg: "https://srv.test/desktop/M.dmg" },
        }}
      />,
    );
    expect(screen.getByTestId("hero")).toHaveTextContent("mac");
    expect(screen.queryByTestId("all-platforms")).not.toBeInTheDocument();
    expect(screen.queryByTestId("cli")).not.toBeInTheDocument();
    expect(screen.queryByTestId("cloud")).not.toBeInTheDocument();
    expect(screen.queryByText("All releases")).not.toBeInTheDocument();
    expect(screen.queryByText(/Release notes/)).not.toBeInTheDocument();
    expect(screen.getByText("Version 0.7.0-contango.4")).toBeInTheDocument();
  });
});
