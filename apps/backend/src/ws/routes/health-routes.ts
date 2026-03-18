import { readFile, rm } from "node:fs/promises"
import { Hono } from "hono"
import { RESTART_SIGNAL } from "../../reboot/control-pid.js"
import { createCorsMiddleware, createMethodGuard, type NodeServerEnv } from "../hono-utils.js"

const HEALTH_ENDPOINT_PATH = "/api/health"
const REBOOT_ENDPOINT_PATH = "/api/reboot"
const HEALTH_METHODS = ["GET"] as const
const REBOOT_METHODS = ["POST"] as const

export function createHealthRoutes(options: { resolveControlPidFile: () => string }): Hono<NodeServerEnv> {
  const { resolveControlPidFile } = options
  const app = new Hono<NodeServerEnv>()

  app.use(HEALTH_ENDPOINT_PATH, createCorsMiddleware(HEALTH_METHODS))
  app.use(HEALTH_ENDPOINT_PATH, createMethodGuard(HEALTH_METHODS))
  app.get(HEALTH_ENDPOINT_PATH, (c) => c.json({ ok: true }))

  app.use(REBOOT_ENDPOINT_PATH, createCorsMiddleware(REBOOT_METHODS))
  app.use(REBOOT_ENDPOINT_PATH, createMethodGuard(REBOOT_METHODS))
  app.post(REBOOT_ENDPOINT_PATH, (c) => {
    const rebootTimer = setTimeout(() => {
      void triggerRebootSignal(resolveControlPidFile())
    }, 25)
    rebootTimer.unref()

    return c.json({ ok: true })
  })

  return app
}

async function triggerRebootSignal(pidFile: string): Promise<void> {
  try {
    const daemonPid = await resolveProdDaemonPid(pidFile)
    const targetPid = daemonPid ?? process.pid

    process.kill(targetPid, RESTART_SIGNAL)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[reboot] Failed to send ${RESTART_SIGNAL}: ${message}`)
  }
}

async function resolveProdDaemonPid(pidFile: string): Promise<number | null> {
  return await readRunningPidFromFile(pidFile)
}

async function readRunningPidFromFile(pidFile: string): Promise<number | null> {
  let pidFileContents: string
  try {
    pidFileContents = await readFile(pidFile, "utf8")
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: string }).code === "ENOENT"
    ) {
      return null
    }

    throw error
  }

  const pid = Number.parseInt(pidFileContents.trim(), 10)
  if (!Number.isInteger(pid) || pid <= 0) {
    return null
  }

  try {
    process.kill(pid, 0)
    return pid
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: string }).code === "ESRCH"
    ) {
      await rm(pidFile, { force: true })
    }

    return null
  }
}
