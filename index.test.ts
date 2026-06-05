import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { describe, expect, it } from "vitest";
import plugin from "./index.js";
import { prepareXWorkmateArtifacts } from "./src/exportArtifacts.js";

type GatewayMethodHandler = Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1];
type GatewayMethodResponse = {
  ok: boolean;
  payload?: Record<string, unknown>;
  error?: { code?: string; message?: string };
};

describe("plugin registration", () => {
  it("declares registered agent tools in the manifest contract", () => {
    const manifest = JSON.parse(fs.readFileSync("openclaw.plugin.json", "utf8")) as {
      contracts?: { tools?: string[]; sessionScopedTools?: string[] };
      configSchema?: { properties?: Record<string, unknown> };
    };

    expect(manifest.contracts?.tools).toContain("openclaw_multi_session_artifacts");
    expect(manifest.contracts?.tools).toContain("openclaw_multi_session_agents");
    expect(manifest.contracts?.sessionScopedTools).toContain("openclaw_multi_session_artifacts");
    expect(manifest.contracts?.sessionScopedTools).toContain("openclaw_multi_session_agents");
    expect(manifest.configSchema?.properties?.artifactRefSigningSecret).toBeTruthy();
    expect(manifest.configSchema?.properties?.bridgeUrl).toBeTruthy();
    expect(manifest.configSchema?.properties?.bridgeToken).toBeTruthy();
  });

  it("registers the xworkmate gateway methods and optional tools", () => {
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
      "xworkmate.artifacts.collect-and-snapshot",
      "xworkmate.artifacts.list",
      "xworkmate.artifacts.read",
      "xworkmate.agents.run",
    ]);
    expect(methods.every((entry) => typeof entry.handler === "function")).toBe(true);
    expect(tools).toHaveLength(2);
    expect(tools[0]?.options).toMatchObject({
      names: ["openclaw_multi_session_artifacts"],
      optional: true,
    });
    expect(tools[1]?.options).toMatchObject({
      names: ["openclaw_multi_session_agents"],
      optional: true,
    });
  });

  it("executes registered gateway methods against the current task scope", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "tmp-openclaw-multi-session-gateway-"));
    const methods = new Map<string, GatewayMethodHandler>();
    const api = {
      config: {},
      pluginConfig: { workspaceDir: root },
      registerGatewayMethod: (method: string, handler: GatewayMethodHandler) => {
        methods.set(method, handler);
      },
      registerTool: () => undefined,
    } as unknown as OpenClawPluginApi;

    plugin.register(api);

    const prepared = await callGatewayMethod(methods, "xworkmate.artifacts.prepare", {
      sessionKey: "thread-main",
      runId: "turn-1",
    });
    expect(prepared.ok).toBe(true);
    expect(prepared.payload?.artifactScope).toBe("tasks/thread-main/turn-1");
    const artifactDirectory = String(prepared.payload?.artifactDirectory);

    const emptyExport = await callGatewayMethod(methods, "xworkmate.artifacts.export", {
      sessionKey: "thread-main",
      runId: "turn-1",
      artifactScope: prepared.payload?.artifactScope,
    });
    expect(emptyExport.ok).toBe(true);
    expect(emptyExport.payload?.artifacts).toEqual([]);
    expect(emptyExport.payload?.warnings).toEqual([]);

    await fs.promises.mkdir(path.join(artifactDirectory, "reports"), { recursive: true });
    await fs.promises.writeFile(path.join(artifactDirectory, "reports", "final.md"), "final");

    const listed = await callGatewayMethod(methods, "xworkmate.artifacts.list", {
      sessionKey: "thread-main",
      runId: "turn-1",
      artifactScope: prepared.payload?.artifactScope,
    });
    expect(listed.ok).toBe(true);
    expect(listed.payload?.artifacts).toMatchObject([{ relativePath: "reports/final.md" }]);
    const listedArtifacts = listed.payload?.artifacts as Array<Record<string, unknown>>;
    expect(listedArtifacts[0]).not.toHaveProperty("content");

    const read = await callGatewayMethod(methods, "xworkmate.artifacts.read", {
      sessionKey: "thread-main",
      runId: "turn-1",
      artifactScope: prepared.payload?.artifactScope,
      relativePath: "reports/final.md",
    });
    expect(read.ok).toBe(true);
    expect(read.payload?.artifacts).toMatchObject([{ relativePath: "reports/final.md", encoding: "base64" }]);

    const unprepared = await callGatewayMethod(methods, "xworkmate.artifacts.export", {
      sessionKey: "thread-main",
      runId: "turn-unprepared",
    });
    expect(unprepared.ok).toBe(true);
    expect(unprepared.payload?.artifacts).toEqual([]);
    expect(unprepared.payload?.warnings).toEqual(["artifact scope is not prepared for this task run"]);
    expect(unprepared.payload?.manifestMarkdown).toContain("No artifacts found for this task run.");
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

  it("does not expose session scope controls on the bridge agents tool", async () => {
    const tools: Array<{ tool: unknown; options: { names?: string[] } }> = [];
    const api = {
      config: {},
      pluginConfig: {},
      registerGatewayMethod: () => undefined,
      registerTool: (tool: unknown, options: { names?: string[] }) => {
        tools.push({ tool, options });
      },
    } as unknown as OpenClawPluginApi;

    plugin.register(api);

    const entry = tools.find((item) => item.options.names?.includes("openclaw_multi_session_agents"));
    const factory = entry?.tool as (ctx: Record<string, unknown>) => {
      parameters: { properties?: Record<string, unknown> };
      execute: (id: string, params: Record<string, unknown>) => Promise<unknown>;
    };
    const tool = factory({});

    expect(tool.parameters.properties?.sessionKey).toBeUndefined();
    expect(tool.parameters.properties?.runId).toBeUndefined();
    expect(tool.parameters.properties?.workspaceDir).toBeUndefined();
    await expect(tool.execute("call-1", { taskPrompt: "run", steps: [] })).rejects.toThrow("sessionKey required");
    await expect(factory({ sessionKey: "thread-main" }).execute("call-2", { taskPrompt: "run", steps: [] })).rejects.toThrow(
      "runId required",
    );
  });

  it("fails closed when bridge token is missing", async () => {
    const tools: Array<{ tool: unknown; options: { names?: string[] } }> = [];
    const api = {
      config: {},
      pluginConfig: { workspaceDir: await fs.promises.mkdtemp(path.join(os.tmpdir(), "tmp-openclaw-agent-token-")), bridgeUrl: "http://127.0.0.1:1" },
      registerGatewayMethod: () => undefined,
      registerTool: (tool: unknown, options: { names?: string[] }) => {
        tools.push({ tool, options });
      },
    } as unknown as OpenClawPluginApi;

    plugin.register(api);

    const entry = tools.find((item) => item.options.names?.includes("openclaw_multi_session_agents"));
    const factory = entry?.tool as (ctx: Record<string, unknown>) => {
      execute: (id: string, params: Record<string, unknown>) => Promise<unknown>;
    };
    const tool = factory({ sessionKey: "thread-main", runId: "turn-1" });

    await expect(
      tool.execute("call-1", {
        taskPrompt: "run",
        steps: [{ providerId: "codex", prompt: "hello" }],
      }),
    ).rejects.toThrow("bridgeToken required");
  });

  it("runs bridge-backed multi-agent work inside the current task artifact scope", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "tmp-openclaw-bridge-agents-"));
    const bridgeRequests: Array<Record<string, unknown>> = [];
    const bridgeServer = http.createServer((req, res) => {
      if (req.method !== "POST" || req.url !== "/acp/rpc") {
        res.statusCode = 404;
        res.end();
        return;
      }
      expect(req.headers.authorization).toBe("Bearer bridge-token");
      let body = "";
      req.on("data", (chunk: Buffer) => {
        body += chunk.toString("utf8");
      });
      req.on("end", () => {
        const decoded = JSON.parse(body) as Record<string, unknown>;
        bridgeRequests.push(decoded);
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: decoded.id,
            result: {
              success: true,
              status: "completed",
              mode: "multi-agent",
              orchestrationMode: "sequence",
              summary: "bridge agents done",
              steps: [{ providerId: "codex", status: "completed", output: "done" }],
            },
          }),
        );
      });
    });
    await new Promise<void>((resolve) => bridgeServer.listen(0, "127.0.0.1", resolve));
    try {
      const address = bridgeServer.address();
      if (!address || typeof address === "string") {
        throw new Error("missing bridge server address");
      }
      const tools: Array<{ tool: unknown; options: { names?: string[] } }> = [];
      const api = {
        config: {},
        pluginConfig: {
          workspaceDir: root,
          bridgeUrl: `http://127.0.0.1:${address.port}`,
          bridgeToken: "bridge-token",
        },
        registerGatewayMethod: () => undefined,
        registerTool: (tool: unknown, options: { names?: string[] }) => {
          tools.push({ tool, options });
        },
      } as unknown as OpenClawPluginApi;

      plugin.register(api);

      const entry = tools.find((item) => item.options.names?.includes("openclaw_multi_session_agents"));
      const factory = entry?.tool as (ctx: Record<string, unknown>) => {
        execute: (id: string, params: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; details: { artifacts: Array<{ relativePath: string }> } }>;
      };
      const tool = factory({ sessionKey: "thread-main", runId: "turn-1", workspaceDir: root });
      const result = await tool.execute("call-1", {
        taskPrompt: "coordinate",
        mode: "sequence",
        steps: [{ providerId: "codex", prompt: "hello" }],
        sessionKey: "evil",
        runId: "evil",
        workspaceDir: "/",
      });

      expect(result.content[0]?.text).toContain("bridge agents done");
      expect(result.details.artifacts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ relativePath: "multi-agent-result.json" }),
          expect.objectContaining({ relativePath: "multi-agent-result.md" }),
        ]),
      );
      expect(await fs.promises.readFile(path.join(root, "tasks", "thread-main", "turn-1", "multi-agent-result.md"), "utf8")).toContain(
        "bridge agents done",
      );
      await expect(fs.promises.stat(path.join(root, "tasks", "evil", "evil", "multi-agent-result.md"))).rejects.toThrow();
      expect(bridgeRequests).toHaveLength(1);
      const params = bridgeRequests[0]?.params as Record<string, unknown>;
      expect(params.sessionId).toBe("openclaw:thread-main");
      expect(params.threadId).toBe("thread-main");
      expect(params.workingDirectory).toBe(await fs.promises.realpath(path.join(root, "tasks", "thread-main", "turn-1")));
      expect(params.multiAgent).toBe(true);
      expect(params.routing).toMatchObject({
        orchestrationMode: "sequence",
        steps: [{ providerId: "codex", prompt: "hello" }],
      });
    } finally {
      await new Promise<void>((resolve, reject) => {
        bridgeServer.close((error) => (error ? reject(error) : resolve()));
      });
    }
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
    const tool = factory({
      sessionScope: {
        scopeKind: "run",
        sessionKey: "thread-main",
        runId: "turn-1",
        workspaceDir: root,
        relativeTaskDirectory: "tasks/thread-main/turn-1",
      },
    });
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

async function callGatewayMethod(
  methods: Map<string, GatewayMethodHandler>,
  method: string,
  params: Record<string, unknown>,
): Promise<GatewayMethodResponse> {
  const handler = methods.get(method);
  if (!handler) {
    throw new Error(`missing gateway method ${method}`);
  }
  let response: GatewayMethodResponse | undefined;
  await handler({
    params,
    respond: (ok: boolean, payload?: Record<string, unknown>, error?: GatewayMethodResponse["error"]) => {
      response = { ok, payload, error };
    },
  } as Parameters<GatewayMethodHandler>[0]);
  if (!response) {
    throw new Error(`gateway method ${method} did not respond`);
  }
  return response;
}
