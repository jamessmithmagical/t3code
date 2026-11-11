import { expect } from "e2e";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";

import { test, WEB } from "./t3.ts";

test("Undo restores a saved settings preference", WEB, async ({ t3, app, screen, browser }) => {
  await browser.addInitScript((defaults) => {
    const key = "t3code:client-settings:v1";
    if (!localStorage.getItem(key))
      localStorage.setItem(
        key,
        JSON.stringify({
          ...defaults,
          onboardingCompletedAt: "2026-11-11T00:00:00.000Z",
        }),
      );
  }, DEFAULT_CLIENT_SETTINGS);
  await t3.project("settings-undo-demo");
  await t3.open();
  await expect(screen.getByRole("button", "Add project").first()).toBeVisible({ timeout: 120_000 });
  await app.open("/settings/diffs");
  const preference = screen.getByRole("switch", "Hide whitespace changes by default");
  const before = DEFAULT_CLIENT_SETTINGS.diffIgnoreWhitespace;
  await expect(preference).toBeChecked({ checked: before });
  await preference.tap();
  await expect(preference).toBeChecked({ checked: !before });
  await app.screenshot("preference-changed");
  await browser.keyboard.press("ControlOrMeta+z");
  await expect(preference).toBeChecked({ checked: before });
  await app.screenshot("after-undo");
  await browser.reload();
  await expect(preference).toBeChecked({ checked: before });
  await app.screenshot("undo-persisted");
  await app.open("/settings/worktrees");
  const remoteBase = screen.getByRole("switch", "Start new worktrees from remote by default");
  await expect(remoteBase).toBeChecked();
  await remoteBase.tap();
  await expect(remoteBase).toBeChecked({ checked: false });
  await browser.keyboard.press("ControlOrMeta+z");
  await expect(remoteBase).toBeChecked();
  await browser.reload();
  await expect(remoteBase).toBeChecked();
});
