/**
 * Formatting for the Settings "About" section, free of React Native imports
 * so it is unit-testable. Callers pass localized labels; English is the default.
 */
export interface AppVersionLabels {
  builtIn: string;
  development: string;
  update(date: string, shortId: string): string;
}

export const DEFAULT_APP_VERSION_LABELS: AppVersionLabels = {
  builtIn: "Built-in",
  development: "Development build",
  update: (date, shortId) => (shortId ? `Update ${date} (${shortId})` : `Update ${date}`),
};

export interface AppVersionInput {
  version: string | null;
  build: string | null;
  isEnabled: boolean;
  isEmbeddedLaunch: boolean;
  updateId: string | null | undefined;
  createdAt: Date | null | undefined;
}

export function describeAppVersion(
  input: AppVersionInput,
  labels: AppVersionLabels = DEFAULT_APP_VERSION_LABELS,
): { version: string; running: string } {
  const version = [input.version ?? "—", input.build ? `(${input.build})` : ""]
    .filter(Boolean)
    .join(" ");
  if (!input.isEnabled) return { version, running: labels.development };
  if (input.isEmbeddedLaunch || !input.updateId) {
    return { version, running: labels.builtIn };
  }
  const date =
    input.createdAt && !Number.isNaN(input.createdAt.getTime())
      ? input.createdAt.toISOString().slice(0, 10)
      : "";
  const shortId = input.updateId.slice(0, 8);
  return {
    version,
    running: date ? labels.update(date, shortId) : labels.update("—", shortId),
  };
}
