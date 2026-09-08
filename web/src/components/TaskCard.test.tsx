import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskCardMedia } from "./TaskCard";

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

describe("TaskCardMedia", () => {
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("renders a Taskboard attachment cover image immediately, with no click required", () => {
    const { container } = render(<TaskCardMedia src="api/attachments/abc-123/content" />);
    expect(container.querySelector("img")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("gates an external cover image behind a click before it loads", () => {
    const { container } = render(<TaskCardMedia src="https://tracker.invalid/pixel.png" />);
    expect(container.querySelector("img")).toBeNull();

    const gate = screen.getByRole("button");
    fireEvent.click(gate);

    expect(container.querySelector("img")?.getAttribute("src")).toBe("https://tracker.invalid/pixel.png");
  });

  it("never offers to load a cover image pointing at a private network destination", () => {
    const { container } = render(<TaskCardMedia src="http://192.168.1.1/probe.png" />);
    expect(container.firstChild).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
