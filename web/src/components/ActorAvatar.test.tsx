import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ActorAvatar } from "./ActorAvatar";
import type { ActorIdentity } from "../types";

function actor(overrides: Partial<ActorIdentity>): ActorIdentity {
  return { type: "user", id: "u1", name: "Ada", avatarUrl: null, ...overrides };
}

describe("ActorAvatar", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders the local agent logo immediately without gating", () => {
    const { container } = render(<ActorAvatar actor={actor({ type: "agent", name: "Codex" })} />);
    expect(container.querySelector("img")?.getAttribute("src")).toBe("codex-agent-logo.png");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("falls back to initials when there is no avatar URL", () => {
    const { container } = render(<ActorAvatar actor={actor({ avatarUrl: null })} />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toBe("A");
  });

  it("renders a Taskboard attachment avatar immediately", () => {
    const { container } = render(<ActorAvatar actor={actor({ avatarUrl: "api/attachments/abc-123/content" })} />);
    expect(container.querySelector("img")?.getAttribute("src")).toBe("api/attachments/abc-123/content");
  });

  it("gates an external avatar behind a click before it loads", () => {
    const { container } = render(<ActorAvatar actor={actor({ avatarUrl: "https://gravatar.invalid/ada.png" })} />);
    expect(container.querySelector("img")).toBeNull();

    const gate = screen.getByRole("button");
    fireEvent.click(gate);

    const image = container.querySelector("img");
    expect(image?.getAttribute("src")).toBe("https://gravatar.invalid/ada.png");
    expect(image?.getAttribute("referrerPolicy")).toBe("no-referrer");
  });

  it("never offers to load an avatar pointing at a private network destination", () => {
    const { container } = render(<ActorAvatar actor={actor({ avatarUrl: "http://169.254.169.254/latest/meta-data/" })} />);
    expect(container.querySelector("img")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
    expect(container.textContent).toBe("A");
  });
});
