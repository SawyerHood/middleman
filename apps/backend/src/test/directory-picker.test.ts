import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { pickDirectory } from "../swarm/directory-picker.js";

describe("pickDirectory", () => {
  it("returns a resolved path from the native picker output", async () => {
    const execFileFn = vi.fn().mockResolvedValue({ stdout: "/tmp/workspace\n" });

    const pickedPath = await pickDirectory({
      platform: "darwin",
      execFileFn,
    });

    expect(pickedPath).toBe(resolve("/tmp/workspace"));
    expect(execFileFn).toHaveBeenCalledWith("osascript", expect.any(Array));
  });

  it("returns null when the picker is cancelled", async () => {
    const canceledError = Object.assign(new Error("User canceled."), {
      code: 1,
      stderr: "User canceled",
    });

    const execFileFn = vi.fn().mockRejectedValue(canceledError);

    const pickedPath = await pickDirectory({
      platform: "darwin",
      execFileFn,
    });

    expect(pickedPath).toBeNull();
  });

  it("falls back to secondary commands when the first picker binary is missing", async () => {
    const missingBinaryError = Object.assign(new Error("Missing binary"), {
      code: "ENOENT",
    });

    const execFileFn = vi
      .fn()
      .mockRejectedValueOnce(missingBinaryError)
      .mockResolvedValueOnce({ stdout: "/tmp/linux-project\n" });

    const pickedPath = await pickDirectory({
      platform: "linux",
      execFileFn,
      defaultPath: "/tmp",
    });

    expect(pickedPath).toBe("/tmp/linux-project");
    expect(execFileFn).toHaveBeenCalledTimes(2);
    expect(execFileFn.mock.calls[0]?.[0]).toBe("zenity");
    expect(execFileFn.mock.calls[1]?.[0]).toBe("kdialog");
  });

  it("throws a clear error when no picker command is available", async () => {
    const missingBinaryError = Object.assign(new Error("Missing binary"), {
      code: "ENOENT",
    });

    const execFileFn = vi
      .fn()
      .mockRejectedValueOnce(missingBinaryError)
      .mockRejectedValueOnce(missingBinaryError);

    await expect(
      pickDirectory({
        platform: "linux",
        execFileFn,
      }),
    ).rejects.toThrow("Directory picker is not supported in this environment.");
  });

  it("throws on unsupported platforms", async () => {
    await expect(
      pickDirectory({
        platform: "freebsd",
      }),
    ).rejects.toThrow('Directory picker is not supported on platform "freebsd".');
  });
});
