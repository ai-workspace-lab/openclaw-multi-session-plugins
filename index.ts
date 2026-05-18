import type {
  AnyAgentTool,
  GatewayRequestHandlerOptions,
  OpenClawPluginApi,
} from "openclaw/plugin-sdk/core";
import {
  exportXWorkmateArtifacts,
  prepareXWorkmateArtifacts,
  readXWorkmateArtifact,
} from "./src/exportArtifacts.js";
import { runXWorkmateBridgeAgents } from "./src/bridgeAgents.js";

type XWorkmateToolContext = {
  config?: unknown;
  workspaceDir?: string;
  sessionKey?: string;
  runId?: string;
  sessionScope?: {
    sessionKey?: string;
    runId?: string;
    workspaceDir?: string;
  };
};

const plugin = {
  id: "openclaw-multi-session-plugins",
  name: "openclaw-multi-session-plugins",
  description: "OpenClaw logical isolation support for multi-session plugin runtimes and scoped XWorkmate artifacts.",
  register,
};

export default plugin;

function register(api: OpenClawPluginApi) {
  api.registerGatewayMethod("xworkmate.artifacts.prepare", async (opts: GatewayRequestHandlerOptions) => {
    try {
      const payload = await prepareXWorkmateArtifacts({
        params: opts.params,
        config: api.config,
        pluginConfig: api.pluginConfig,
      });
      opts.respond(true, payload, undefined);
    } catch (error) {
      opts.respond(false, undefined, {
        code: "INVALID_REQUEST",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });
  api.registerGatewayMethod("xworkmate.artifacts.export", async (opts: GatewayRequestHandlerOptions) => {
    try {
      const payload = await exportXWorkmateArtifacts({
        params: opts.params,
        config: api.config,
        pluginConfig: api.pluginConfig,
      });
      opts.respond(true, payload, undefined);
    } catch (error) {
      opts.respond(false, undefined, {
        code: "INVALID_REQUEST",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });
  api.registerGatewayMethod("xworkmate.artifacts.list", async (opts: GatewayRequestHandlerOptions) => {
    try {
      const payload = await exportXWorkmateArtifacts({
        params: { ...opts.params, includeContent: false },
        config: api.config,
        pluginConfig: api.pluginConfig,
      });
      opts.respond(true, payload, undefined);
    } catch (error) {
      opts.respond(false, undefined, {
        code: "INVALID_REQUEST",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });
  api.registerGatewayMethod("xworkmate.artifacts.read", async (opts: GatewayRequestHandlerOptions) => {
    try {
      const payload = await readXWorkmateArtifact({
        params: opts.params,
        config: api.config,
        pluginConfig: api.pluginConfig,
      });
      opts.respond(true, payload, undefined);
    } catch (error) {
      opts.respond(false, undefined, {
        code: "INVALID_REQUEST",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });
  api.registerGatewayMethod("xworkmate.agents.run", async (opts: GatewayRequestHandlerOptions) => {
    try {
      const payload = await runXWorkmateBridgeAgents({
        params: opts.params,
        config: api.config,
        pluginConfig: api.pluginConfig,
      });
      opts.respond(true, payload, undefined);
    } catch (error) {
      opts.respond(false, undefined, {
        code: "INVALID_REQUEST",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });
  api.registerTool((ctx) => createXWorkmateArtifactsTool(api, ctx), {
    names: ["openclaw_multi_session_artifacts"],
    optional: true,
  });
  api.registerTool((ctx) => createXWorkmateAgentsTool(api, ctx), {
    names: ["openclaw_multi_session_agents"],
    optional: true,
  });
}

function createXWorkmateArtifactsTool(
  api: OpenClawPluginApi,
  ctx: XWorkmateToolContext,
): AnyAgentTool {
  return {
    name: "openclaw_multi_session_artifacts",
    label: "openclaw-multi-session-plugins",
    description:
      "List generated artifacts in the current OpenClaw workspace or read one small artifact as base64 for XWorkmate.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        action: {
          type: "string",
          enum: ["list", "read"],
          description: "Use list to show workspace artifacts, or read to return one small file.",
        },
        relativePath: {
          type: "string",
          description: "Artifact path relative to artifactScope. Required for action=read without artifactRef.",
        },
        artifactScope: {
          type: "string",
          description: "Task artifact scope returned by prepare/export, for example tasks/<session>/<run>.",
        },
        artifactRef: {
          type: "string",
          description: "Plugin-signed artifact reference returned by export/list. Bound to the issuing task scope.",
        },
        sinceUnixMs: {
          type: "number",
          description: "Only list files changed at or after this Unix timestamp in milliseconds.",
        },
        maxFiles: {
          type: "number",
          description: "Maximum number of files to list.",
        },
        maxInlineBytes: {
          type: "number",
          description: "Maximum bytes to inline when reading an artifact.",
        },
      },
      required: ["action"],
    },
    async execute(_id: string, params: Record<string, unknown>) {
      const action = typeof params.action === "string" ? params.action : "";
      const sessionKey = ctx.sessionScope?.sessionKey || ctx.sessionKey;
      const runId = ctx.sessionScope?.runId || ctx.runId || "";
      const workspaceDir = ctx.sessionScope?.workspaceDir || ctx.workspaceDir;
      if (!sessionKey) {
        throw new Error("sessionKey required");
      }
      if (!runId) {
        throw new Error("runId required");
      }
      const {
        sessionKey: _ignoredSessionKey,
        runId: _ignoredRunId,
        workspaceDir: _ignoredWorkspaceDir,
        ...operationParams
      } = params;
      const baseParams = {
        ...operationParams,
        sessionKey,
        runId,
        ...(workspaceDir ? { workspaceDir } : {}),
      };
      if (action === "list") {
        const payload = await exportXWorkmateArtifacts({
          params: { ...baseParams, includeContent: false },
          config: ctx.config ?? api.config,
          pluginConfig: api.pluginConfig,
        });
        return { content: [{ type: "text", text: payload.manifestMarkdown }], details: {} };
      }
      if (action === "read") {
        const payload = await readXWorkmateArtifact({
          params: baseParams,
          config: ctx.config ?? api.config,
          pluginConfig: api.pluginConfig,
        });
        const artifact = payload.artifacts[0];
        const text = artifact
          ? [
              payload.manifestMarkdown,
              "",
              artifact.content
                ? `Base64 content for \`${artifact.relativePath}\`:\n\n\`\`\`base64\n${artifact.content}\n\`\`\``
                : `\`${artifact.relativePath}\` is larger than maxInlineBytes; use the workspace path to download it directly.`,
            ].join("\n")
          : payload.manifestMarkdown;
        return { content: [{ type: "text", text }], details: {} };
      }
      throw new Error("action must be list or read");
    },
  } as unknown as AnyAgentTool;
}

function createXWorkmateAgentsTool(
  api: OpenClawPluginApi,
  ctx: XWorkmateToolContext,
): AnyAgentTool {
  return {
    name: "openclaw_multi_session_agents",
    label: "XWorkmate multi-agent bridge",
    description:
      "Ask XWorkmate Bridge to coordinate multiple configured agents, then save the result into the current task artifact scope.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        taskPrompt: {
          type: "string",
          description: "Overall multi-agent task prompt.",
        },
        mode: {
          type: "string",
          enum: ["sequence", "parallel", "race", "conversation"],
          description: "Multi-agent orchestration mode.",
        },
        steps: {
          type: "array",
          description: "Agent steps. Each item needs providerId and prompt.",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              providerId: { type: "string" },
              prompt: { type: "string" },
              outputAs: { type: "string" },
              timeoutMs: { type: "number" },
            },
            required: ["providerId", "prompt"],
          },
        },
        participants: {
          type: "array",
          description: "Conversation participants by providerId.",
          items: { type: "string" },
        },
        maxTurns: {
          type: "number",
          description: "Maximum turns for conversation mode.",
        },
        stopConditions: {
          type: "array",
          description: "Text markers that stop conversation mode.",
          items: { type: "string" },
        },
        timeoutMs: {
          type: "number",
          description: "Overall bridge request timeout.",
        },
      },
      required: ["taskPrompt"],
    },
    async execute(_id: string, params: Record<string, unknown>) {
      const sessionKey = ctx.sessionScope?.sessionKey || ctx.sessionKey;
      const runId = ctx.sessionScope?.runId || ctx.runId || "";
      const workspaceDir = ctx.sessionScope?.workspaceDir || ctx.workspaceDir;
      if (!sessionKey) {
        throw new Error("sessionKey required");
      }
      if (!runId) {
        throw new Error("runId required");
      }
      const {
        sessionKey: _ignoredSessionKey,
        runId: _ignoredRunId,
        workspaceDir: _ignoredWorkspaceDir,
        ...operationParams
      } = params;
      const payload = await runXWorkmateBridgeAgents({
        params: {
          ...operationParams,
          sessionKey,
          runId,
          ...(workspaceDir ? { workspaceDir } : {}),
        },
        config: ctx.config ?? api.config,
        pluginConfig: api.pluginConfig,
      });
      const summary = typeof payload.bridgeResult.summary === "string"
        ? payload.bridgeResult.summary
        : typeof payload.bridgeResult.output === "string"
          ? payload.bridgeResult.output
          : "Multi-agent run completed.";
      return {
        content: [{ type: "text", text: [summary, "", payload.manifestMarkdown].join("\n") }],
        details: { artifacts: payload.artifacts, bridgeResult: payload.bridgeResult },
      };
    },
  } as unknown as AnyAgentTool;
}
