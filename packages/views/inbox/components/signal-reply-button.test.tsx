import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InboxItem } from "@multica/core/types";
import type { SignalReply } from "@multica/core/inbox/smart";

// t(selector, opts) returns the key path plus its interpolation values.
function pathProxy(path: string[] = []): unknown {
  return new Proxy(
    {},
    { get: (_t, key) => (key === "__path" ? path.join(".") : pathProxy([...path, String(key)])) },
  );
}
vi.mock("../../i18n", () => ({
  useT: () => ({
    t: (sel: (p: unknown) => { __path: string }, opts?: Record<string, unknown>) =>
      sel(pathProxy()).__path + (opts ? ` ${JSON.stringify(opts)}` : ""),
  }),
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));
vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "ws" }));
let issue: { identifier: string } | undefined;
vi.mock("@tanstack/react-query", () => ({ useQuery: () => ({ data: issue }) }));
vi.mock("@multica/core/issues/queries", () => ({ issueDetailOptions: () => ({}) }));
type MutateOpts = { onSuccess?: () => void; onError?: (e: unknown) => void };
const post = { mutate: vi.fn(), isPending: false };
vi.mock("@multica/core/inbox/mutations", () => ({ useReplyToSignal: () => post }));

import { SignalReplyButton } from "./signal-reply-button";

const item = {
  id: "item-1",
  type: "signal",
  issue_id: "issue-1",
} as InboxItem;
const reply: SignalReply = { index: 1, label: "Approve: agree", content: "agree", parent_comment_id: "c1" };

describe("SignalReplyButton", () => {
  beforeEach(() => {
    post.mutate.mockReset();
    toast.success.mockReset();
    toast.error.mockReset();
    issue = { identifier: "CTG-123" };
  });

  it("asks for confirmation before posting, naming the reply and the card", () => {
    render(<SignalReplyButton item={item} reply={reply} />);
    fireEvent.click(screen.getByRole("button", { name: /Approve: agree/ }));
    expect(post.mutate).not.toHaveBeenCalled();
    expect(screen.getByRole("alertdialog")).toHaveTextContent(
      'smart.reply.confirm_title_on {"content":"agree","card":"CTG-123"}',
    );
  });

  it("posts the reply by its index and content on confirm, then closes", () => {
    post.mutate.mockImplementation((_vars: unknown, opts: MutateOpts) => opts.onSuccess?.());
    render(<SignalReplyButton item={item} reply={reply} />);
    fireEvent.click(screen.getByRole("button", { name: /Approve: agree/ }));
    fireEvent.click(screen.getByRole("button", { name: "smart.reply.confirm" }));
    expect(post.mutate).toHaveBeenCalledWith({ id: "item-1", index: 1, content: "agree" }, expect.anything());
    expect(toast.success).toHaveBeenCalled();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("cancel posts nothing", () => {
    render(<SignalReplyButton item={item} reply={reply} />);
    fireEvent.click(screen.getByRole("button", { name: /Approve: agree/ }));
    fireEvent.click(screen.getByRole("button", { name: "smart.reply.cancel" }));
    expect(post.mutate).not.toHaveBeenCalled();
  });

  it("keeps the dialog open and shows the server's refusal on failure", () => {
    post.mutate.mockImplementation((_vars: unknown, opts: MutateOpts) =>
      opts.onError?.(new Error("this reply is no longer offered")),
    );
    render(<SignalReplyButton item={item} reply={reply} />);
    fireEvent.click(screen.getByRole("button", { name: /Approve: agree/ }));
    fireEvent.click(screen.getByRole("button", { name: "smart.reply.confirm" }));
    expect(toast.error).toHaveBeenCalledWith("this reply is no longer offered");
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
  });

  it("reads without the card key while the issue loads", () => {
    issue = undefined;
    render(<SignalReplyButton item={item} reply={reply} />);
    fireEvent.click(screen.getByRole("button", { name: /Approve: agree/ }));
    expect(screen.getByRole("alertdialog")).toHaveTextContent('smart.reply.confirm_title {"content":"agree"}');
  });

  it("renders nothing for a signal without an issue", () => {
    const { container } = render(<SignalReplyButton item={{ ...item, issue_id: null }} reply={reply} />);
    expect(container).toBeEmptyDOMElement();
  });
});
