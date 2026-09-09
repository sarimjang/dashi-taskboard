import { describe, expect, it } from "vitest";
import { ganttAssigneeAvatarMarkup } from "./GanttView";

describe("ganttAssigneeAvatarMarkup", () => {
  it("renders the local agent logo for agent assignees, ignoring avatarUrl", () => {
    const markup = ganttAssigneeAvatarMarkup("agent", "https://attacker.invalid/tracker.png", "A");
    expect(markup).toBe(`<img src="codex-agent-logo.png" alt="">`);
  });

  it("auto-loads a Taskboard attachment avatar", () => {
    const markup = ganttAssigneeAvatarMarkup("user", "/api/attachments/abc-123/content", "A");
    expect(markup).toBe(`<img src="/api/attachments/abc-123/content" alt="">`);
  });

  it("does not render an <img> for an external avatar URL", () => {
    const markup = ganttAssigneeAvatarMarkup("user", "https://gravatar.invalid/ada.png", "A");
    expect(markup).not.toContain("<img");
    expect(markup).toBe("<span>A</span>");
  });

  it("does not render an <img> for a private-network avatar URL", () => {
    const markup = ganttAssigneeAvatarMarkup("user", "http://169.254.169.254/latest/meta-data/", "A");
    expect(markup).not.toContain("<img");
    expect(markup).toBe("<span>A</span>");
  });

  it("falls back to the initial when there is no avatar URL", () => {
    const markup = ganttAssigneeAvatarMarkup("user", null, "A");
    expect(markup).toBe("<span>A</span>");
  });

  it("escapes the initial and attachment URL when building markup", () => {
    expect(ganttAssigneeAvatarMarkup("user", null, "<b>")).toBe("<span>&lt;b&gt;</span>");
    expect(ganttAssigneeAvatarMarkup("user", '/api/attachments/"onload=alert(1)/content', "A"))
      .not.toContain('"onload=alert(1)');
  });
});
