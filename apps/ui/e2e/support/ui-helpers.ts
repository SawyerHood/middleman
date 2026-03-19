import { expect, type Page } from "@playwright/test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

export async function createManager(page: Page, managerName: string): Promise<void> {
  await page.getByRole("button", { name: "Add manager" }).first().click();

  const dialog = page.getByRole("dialog", { name: "Create manager" });
  await expect(dialog).toBeVisible();

  await dialog.getByLabel("Name").fill(managerName);
  await dialog.getByLabel("Working directory").fill(REPO_ROOT);
  await dialog.getByRole("button", { name: "Create manager" }).click();

  await expect(dialog).toBeHidden();
}

export async function sendChatMessage(page: Page, text: string): Promise<void> {
  await page.locator("textarea").fill(text);
  await page.getByLabel("Send message").click();
}

export async function attachTextFile(page: Page, fileName: string, text: string): Promise<void> {
  await page.locator('input[aria-label="Attach files"]').setInputFiles({
    name: fileName,
    mimeType: "text/markdown",
    buffer: Buffer.from(text, "utf8"),
  });
}
