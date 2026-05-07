import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { describe, expect, it } from "vitest";
import plugin from "./index.js";

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
      execute: (id: string, params: Record<string, unknown>) => Promise<unknown>;
    };
    const tool = factory({});

    await expect(tool.execute("call-1", { action: "list", runId: "turn-1" })).rejects.toThrow("sessionKey required");
    await expect(tool.execute("call-2", { action: "list", sessionKey: "thread-main" })).rejects.toThrow(
      "runId required",
    );
  });
});
