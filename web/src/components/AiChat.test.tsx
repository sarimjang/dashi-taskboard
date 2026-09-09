import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MarkdownMessage } from "./AiChat";

describe("MarkdownMessage img override", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders a Taskboard attachment image immediately, with no click required", () => {
    render(<MarkdownMessage>{"![cover](api/attachments/abc-123/content)"}</MarkdownMessage>);

    expect(document.querySelector("img")?.getAttribute("src")).toBe("api/attachments/abc-123/content");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("gates an external image behind a click before it produces a network request, in an assistant message", () => {
    render(<MarkdownMessage>{"![pixel](https://tracker.invalid/pixel.png)"}</MarkdownMessage>);

    expect(document.querySelector("img")).toBeNull();
    const gate = screen.getByRole("button");

    fireEvent.click(gate);

    expect(document.querySelector("img")?.getAttribute("src")).toBe("https://tracker.invalid/pixel.png");
  });

  it("gates an external image the same way in a user message that carries skillsById", () => {
    render(
      <MarkdownMessage skillsById={new Map()}>
        {"![pixel](https://tracker.invalid/pixel.png)"}
      </MarkdownMessage>,
    );

    expect(document.querySelector("img")).toBeNull();
    expect(screen.getByRole("button")).toBeTruthy();
  });

  it("blocks an image pointing at a loopback or private network destination outright", () => {
    render(<MarkdownMessage>{"![probe](http://169.254.169.254/latest/meta-data/)"}</MarkdownMessage>);

    expect(document.querySelector("img")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByRole("img", { name: /blocked|已阻止/i })).toBeTruthy();
  });
});
