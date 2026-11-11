import { useState } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { SettingsUndoProvider, useSettingsUndo } from "./SettingsUndo";
import { useTheme } from "../../hooks/useTheme";

function Preferences({
  save = async () => undefined,
  undo = () => true,
}: {
  save?: () => Promise<void>;
  undo?: () => boolean;
}) {
  const history = useSettingsUndo();
  const [value, setValue] = useState(0);
  const change = () =>
    history?.record(async () => {
      await save();
      setValue((previous) => previous + 1);
      return () => {
        if (!undo()) return false;
        setValue((previous) => previous - 1);
        return true;
      };
    });
  return (
    <>
      <button onClick={change}>Change</button>
      <button
        onClick={() => {
          change();
          change();
        }}
      >
        Change twice
      </button>
      <output>{value}</output>
      <input aria-label="Text" />
      <div contentEditable aria-label="Editor" />
    </>
  );
}

function Surface({ children }: { children: React.ReactNode }) {
  return (
    <SettingsUndoProvider>
      <div role="dialog" data-app-modal>
        {children}
      </div>
    </SettingsUndoProvider>
  );
}

describe("settings undo", () => {
  it("undoes saves from a single gesture together", async () => {
    await using screen = await render(
      <Surface>
        <Preferences />
      </Surface>,
    );
    await screen.getByRole("button", { name: "Change twice" }).click();
    await expect.element(screen.getByRole("status")).toHaveTextContent("2");
    await userEvent.keyboard(
      navigator.platform.includes("Mac") ? "{Meta>}z{/Meta}" : "{Control>}z{/Control}",
    );
    await expect.element(screen.getByRole("status")).toHaveTextContent("0");
  });
  it.each(["MacIntel", "Win32", "Linux x86_64"])(
    "undoes changes in order on %s without stealing text editing",
    async (platform) => {
      using _platform = vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
      await using screen = await render(
        <Surface>
          <Preferences />
        </Surface>,
      );
      const button = screen.getByRole("button", { name: "Change" });
      await button.click();
      await button.click();
      await expect.element(screen.getByRole("status")).toHaveTextContent("2");
      const modifier = platform === "MacIntel" ? { metaKey: true } : { ctrlKey: true };
      const press = (target: Element, extra = {}) => {
        const event = new KeyboardEvent("keydown", {
          key: "z",
          bubbles: true,
          cancelable: true,
          ...modifier,
          ...extra,
        });
        target.dispatchEvent(event);
        return event.defaultPrevented;
      };
      expect(press(screen.getByRole("textbox", { name: "Text" }).element())).toBe(false);
      expect(press(screen.getByLabelText("Editor").element())).toBe(false);
      expect(press(button.element(), { shiftKey: true })).toBe(false);
      expect(press(button.element(), { altKey: true })).toBe(false);
      expect(press(button.element(), { isComposing: true })).toBe(false);
      expect(press(button.element())).toBe(true);
      expect(press(button.element(), { repeat: true })).toBe(true);
      await expect.element(screen.getByRole("status")).toHaveTextContent("1");
      expect(press(button.element())).toBe(true);
      await expect.element(screen.getByRole("status")).toHaveTextContent("0");
      expect(press(button.element())).toBe(false);
    },
  );

  it("waits for pending saves before undoing, including an immediate second undo", async () => {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const undo = vi.fn(() => true);
    await using screen = await render(
      <Surface>
        <Preferences save={() => pending} undo={undo} />
      </Surface>,
    );
    const button = screen.getByRole("button", { name: "Change" });
    await button.click();
    await button.click();
    const event = () =>
      new KeyboardEvent("keydown", {
        key: "z",
        bubbles: true,
        cancelable: true,
        [navigator.platform.includes("Mac") ? "metaKey" : "ctrlKey"]: true,
      });
    button.element().dispatchEvent(event());
    button.element().dispatchEvent(event());
    finish();
    await vi.waitFor(() => expect(undo).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(screen.getByRole("status").element().textContent).toBe("0"));
  });

  it("retains a failed undo and prevents queued undo from skipping past it", async () => {
    const undo = vi.fn(() => true).mockReturnValueOnce(false);
    await using screen = await render(
      <Surface>
        <Preferences undo={undo} />
      </Surface>,
    );
    const button = screen.getByRole("button", { name: "Change" });
    await button.click();
    await button.click();
    await expect.element(screen.getByRole("status")).toHaveTextContent("2");
    const press = () =>
      button.element().dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "z",
          bubbles: true,
          cancelable: true,
          [navigator.platform.includes("Mac") ? "metaKey" : "ctrlKey"]: true,
        }),
      );
    press();
    press();
    await vi.waitFor(() => expect(undo).toHaveBeenCalledOnce());
    expect(screen.getByRole("status").element().textContent).toBe("2");
    press();
    await expect.element(screen.getByRole("status")).toHaveTextContent("1");
    press();
    await expect.element(screen.getByRole("status")).toHaveTextContent("0");
  });

  it("keeps native text undo and clears preference history when its scope changes", async () => {
    const view = (scope: string) => (
      <Surface key={scope}>
        <Preferences />
      </Surface>
    );
    await using screen = await render(view("laptop"));
    await screen.getByRole("button", { name: "Change" }).click();
    await expect.element(screen.getByRole("status")).toHaveTextContent("1");
    await screen.getByRole("textbox", { name: "Text" }).click();
    await userEvent.keyboard("example");
    const shortcut = navigator.platform.includes("Mac")
      ? "{Meta>}z{/Meta}"
      : "{Control>}z{/Control}";
    await userEvent.keyboard(shortcut);
    await expect.element(screen.getByRole("textbox", { name: "Text" })).not.toHaveValue("example");
    expect(screen.getByRole("status").element().textContent).toBe("1");
    await screen.rerender(view("server"));
    const button = screen.getByRole("button", { name: "Change" });
    const event = new KeyboardEvent("keydown", {
      key: "z",
      bubbles: true,
      cancelable: true,
      [navigator.platform.includes("Mac") ? "metaKey" : "ctrlKey"]: true,
    });
    button.element().dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it("restores the saved appearance mode", async () => {
    function Appearance() {
      const { appearanceMode, setAppearanceMode } = useTheme();
      return (
        <button onClick={() => setAppearanceMode(appearanceMode === "dark" ? "light" : "dark")}>
          {appearanceMode}
        </button>
      );
    }
    await using screen = await render(
      <Surface>
        <Appearance />
      </Surface>,
    );
    const button = screen.getByRole("button");
    const before = button.element().textContent;
    await button.click();
    const shortcut = navigator.platform.includes("Mac")
      ? "{Meta>}z{/Meta}"
      : "{Control>}z{/Control}";
    await userEvent.keyboard(shortcut);
    await expect.element(button).toHaveTextContent(before!);
  });
});
