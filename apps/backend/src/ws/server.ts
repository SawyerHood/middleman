import { serve } from "@hono/node-server";
import { Hono, type Context } from "hono";
import type { Server as HttpServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { WebSocketServer } from "ws";
import type { ServerEvent } from "@middleman/protocol";
import { getControlPidFilePath } from "../reboot/control-pid.js";
import type { SwarmManager } from "../swarm/swarm-manager.js";
import { resolveReadFileContentType } from "./http-utils.js";
import { type NodeServerEnv } from "./hono-utils.js";
import { createFileRoutes } from "./routes/file-routes.js";
import { createHealthRoutes } from "./routes/health-routes.js";
import { createNotesHttpRoutes } from "./routes/notes-routes.js";
import { createSchedulerRoutes } from "./routes/scheduler-routes.js";
import { createSettingsRoutes, type SettingsRouteBundle } from "./routes/settings-routes.js";
import { WsHandler } from "./ws-handler.js";

export class SwarmWebSocketServer {
  private readonly swarmManager: SwarmManager;
  private readonly host: string;
  private readonly port: number;
  private readonly uiDir: string;
  private uiDirAvailable = false;

  private httpServer: HttpServer | null = null;
  private wss: WebSocketServer | null = null;

  private readonly httpApp: Hono<NodeServerEnv>;
  private readonly wsHandler: WsHandler;
  private readonly settingsRoutes: SettingsRouteBundle;

  private readonly onConversationMessage = (event: ServerEvent): void => {
    if (event.type !== "conversation_message") return;
    this.wsHandler.broadcastToSubscribed(event);
  };

  private readonly onConversationLog = (event: ServerEvent): void => {
    if (event.type !== "conversation_log") return;
    this.wsHandler.broadcastToSubscribed(event);
  };

  private readonly onAgentMessage = (event: ServerEvent): void => {
    if (event.type !== "agent_message") return;
    this.wsHandler.broadcastToSubscribed(event);
  };

  private readonly onAgentToolCall = (event: ServerEvent): void => {
    if (event.type !== "agent_tool_call") return;
    this.wsHandler.broadcastToSubscribed(event);
  };

  private readonly onConversationReset = (event: ServerEvent): void => {
    if (event.type !== "conversation_reset") return;
    this.wsHandler.broadcastToSubscribed(event);
  };

  private readonly onAgentStatus = (event: ServerEvent): void => {
    if (event.type !== "agent_status") return;
    this.wsHandler.broadcastToSubscribed(event);
  };

  private readonly onAgentsSnapshot = (event: ServerEvent): void => {
    if (event.type !== "agents_snapshot") return;
    this.wsHandler.broadcastToSubscribed(event);
  };

  constructor(options: { swarmManager: SwarmManager; host: string; port: number; uiDir?: string }) {
    this.swarmManager = options.swarmManager;
    this.host = options.host;
    this.port = options.port;
    this.uiDir = options.uiDir ?? this.swarmManager.getConfig().paths.uiDir;

    this.wsHandler = new WsHandler({
      swarmManager: this.swarmManager,
    });

    this.settingsRoutes = createSettingsRoutes({ swarmManager: this.swarmManager });
    this.httpApp = this.createHttpApp();
  }

  async start(): Promise<void> {
    if (this.httpServer || this.wss) {
      return;
    }

    this.uiDirAvailable = await isDirectory(this.uiDir);

    const httpServer = await this.startHttpServer();
    const wss = new WebSocketServer({
      server: httpServer,
    });

    this.httpServer = httpServer;
    this.wss = wss;

    this.wsHandler.attach(wss);

    this.swarmManager.on("conversation_message", this.onConversationMessage);
    this.swarmManager.on("conversation_log", this.onConversationLog);
    this.swarmManager.on("agent_message", this.onAgentMessage);
    this.swarmManager.on("agent_tool_call", this.onAgentToolCall);
    this.swarmManager.on("conversation_reset", this.onConversationReset);
    this.swarmManager.on("agent_status", this.onAgentStatus);
    this.swarmManager.on("agents_snapshot", this.onAgentsSnapshot);
  }

  async stop(): Promise<void> {
    this.swarmManager.off("conversation_message", this.onConversationMessage);
    this.swarmManager.off("conversation_log", this.onConversationLog);
    this.swarmManager.off("agent_message", this.onAgentMessage);
    this.swarmManager.off("agent_tool_call", this.onAgentToolCall);
    this.swarmManager.off("conversation_reset", this.onConversationReset);
    this.swarmManager.off("agent_status", this.onAgentStatus);
    this.swarmManager.off("agents_snapshot", this.onAgentsSnapshot);

    const currentWss = this.wss;
    const currentHttpServer = this.httpServer;

    this.wss = null;
    this.httpServer = null;

    this.wsHandler.reset();
    this.settingsRoutes.cancelActiveSettingsAuthLoginFlows();

    if (currentWss) {
      await closeWebSocketServer(currentWss);
    }

    if (currentHttpServer) {
      await closeHttpServer(currentHttpServer);
    }
  }

  private createHttpApp(): Hono<NodeServerEnv> {
    const app = new Hono<NodeServerEnv>();
    app.notFound((c) => c.text("Not Found", 404));
    app.onError((error, c) => this.handleHttpError(error, c));

    app.route(
      "/",
      createHealthRoutes({
        resolveControlPidFile: () =>
          getControlPidFilePath(this.swarmManager.getConfig().paths.runDir),
      }),
    );
    app.route("/", createFileRoutes({ swarmManager: this.swarmManager }));
    app.route("/", createSchedulerRoutes({ swarmManager: this.swarmManager }));
    app.route("/", createNotesHttpRoutes({ swarmManager: this.swarmManager }));
    app.route("/", this.settingsRoutes.app);
    app.on(["GET", "HEAD"], "*", async (c) => this.handleStaticRequest(c));

    return app;
  }

  private async startHttpServer(): Promise<HttpServer> {
    return await new Promise<HttpServer>((resolvePromise, rejectPromise) => {
      let httpServer: HttpServer;

      const onListening = (): void => {
        cleanup();
        resolvePromise(httpServer);
      };

      const onError = (error: Error): void => {
        cleanup();
        rejectPromise(error);
      };

      const cleanup = (): void => {
        httpServer.off("error", onError);
      };

      httpServer = serve(
        {
          fetch: this.httpApp.fetch,
          hostname: this.host,
          port: this.port,
        },
        onListening,
      ) as HttpServer;

      httpServer.on("error", onError);
    });
  }

  private handleHttpError(error: unknown, c: Context<NodeServerEnv>): Response {
    const message = error instanceof Error ? error.message : String(error);
    const statusCode =
      message.includes("must be") ||
      message.includes("Invalid") ||
      message.includes("Missing") ||
      message.includes("too large")
        ? 400
        : 500;

    if (c.req.path.startsWith("/api/")) {
      return c.json({ error: message }, statusCode);
    }

    return c.text(message, statusCode);
  }

  private async handleStaticRequest(c: Context<NodeServerEnv>): Promise<Response> {
    if (!this.uiDirAvailable || c.req.path.startsWith("/api/")) {
      return c.notFound();
    }

    const assetPath = await this.resolveStaticAssetPath(c.req.path);
    if (!assetPath) {
      return c.notFound();
    }

    const headers = new Headers({
      "Cache-Control": isUiAssetRoute(c.req.path)
        ? "public, max-age=31536000, immutable"
        : "no-store",
      "Content-Type": resolveReadFileContentType(assetPath),
    });

    if (c.req.method === "HEAD") {
      return new Response(null, {
        status: 200,
        headers,
      });
    }

    const body = await readFile(assetPath);
    headers.set("Content-Length", String(body.byteLength));

    return new Response(body, {
      status: 200,
      headers,
    });
  }

  private async resolveStaticAssetPath(pathname: string): Promise<string | null> {
    const normalizedPath = pathname === "/" ? "/_shell.html" : pathname;
    const candidateFilePath = this.resolveUiPath(normalizedPath);
    if (candidateFilePath && (await isFile(candidateFilePath))) {
      return candidateFilePath;
    }

    if (extname(pathname).length > 0) {
      return null;
    }

    const shellPath = this.resolveUiPath("/_shell.html");
    if (shellPath && (await isFile(shellPath))) {
      return shellPath;
    }

    return null;
  }

  private resolveUiPath(pathname: string): string | null {
    const relativePath = pathname.replace(/^\/+/, "");
    const uiRoot = resolve(this.uiDir);
    const candidatePath = resolve(uiRoot, relativePath);

    if (candidatePath === uiRoot || candidatePath.startsWith(`${uiRoot}${sep}`)) {
      return candidatePath;
    }

    return null;
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    const fileStats = await stat(path);
    return fileStats.isFile();
  } catch {
    return false;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    const fileStats = await stat(path);
    return fileStats.isDirectory();
  } catch {
    return false;
  }
}

function isUiAssetRoute(pathname: string): boolean {
  return pathname.startsWith("/assets/");
}

async function closeWebSocketServer(server: WebSocketServer): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.close((error) => {
      if (error) {
        rejectPromise(error);
        return;
      }

      resolvePromise();
    });
  });
}

async function closeHttpServer(server: HttpServer): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.close((error) => {
      if (error) {
        rejectPromise(error);
        return;
      }

      resolvePromise();
    });
  });
}
