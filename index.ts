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

type XWorkmateToolContext = {
  config?: unknown;
  workspaceDir?: string;
  sessionKey?: string;
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
  api.registerTool((ctx) => createXWorkmateArtifactsTool(api, ctx), {
    names: ["openclaw_multi_session_artifacts"],
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
          description: "Plugin-signed artifact reference returned by export/list. Required for workspace-latest reads.",
        },
        sessionKey: {
          type: "string",
          description: "OpenClaw session key supplied by the host or bridge runtime.",
        },
        runId: {
          type: "string",
          description: "OpenClaw run id supplied by the host or bridge runtime.",
        },
        workspaceDir: {
          type: "string",
          description: "OpenClaw workspace directory supplied by the host or bridge runtime.",
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
      const sessionKey = typeof params.sessionKey === "string" ? params.sessionKey : ctx.sessionKey;
      const runId = typeof params.runId === "string" ? params.runId : "";
      const workspaceDir = typeof params.workspaceDir === "string" ? params.workspaceDir : ctx.workspaceDir;
      if (!sessionKey) {
        throw new Error("sessionKey required");
      }
      if (!runId) {
        throw new Error("runId required");
      }
      const baseParams = {
        ...params,
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
