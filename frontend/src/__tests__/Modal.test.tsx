import { fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { describe, expect, it, vi } from "vitest";
import { Modal } from "../components/ui/Modal";

describe("Modal keyboard access", () => {
  it("exposes its title and excludes disabled controls from the focus trap", () => {
    render(<Modal open onClose={vi.fn()} title="Edit rack">
      <input disabled aria-label="Unavailable" />
      <button>Save</button>
      <input disabled aria-label="Also unavailable" />
      <div style={{ display: "none" }}><button>Hidden action</button></div>
    </Modal>);
    expect(screen.getByRole("dialog", { name: "Edit rack" })).toBeInTheDocument();
    const close = screen.getByRole("button", { name: "Close" });
    const save = screen.getByRole("button", { name: "Save" });
    save.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(close).toHaveFocus();
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(save).toHaveFocus();
  });

  it("restores focus to the opener when unmounted", () => {
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();
    const view = render(<Modal open onClose={vi.fn()} title="Details">Details</Modal>);
    view.unmount();
    expect(opener).toHaveFocus();
    opener.remove();
  });
});
