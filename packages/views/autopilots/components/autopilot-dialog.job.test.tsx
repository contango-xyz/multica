import { useImperativeHandle, useRef, useState } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderWithI18n } from "../../test/i18n";

// Contango patch 22: the "Ops job (no agent)" execution mode. Choosing it
// swaps the assignee picker for a job-name field, drops the webhook option,
// and saves execution_mode "job" + job_name with no assignee.

const mockCreateAutopilot = vi.hoisted(() => vi.fn());
const mockCreateTrigger = vi.hoisted(() => vi.fn());
const mockUpdateAutopilot = vi.hoisted(() => vi.fn());

vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "ws-test" }));
vi.mock("@multica/core/paths", () => ({ useCurrentWorkspace: () => ({ name: "Acme" }) }));

vi.mock("@multica/core/workspace/queries", () => ({
  agentListOptions: (wsId: string) => ({
    queryKey: ["agents", wsId],
    queryFn: async () => [
      {
        id: "agent-1",
        name: "Scout",
        description: "Researches things",
        archived_at: null,
        runtime_id: "runtime-1",
      },
    ],
  }),
  squadListOptions: (wsId: string) => ({
    queryKey: ["squads", wsId],
    queryFn: async () => [],
  }),
}));

vi.mock("@multica/core/projects/queries", () => ({
  projectListOptions: (wsId: string) => ({
    queryKey: ["projects", wsId],
    queryFn: async () => [],
  }),
}));

vi.mock("@multica/core/autopilots/queries", () => ({
  cronPreviewOptions: (wsId: string, expr: string, tz: string) => ({
    queryKey: ["cron-preview", wsId, expr, tz],
    queryFn: async () => ({ next_runs: ["2126-07-14T01:00:00Z"] }),
    retry: false,
  }),
}));

vi.mock("@multica/core/autopilots/mutations", () => ({
  useCreateAutopilot: () => ({ mutateAsync: mockCreateAutopilot }),
  useCreateAutopilotTrigger: () => ({ mutateAsync: mockCreateTrigger }),
  useUpdateAutopilot: () => ({ mutateAsync: mockUpdateAutopilot }),
  useUpdateAutopilotTrigger: () => ({ mutateAsync: vi.fn() }),
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

// Tiptap in jsdom is neither cheap nor the subject here: the title is a plain
// input whose ref honours focus(), which is all the dialog asks of it.
vi.mock("../../editor", () => ({
  TitleEditor: ({ ref, defaultValue, placeholder, onChange, onSubmit }: any) => {
    const [value, setValue] = useState(defaultValue ?? "");
    const inputRef = useRef<HTMLInputElement>(null);
    useImperativeHandle(ref, () => ({
      getText: () => value,
      focus: () => inputRef.current?.focus(),
      focusAtCoords: () => inputRef.current?.focus(),
    }));
    return (
      <input
        ref={inputRef}
        aria-label="title"
        value={value}
        placeholder={placeholder}
        onChange={(e) => {
          setValue(e.target.value);
          onChange?.(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") onSubmit?.();
        }}
      />
    );
  },
  ContentEditor: ({ placeholder }: any) => <textarea aria-label="runbook" placeholder={placeholder} />,
}));

vi.mock("../../common/actor-avatar", () => ({
  ActorAvatar: ({ actorId }: { actorId: string }) => <span data-testid="actor-avatar">{actorId}</span>,
}));

vi.mock("./subscriber-multi-select", () => ({
  SubscriberMultiSelect: () => <div data-testid="subscriber-multi-select" />,
}));

vi.mock("../../projects/components/project-picker", () => ({
  ProjectPicker: ({ triggerRender }: { triggerRender: React.ReactElement }) => triggerRender,
}));

vi.mock("../pickers/timezone-picker", () => ({
  TimezonePicker: ({ value }: { value: string }) => <div data-testid="timezone-picker">{value}</div>,
}));

import { AutopilotDialog } from "./autopilot-dialog";

function renderDialog(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderWithI18n(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

const jobModeButton = () => screen.getByRole("button", { name: /Ops job \(no agent\)/ });

describe("AutopilotDialog ops job mode", () => {
  beforeEach(() => {
    mockCreateAutopilot.mockReset();
    mockCreateTrigger.mockReset();
    mockUpdateAutopilot.mockReset();
  });

  it("hides the assignee and webhook options and shows a job name field", async () => {
    const user = userEvent.setup();
    renderDialog(<AutopilotDialog mode="create" open onOpenChange={vi.fn()} />);

    expect(screen.getByRole("button", { name: /Select agent or squad/ })).toBeInTheDocument();
    expect(screen.queryByLabelText(/Job name/)).not.toBeInTheDocument();

    await user.click(jobModeButton());

    expect(screen.queryByRole("button", { name: /Select agent or squad/ })).not.toBeInTheDocument();
    expect(screen.getByLabelText(/Job name/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Webhook/ })).not.toBeInTheDocument();
  });

  it("requires a valid job name, then creates a job with a schedule and no assignee", async () => {
    const user = userEvent.setup();
    mockCreateAutopilot.mockResolvedValue({ id: "ap-job" });
    mockCreateTrigger.mockResolvedValue({ id: "tr-1" });
    renderDialog(<AutopilotDialog mode="create" open onOpenChange={vi.fn()} />);

    await user.type(screen.getByLabelText("title"), "PR watch");
    await user.click(jobModeButton());
    await user.click(screen.getByRole("button", { name: "Create autopilot" }));
    expect(await screen.findByText("Enter a job name")).toBeInTheDocument();
    expect(mockCreateAutopilot).not.toHaveBeenCalled();

    const input = screen.getByLabelText(/Job name/);
    await user.type(input, "PR Watch");
    await user.click(screen.getByRole("button", { name: "Create autopilot" }));
    expect(await screen.findByText(/Use lowercase letters/)).toBeInTheDocument();
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(mockCreateAutopilot).not.toHaveBeenCalled();

    await user.clear(input);
    await user.type(input, "pr-watch");
    await user.click(screen.getByRole("button", { name: "Create autopilot" }));

    await waitFor(() => expect(mockCreateAutopilot).toHaveBeenCalledTimes(1));
    const payload = mockCreateAutopilot.mock.calls[0]?.[0];
    expect(payload).toMatchObject({ title: "PR watch", execution_mode: "job", job_name: "pr-watch" });
    expect(payload).not.toHaveProperty("assignee_id");
    await waitFor(() => expect(mockCreateTrigger).toHaveBeenCalledTimes(1));
    expect(mockCreateTrigger.mock.calls[0]?.[0]).toMatchObject({ autopilotId: "ap-job", kind: "schedule" });
  });

  it("edits a job without asking for an assignee", async () => {
    const user = userEvent.setup();
    mockUpdateAutopilot.mockResolvedValue({ id: "ap-job" });
    renderDialog(
      <AutopilotDialog
        mode="edit"
        open
        onOpenChange={vi.fn()}
        autopilotId="ap-job"
        initial={{
          title: "Explore",
          description: "",
          project_id: null,
          assignee_type: "agent",
          assignee_id: "",
          execution_mode: "job",
          job_name: "explore",
        }}
        triggers={[]}
        collaborators={[]}
        canManageAccess={false}
      />,
    );

    const input = screen.getByLabelText(/Job name/);
    expect(input).toHaveValue("explore");
    await user.clear(input);
    await user.type(input, "explore-v2");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(mockUpdateAutopilot).toHaveBeenCalledTimes(1));
    const payload = mockUpdateAutopilot.mock.calls[0]?.[0];
    expect(payload).toMatchObject({ id: "ap-job", execution_mode: "job", job_name: "explore-v2" });
    expect(payload).not.toHaveProperty("assignee_id");
  });
});
