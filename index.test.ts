import fs from "node:fs";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { describe, expect, it } from "vitest";
import plugin from "./index.js";

type GatewayMethodHandler = Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1];

describe("plugin registration", () => {
  it("declares registered agent tools in the manifest contract", () => {
    const manifest = JSON.parse(fs.readFileSync("openclaw.plugin.json", "utf8")) as {
      contracts?: { tools?: string[] };
      configSchema?: { properties?: Record<string, unknown> };
    };

    expect(manifest.contracts?.tools).toContain("xworkmate_artifacts");
    expect(manifest.configSchema?.properties?.artifactRefSigningSecret).toBeTruthy();
  });

  it("registers the xworkmate artifact export gateway method", () => {
    const methods: Array<{ method: string; handler: GatewayMethodHandler }> = [];
    const tools: unknown[] = [];
    const api = {
      config: {},
      pluginConfig: {},
      registerGatewayMethod: (method: string, handler: GatewayMethodHandler) => {
        methods.push({ method, handler });
      },
      registerTool: (tool: unknown) => {
        tools.push(tool);
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
  });
});
