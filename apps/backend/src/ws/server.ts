import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { WebSocketServer } from "ws";
import type { IntegrationRegistryService } from "../integrations/registry.js";
import type { ServerEvent } from "@middleman/protocol";
import type { SwarmManager } from "../swarm/swarm-manager.js";
import { applyCorsHeaders, resolveReadFileContentType, resolveRequestUrl, sendJson } from "./http-utils.js";
import { createAgentHttpRoutes } from "./routes/agent-routes.js";
import { createFileRoutes } from "./routes/file-routes.js";
import { createHealthRoutes } from "./routes/health-routes.js";
import type { HttpRoute } from "./routes/http-route.js";
import { createIntegrationRoutes } from "./routes/integration-routes.js";
import { createSchedulerRoutes } from "./routes/scheduler-routes.js";
import { createSettingsRoutes, type SettingsRouteBundle } from "./routes/settings-routes.js";
import { createEscalationHttpRoutes } from "./routes/escalation-routes.js";
import { createTranscriptionRoutes } from "./routes/transcription-routes.js";
import { WsHandler } from "./ws-handler.js";

export class SwarmWebSocketServer {
  private readonly swarmManager: SwarmManager;
  private readonly host: string;
  private readonly port: number;
  private readonly integrationRegistry: IntegrationRegistryService | null;
  private readonly uiDir: string;
  private uiDirAvailable = false;

  private httpServer: HttpServer | null = null;
  private wss: WebSocketServer | null = null;

  private readonly wsHandler: WsHandler;
  private readonly settingsRoutes: SettingsRouteBundle;
  private readonly httpRoutes: HttpRoute[];

  private readonly onConversationMessage = (event: ServerEvent): void => {
    if (event.type !== "conversation_message") return;
    this.wsHandler.broadcastToSubscribed(event);
  };

  private readonly onConversationEscalation = (event: ServerEvent): void => {
    if (event.type !== "conversation_escalation") return;
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

  private readonly onSlackStatus = (event: ServerEvent): void => {
    if (event.type !== "slack_status") return;
    this.wsHandler.broadcastToSubscribed(event);
  };

  private readonly onTelegramStatus = (event: ServerEvent): void => {
    if (event.type !== "telegram_status") return;
    this.wsHandler.broadcastToSubscribed(event);
  };

  private readonly onEscalationCreated = (event: ServerEvent): void => {
    if (event.type !== "escalation_created") return;
    this.wsHandler.broadcastToSubscribed(event);
  };

  private readonly onEscalationUpdated = (event: ServerEvent): void => {
    if (event.type !== "escalation_updated") return;
    this.wsHandler.broadcastToSubscribed(event);
  };

  private readonly onEscalationsDeleted = (event: ServerEvent): void => {
    if (event.type !== "escalations_deleted") return;
    this.wsHandler.broadcastToSubscribed(event);
  };

  constructor(options: {
    swarmManager: SwarmManager;
    host: string;
    port: number;
    allowNonManagerSubscriptions: boolean;
    integrationRegistry?: IntegrationRegistryService;
    uiDir?: string;
  }) {
    this.swarmManager = options.swarmManager;
    this.host = options.host;
    this.port = options.port;
    this.integrationRegistry = options.integrationRegistry ?? null;
    this.uiDir = options.uiDir ?? this.swarmManager.getConfig().paths.uiDir;

    this.wsHandler = new WsHandler({
      swarmManager: this.swarmManager,
      integrationRegistry: this.integrationRegistry,
      allowNonManagerSubscriptions: options.allowNonManagerSubscriptions
    });

    this.settingsRoutes = createSettingsRoutes({ swarmManager: this.swarmManager });
    this.httpRoutes = [
      ...createHealthRoutes({
        resolveRepoRoot: () => this.swarmManager.getConfig().paths.projectRoot
      }),
      ...createFileRoutes({ swarmManager: this.swarmManager }),
      ...createTranscriptionRoutes({ swarmManager: this.swarmManager }),
      ...createSchedulerRoutes({ swarmManager: this.swarmManager }),
      ...createAgentHttpRoutes({ swarmManager: this.swarmManager }),
      ...createEscalationHttpRoutes({ swarmManager: this.swarmManager }),
      ...this.settingsRoutes.routes,
      ...createIntegrationRoutes({
        swarmManager: this.swarmManager,
        integrationRegistry: this.integrationRegistry
      })
    ];
  }

  async start(): Promise<void> {
    if (this.httpServer || this.wss) {
      return;
    }

    this.uiDirAvailable = await isDirectory(this.uiDir);

    const httpServer = createServer((request, response) => {
      void this.handleHttpRequest(request, response);
    });
    const wss = new WebSocketServer({
      server: httpServer
    });

    this.httpServer = httpServer;
    this.wss = wss;

    this.wsHandler.attach(wss);

    await new Promise<void>((resolve, reject) => {
      const onListening = (): void => {
        cleanup();
        resolve();
      };

      const onError = (error: Error): void => {
        cleanup();
        reject(error);
      };

      const cleanup = (): void => {
        httpServer.off("listening", onListening);
        httpServer.off("error", onError);
      };

      httpServer.on("listening", onListening);
      httpServer.on("error", onError);
      httpServer.listen(this.port, this.host);
    });

    this.swarmManager.on("conversation_message", this.onConversationMessage);
    this.swarmManager.on("conversation_escalation", this.onConversationEscalation);
    this.swarmManager.on("conversation_log", this.onConversationLog);
    this.swarmManager.on("agent_message", this.onAgentMessage);
    this.swarmManager.on("agent_tool_call", this.onAgentToolCall);
    this.swarmManager.on("conversation_reset", this.onConversationReset);
    this.swarmManager.on("agent_status", this.onAgentStatus);
    this.swarmManager.on("agents_snapshot", this.onAgentsSnapshot);
    this.swarmManager.on("escalation_created", this.onEscalationCreated);
    this.swarmManager.on("escalation_updated", this.onEscalationUpdated);
    this.swarmManager.on("escalations_deleted", this.onEscalationsDeleted);
    this.integrationRegistry?.on("slack_status", this.onSlackStatus);
    this.integrationRegistry?.on("telegram_status", this.onTelegramStatus);
  }

  async stop(): Promise<void> {
    this.swarmManager.off("conversation_message", this.onConversationMessage);
    this.swarmManager.off("conversation_escalation", this.onConversationEscalation);
    this.swarmManager.off("conversation_log", this.onConversationLog);
    this.swarmManager.off("agent_message", this.onAgentMessage);
    this.swarmManager.off("agent_tool_call", this.onAgentToolCall);
    this.swarmManager.off("conversation_reset", this.onConversationReset);
    this.swarmManager.off("agent_status", this.onAgentStatus);
    this.swarmManager.off("agents_snapshot", this.onAgentsSnapshot);
    this.swarmManager.off("escalation_created", this.onEscalationCreated);
    this.swarmManager.off("escalation_updated", this.onEscalationUpdated);
    this.swarmManager.off("escalations_deleted", this.onEscalationsDeleted);
    this.integrationRegistry?.off("slack_status", this.onSlackStatus);
    this.integrationRegistry?.off("telegram_status", this.onTelegramStatus);

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

  private async handleHttpRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const requestUrl = resolveRequestUrl(request, `${this.host}:${this.port}`);
    const route = this.httpRoutes.find((candidate) => candidate.matches(requestUrl.pathname));

    if (!route) {
      if (await this.maybeHandleStaticRequest(request, response, requestUrl)) {
        return;
      }

      response.statusCode = 404;
      response.end("Not Found");
      return;
    }

    try {
      await route.handle(request, response, requestUrl);
    } catch (error) {
      if (response.writableEnded || response.headersSent) {
        return;
      }

      const message = error instanceof Error ? error.message : String(error);
      const statusCode =
        message.includes("must be") ||
        message.includes("Invalid") ||
        message.includes("Missing") ||
        message.includes("too large")
          ? 400
          : 500;

      applyCorsHeaders(request, response, route.methods);
      sendJson(response, statusCode, { error: message });
    }
  }

  private async maybeHandleStaticRequest(
    request: IncomingMessage,
    response: ServerResponse,
    requestUrl: URL
  ): Promise<boolean> {
    if ((request.method !== "GET" && request.method !== "HEAD") || !this.uiDirAvailable) {
      return false;
    }

    if (requestUrl.pathname.startsWith("/api/")) {
      return false;
    }

    const assetPath = await this.resolveStaticAssetPath(requestUrl.pathname);
    if (!assetPath) {
      return false;
    }

    const body = request.method === "HEAD" ? undefined : await readFile(assetPath);
    response.statusCode = 200;
    response.setHeader("Content-Type", resolveReadFileContentType(assetPath));
    response.setHeader("Cache-Control", isUiAssetRoute(requestUrl.pathname) ? "public, max-age=31536000, immutable" : "no-store");
    if (body) {
      response.setHeader("Content-Length", String(body.byteLength));
      response.end(body);
      return true;
    }

    response.end();
    return true;
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
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

async function closeHttpServer(server: HttpServer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}
