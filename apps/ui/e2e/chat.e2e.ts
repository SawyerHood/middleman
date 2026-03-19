import { expect, test } from "@playwright/test";

import { startMiddlemanStack } from "./support/middleman-stack";
import { attachTextFile, createManager, sendChatMessage } from "./support/ui-helpers";

test("manager creation shows the scripted welcome and first chat response", async ({ page }) => {
  const managerId = "qa-manager";
  const stack = await startMiddlemanStack({
    sessions: {
      [managerId]: {
        turns: [
          {
            match: { index: 1 },
            steps: [
              { type: "status", status: "busy" },
              {
                type: "host_call",
                tool: "speak_to_user",
                args: {
                  text: "Welcome from the scripted manager.",
                },
              },
              { type: "status", status: "idle" },
            ],
          },
          {
            match: { index: 2, textIncludes: "hello" },
            steps: [
              { type: "status", status: "busy" },
              {
                type: "host_call",
                tool: "speak_to_user",
                args: {
                  text: "Scripted response appears in chat.",
                },
              },
              { type: "status", status: "idle" },
            ],
          },
        ],
      },
    },
  });

  try {
    await page.goto(stack.baseUrl);
    await expect(page.getByRole("button", { name: "Add manager" }).first()).toBeVisible();

    await createManager(page, managerId);
    await expect(page.getByText("Welcome from the scripted manager.")).toBeVisible();

    await sendChatMessage(page, "hello manager");
    await expect(page.getByText("Scripted response appears in chat.")).toBeVisible();
  } finally {
    await stack.stop();
  }
});

test("manager can spawn a worker, switch agents, and reload persisted history", async ({
  page,
}) => {
  const managerId = "orchestrator";
  const workerId = "reviewer";
  const stack = await startMiddlemanStack({
    sessions: {
      [managerId]: {
        turns: [
          {
            match: { index: 1 },
            steps: [
              { type: "status", status: "busy" },
              {
                type: "host_call",
                tool: "speak_to_user",
                args: {
                  text: "Manager ready for orchestration.",
                },
              },
              { type: "status", status: "idle" },
            ],
          },
          {
            match: { index: 2, textIncludes: "debug the crash" },
            steps: [
              { type: "status", status: "busy" },
              {
                type: "host_call",
                tool: "spawn_agent",
                args: {
                  agentId: workerId,
                  initialMessage: "Investigate the crash and report back.",
                },
              },
              {
                type: "host_call",
                tool: "speak_to_user",
                args: {
                  text: "Started reviewer on the crash.",
                },
              },
              { type: "status", status: "idle" },
            ],
          },
        ],
      },
      [workerId]: {
        turns: [
          {
            match: { index: 1 },
            steps: [
              { type: "status", status: "busy" },
              {
                type: "message_stream",
                chunks: ["Found the root cause and fixed it."],
              },
              { type: "status", status: "idle" },
            ],
          },
        ],
      },
    },
  });

  try {
    await page.goto(stack.baseUrl);
    await createManager(page, managerId);
    await expect(page.getByText("Manager ready for orchestration.")).toBeVisible();

    await sendChatMessage(page, "Please debug the crash");
    await expect(page.getByText("Started reviewer on the crash.")).toBeVisible();

    await page
      .getByRole("button", { name: `Expand manager ${managerId}`, exact: true })
      .click({ force: true });
    const workerSidebarButton = page.locator(`button[title="${workerId}"]`).first();
    await expect(workerSidebarButton).toBeVisible();
    await workerSidebarButton.click({ force: true });
    await expect(page.getByText("Found the root cause and fixed it.")).toBeVisible();

    await page.reload();
    await expect(page.getByText("Found the root cause and fixed it.")).toBeVisible();

    await page.locator(`button[title="${managerId}"]`).first().click({ force: true });
    await page.getByRole("button", { name: /reviewer.*orchestrator/i }).click({ force: true });
    await expect(page.getByText(/Worker reviewer completed its turn\./)).toBeVisible();
  } finally {
    await stack.stop();
  }
});

test("chat supports sending a message with a file attachment", async ({ page }) => {
  const managerId = "attachments-manager";
  const stack = await startMiddlemanStack({
    sessions: {
      [managerId]: {
        turns: [
          {
            match: { index: 1 },
            steps: [
              {
                type: "host_call",
                tool: "speak_to_user",
                args: {
                  text: "Ready for attachments.",
                },
              },
            ],
          },
          {
            match: { index: 2, textIncludes: "attachment" },
            steps: [
              { type: "status", status: "busy" },
              {
                type: "host_call",
                tool: "speak_to_user",
                args: {
                  text: "Attachment received.",
                },
              },
              { type: "status", status: "idle" },
            ],
          },
        ],
      },
    },
  });

  try {
    await page.goto(stack.baseUrl);
    await createManager(page, managerId);
    await expect(page.getByText("Ready for attachments.")).toBeVisible();

    await attachTextFile(page, "release-notes.md", "# Release notes\n\n- Added E2E coverage\n");
    await expect(page.getByText("release-notes.md")).toBeVisible();

    await sendChatMessage(page, "Here is an attachment");
    await expect(page.getByText("Attachment received.")).toBeVisible();
    await expect(page.getByText("release-notes.md")).toBeVisible();
  } finally {
    await stack.stop();
  }
});
