import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { describe, expect, it } from "vitest";
import plugin from "./index.js";
import { prepareXWorkmateArtifacts } from "./src/exportArtifacts.js";

type GatewayMethodHandler = Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1];

describe("plugin registration", () => {
  it("declares registered agent tools in the manifest contract", () => {
    const manifest = JSON.parse(fs.readFileSync("openclaw.plugin.json", "utf8")) as {
      contracts?: { tools?: string[]; sessionScopedTools?: string[] };
      configSchema?: { properties?: Record<string, unknown> };
    };

    expect(manifest.contracts?.tools).toContain("openclaw_multi_session_artifacts");
    expect(manifest.contracts?.sessionScopedTools).toContain("openclaw_multi_session_artifacts");
    expect(manifest.configSchema?.properties?.artifactRefSigningSecret).toBeTruthy();
  });

  it("registers the xworkmate artifact gateway methods and optional tool", () => {
    const methods: Array<{ method: string; handler: GatewayMethodHandler }> = [];
    const tools: Array<{ tool: unknown; options: unknown }> = [];
    const api = {
      config: {},
      pluginConfig: {},
      registerGatewayMethod: (method: string, handler: GatewayMethodHandler) => {
        methods.push({ method, handler });
      },
      registerTool: (tool: unknown, options: unknown) => {
        tools.push({ tool, options });
      },
    } as unknown as OpenClawPluginApi;

    plugin.register(api);

    expect(methods.map((entry) => entry.method)).toEqual([
      "xworkmate.artifacts.prepare",
      "xworkmate.artifacts.export",
      "xworkmate.artifacts.list",
      "xworkmate.artifacts.read",
    ]);
    expect(methods.every((entry) => typeof entry.handler === "function")).toBe(true);
    expect(tools).toHaveLength(1);
    expect(tools[0]?.options).toMatchObject({
      names: ["openclaw_multi_session_artifacts"],
      optional: true,
    });
  });

  it("does not invent default session or run ids for the optional agent tool", async () => {
    const tools: Array<{ tool: unknown; options: unknown }> = [];
    const api = {
      config: {},
      pluginConfig: { workspaceDir: path.join(os.tmpdir(), "openclaw-multi-session-tool-test") },
      registerGatewayMethod: () => undefined,
      registerTool: (tool: unknown, options: unknown) => {
        tools.push({ tool, options });
      },
    } as unknown as OpenClawPluginApi;

    plugin.register(api);

    const factory = tools[0]?.tool as (ctx: Record<string, unknown>) => {
      parameters: { properties?: Record<string, unknown> };
      execute: (id: string, params: Record<string, unknown>) => Promise<unknown>;
    };
    const tool = factory({});

    expect(tool.parameters.properties?.sessionKey).toBeUndefined();
    expect(tool.parameters.properties?.runId).toBeUndefined();
    expect(tool.parameters.properties?.workspaceDir).toBeUndefined();
    await expect(tool.execute("call-1", { action: "list" })).rejects.toThrow("sessionKey required");
    await expect(factory({ sessionKey: "thread-main" }).execute("call-2", { action: "list" })).rejects.toThrow(
      "runId required",
    );
  });

  it("uses host context scope for the optional agent tool", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "tmp-openclaw-multi-session-tool-"));
    const current = await prepareXWorkmateArtifacts({
      params: { sessionKey: "thread-main", runId: "turn-1" },
      pluginConfig: { workspaceDir: root },
    });
    const other = await prepareXWorkmateArtifacts({
      params: { sessionKey: "thread-main", runId: "turn-2" },
      pluginConfig: { workspaceDir: root },
    });
    await fs.promises.writeFile(path.join(current.artifactDirectory, "current.txt"), "current");
    await fs.promises.writeFile(path.join(other.artifactDirectory, "other.txt"), "other");
    await fs.promises.writeFile(path.join(root, "global.txt"), "global");

    const tools: Array<{ tool: unknown; options: unknown }> = [];
    const api = {
      config: {},
      pluginConfig: {},
      registerGatewayMethod: () => undefined,
      registerTool: (tool: unknown, options: unknown) => {
        tools.push({ tool, options });
      },
    } as unknown as OpenClawPluginApi;

    plugin.register(api);

    const factory = tools[0]?.tool as (ctx: Record<string, unknown>) => {
      execute: (id: string, params: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
    };
    const tool = factory({ sessionKey: "thread-main", runId: "turn-1", workspaceDir: root });
    const result = await tool.execute("call-1", {
      action: "list",
      sessionKey: "thread-other",
      runId: "turn-2",
      workspaceDir: "/",
    });

    expect(result.content[0]?.text).toContain("current.txt");
    expect(result.content[0]?.text).not.toContain("other.txt");
    expect(result.content[0]?.text).not.toContain("global.txt");
  });
});
