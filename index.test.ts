import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { describe, expect, it } from "vitest";
import register from "./index.js";

type GatewayMethodHandler = Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1];

describe("plugin registration", () => {
  it("registers the xworkmate artifact export gateway method", () => {
    const methods: Array<{ method: string; handler: GatewayMethodHandler }> = [];
    const api = {
      config: {},
      pluginConfig: {},
      registerGatewayMethod: (method: string, handler: GatewayMethodHandler) => {
        methods.push({ method, handler });
      },
    } as unknown as OpenClawPluginApi;

    register(api);

    expect(methods).toHaveLength(1);
    expect(methods[0]?.method).toBe("xworkmate.artifacts.export");
    expect(typeof methods[0]?.handler).toBe("function");
  });
});
