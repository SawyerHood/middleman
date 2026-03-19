import { expect, test } from "@playwright/test";

import { startMiddlemanStack } from "./support/middleman-stack";

const selectAllShortcut = process.platform === "darwin" ? "Meta+A" : "Control+A";

test("notes view can create, edit, and delete a note", async ({ page }) => {
  const stack = await startMiddlemanStack({ sessions: {} });

  try {
    await page.goto(`${stack.baseUrl}/notes`);
    await expect(page.getByText("No notes yet")).toBeVisible();

    await page.getByRole("button", { name: "New note" }).click();
    const renameInput = page.locator('input[value="Untitled.md"]');
    if ((await renameInput.count()) > 0) {
      await renameInput.first().press("Enter");
    }

    const editor = page.getByLabel("Notes editor");
    await expect(editor).toBeVisible();
    await editor.click();
    await editor.press(selectAllShortcut);
    await page.keyboard.press("Backspace");
    await page.keyboard.type("# Release plan\n\nShipped the browser tests.");

    await expect(page.getByText("Saved")).toBeVisible({ timeout: 15_000 });

    await page.locator('button[title="Untitled.md"]').click({ button: "right" });
    await page.getByText("Delete").click();
    await page.getByRole("button", { name: "Delete note" }).click();

    await expect(page.getByText("No notes yet")).toBeVisible();
  } finally {
    await stack.stop();
  }
});

test("settings changes persist across reloads", async ({ page }) => {
  const stack = await startMiddlemanStack({ sessions: {} });

  try {
    await page.goto(`${stack.baseUrl}/settings`);
    await page.getByRole("combobox").click();
    await page.getByRole("option", { name: /Dark/i }).click();

    await expect(page.locator("html")).toHaveClass(/dark/);
    await expect
      .poll(async () => {
        return await page.evaluate(() => window.localStorage.getItem("middleman-theme"));
      })
      .toBe("dark");

    await page.reload();
    await expect(page.locator("html")).toHaveClass(/dark/);
    await expect
      .poll(async () => {
        return await page.evaluate(() => window.localStorage.getItem("middleman-theme"));
      })
      .toBe("dark");
  } finally {
    await stack.stop();
  }
});
