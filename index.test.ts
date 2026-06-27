import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { describe, expect, it } from "vitest";
import plugin, { lastAssistantText } from "./index.js";
import { prepareXWorkmateArtifacts } from "./src/exportArtifacts.js";

type GatewayMethodHandler = Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1];
type GatewayMethodResponse = {
  ok: boolean;
  payload?: Record<string, unknown>;
  error?: { code?: string; message?: string };
};

describe("plugin registration", () => {
  it("extracts only the final assistant display text", () => {
    expect(lastAssistantText([
      { role: "user", content: "secret prompt" },
      { role: "assistant", content: [{ type: "tool_call", text: "ignored" }, { type: "text", text: "完成并已保存。" }] },
    ])).toBe("完成并已保存。");
  });
  it("declares registered agent tools in the manifest contract", () => {
    const manifest = JSON.parse(fs.readFileSync("openclaw.plugin.json", "utf8")) as {
      contracts?: { tools?: string[]; sessionScopedTools?: string[] };
      configSchema?: { properties?: Record<string, unknown> };
    };

    expect(manifest.contracts?.tools).toContain("openclaw_multi_session_artifacts");
    expect(manifest.contracts?.tools).not.toContain("openclaw_multi_session_agents");
    expect(manifest.contracts?.sessionScopedTools).toContain("openclaw_multi_session_artifacts");
    expect(manifest.contracts?.sessionScopedTools).not.toContain("openclaw_multi_session_agents");
    expect(manifest.configSchema?.properties?.artifactRefSigningSecret).toBeTruthy();
    expect(manifest.configSchema?.properties?.bridgeUrl).toBeUndefined();
    expect(manifest.configSchema?.properties?.bridgeToken).toBeUndefined();
  });

  it("registers the xworkmate gateway methods and optional tools", () => {
    const methods: Array<{ method: string; handler: GatewayMethodHandler }> = [];
    const tools: Array<{ tool: unknown; options: unknown }> = [];
    const api = {
      config: {}, logger: { warn: console.warn },
      pluginConfig: {},
      registerGatewayMethod: (method: string, handler: GatewayMethodHandler) => {
        methods.push({ method, handler });
      },
      registerTool: (tool: unknown, options: unknown) => {
        tools.push({ tool, options });
      },
      registerHook: () => undefined,
      on: () => undefined,
    } as unknown as OpenClawPluginApi;

    plugin.register(api);

    expect(methods.map((entry) => entry.method)).toEqual([
      "xworkmate.session.prepare",
      "xworkmate.tasks.get",
      "xworkmate.artifacts.export",
      "xworkmate.artifacts.collect-and-snapshot",
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

  it("executes registered gateway methods against the current task scope", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "tmp-openclaw-multi-session-gateway-"));
    const methods = new Map<string, GatewayMethodHandler>();
    const api = {
      config: {}, logger: { warn: console.warn },
      pluginConfig: { workspaceDir: root },
      registerGatewayMethod: (method: string, handler: GatewayMethodHandler) => {
        methods.set(method, handler);
      },
      registerTool: () => undefined,
      registerHook: () => undefined,
      on: () => undefined,
      runtime: {
        agent: {
          session: {
            patchSessionEntry: async (params: any) => {
              params.update({ pluginExtensions: {} });
              return {};
            },
          },
        },
      },
    } as unknown as OpenClawPluginApi;

    plugin.register(api);

    const prepared = await callGatewayMethod(methods, "xworkmate.session.prepare", {
      appThreadKey: "thread-main",
      openclawSessionKey: "thread-main",
      runId: "turn-1",
    });
    expect(prepared.ok).toBe(true);
    expect(prepared.payload?.artifactScope).toBe("tasks/thread-main/turn-1");
    const artifactDirectory = String(prepared.payload?.artifactDirectory);

    const emptyExport = await callGatewayMethod(methods, "xworkmate.artifacts.export", {
      openclawSessionKey: "thread-main",
      runId: "turn-1",
      artifactScope: prepared.payload?.artifactScope,
    });
    expect(emptyExport.ok).toBe(true);
    expect(emptyExport.payload?.artifacts).toEqual([]);
    expect(emptyExport.payload?.warnings).toEqual([]);

    await fs.promises.mkdir(path.join(artifactDirectory, "reports"), { recursive: true });
    await fs.promises.writeFile(path.join(artifactDirectory, "reports", "final.md"), "final");

    const listed = await callGatewayMethod(methods, "xworkmate.artifacts.list", {
      openclawSessionKey: "thread-main",
      runId: "turn-1",
      artifactScope: prepared.payload?.artifactScope,
    });
    expect(listed.ok).toBe(true);
    expect(listed.payload?.artifacts).toMatchObject([{ relativePath: "reports/final.md" }]);
    const listedArtifacts = listed.payload?.artifacts as Array<Record<string, unknown>>;
    expect(listedArtifacts[0]).not.toHaveProperty("content");

    const read = await callGatewayMethod(methods, "xworkmate.artifacts.read", {
      openclawSessionKey: "thread-main",
      runId: "turn-1",
      artifactScope: prepared.payload?.artifactScope,
      relativePath: "reports/final.md",
    });
    expect(read.ok).toBe(true);
    expect(read.payload?.artifacts).toMatchObject([{ relativePath: "reports/final.md", encoding: "base64" }]);

    const unprepared = await callGatewayMethod(methods, "xworkmate.artifacts.export", {
      openclawSessionKey: "thread-main",
      runId: "turn-unprepared",
    });
    expect(unprepared.ok).toBe(true);
    expect(unprepared.payload?.artifacts).toEqual([]);
    expect(unprepared.payload?.warnings).toEqual(["artifact scope is not prepared for this task run"]);
  });

  it("registers xworkmate task state against the native session extension and task runtime seams", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "tmp-openclaw-task-state-"));
    const methods = new Map<string, GatewayMethodHandler>();
    const hooks = new Map<string, (event: unknown, ctx?: unknown) => Promise<void>>();
    const sessionExtensions: Array<Record<string, unknown>> = [];
    const sessionExtensionPatches: Array<Record<string, unknown>> = [];
    const detachedRuntimes: Array<Record<string, unknown>> = [];
    const api = {
      config: {}, logger: { warn: console.warn },
      pluginConfig: { workspaceDir: root },
      runtime: {
        agent: {
          session: {
            registerSessionExtension: (extension: Record<string, unknown>) => {
              sessionExtensions.push(extension);
            },
            patchSessionEntry: async (patch: any) => {
              sessionExtensionPatches.push(patch);
              if (patch.update) patch.update({ pluginExtensions: {} });
              return {};
            },
          },
        },
        tasks: {
          runs: {
            bindSession: ({ sessionKey }: { sessionKey: string }) => ({
              resolve: (token: string) =>
                sessionKey === "draft:1780636411666238-3" && token === "turn-1"
                  ? {
                      taskId: "native-task",
                      runtime: "acp",
                      requesterSessionKey: sessionKey,
                      ownerKey: "draft-1780636411666238-3",
                      scopeKind: "session",
                      runId: token,
                      task: "native",
                      status: "running",
                      deliveryStatus: "pending",
                      notifyPolicy: "state_changes",
                      createdAt: 1,
                    }
                  : undefined,
            }),
          },
        },
      },
      session: {
        state: {
          registerSessionExtension: (extension: Record<string, unknown>) => {
            sessionExtensions.push(extension);
          },
        },
      },

      registerDetachedTaskRuntime: (runtime: Record<string, unknown>) => {
        detachedRuntimes.push(runtime);
      },
      registerGatewayMethod: (method: string, handler: GatewayMethodHandler) => {
        methods.set(method, handler);
      },
      registerTool: () => undefined,
      registerHook: (event: string, handler: (payload: unknown, ctx?: unknown) => Promise<void>) => {
        hooks.set(event, handler);
      },
      on: (event: string, handler: (payload: unknown, ctx?: unknown) => Promise<void>) => {
        hooks.set(event, handler);
      },

    } as unknown as OpenClawPluginApi;

    plugin.register(api);

    expect(sessionExtensions).toHaveLength(1);
    expect(sessionExtensions[0]).toMatchObject({
      namespace: "xworkmate.sessionMapping",
      sessionEntrySlotKey: "xworkmate",
    });
    const projected = (sessionExtensions[0]?.project as (ctx: Record<string, unknown>) => unknown)({
      openclawSessionKey: "draft:1780636411666238-3",
      state: {},
    });
    expect(projected).toMatchObject({});
    expect(detachedRuntimes).toHaveLength(0);

    await hooks.get("session_start")?.({
      appThreadKey: "draft:legacy-session-key-only",
      sessionKey: "draft:legacy-session-key-only",
      runId: "turn-legacy",
    });
    expect(sessionExtensionPatches).toHaveLength(0);

    await hooks.get("session_start")?.({
      appThreadKey: "draft:1780636411666238-3",
      openclawSessionKey: "draft:1780636411666238-3",
      threadId: "draft-1780636411666238-3",
      runId: "turn-1",
      expectedArtifactDirs: ["artifacts/", "reports/", "exports/"],
    });
    await fs.promises.mkdir(path.join(root, "reports"), { recursive: true });
    await fs.promises.writeFile(path.join(root, "reports", "final.md"), "final");
    expect(sessionExtensionPatches).toHaveLength(1);
    expect(sessionExtensionPatches[0]).toMatchObject({
      sessionKey: "draft:1780636411666238-3",
      preserveActivity: true,
    });

    const snapshot = await callGatewayMethod(methods, "xworkmate.tasks.get", {
      appThreadKey: "draft:1780636411666238-3",
      openclawSessionKey: "draft:1780636411666238-3",
      runId: "turn-1",
      expectedArtifactDirs: ["reports"],
      sinceUnixMs: Date.now() - 1_000,
    });

    expect(snapshot.ok).toBe(true);
    expect(snapshot.payload).toMatchObject({
      status: "running",
      taskStatus: "running",
      appThreadKey: "draft:1780636411666238-3",
      openclawSessionKey: "draft:1780636411666238-3",
      artifactCount: 1,
    });
    expect(snapshot.payload?.task).toMatchObject({ taskId: "native-task", status: "running" });
    expect(snapshot.payload?.artifacts).toMatchObject([{ relativePath: "reports/final.md" }]);

    await hooks.get("agent_end")?.(
      { runId: "turn-1", success: false, error: "401 authentication failed", messages: [{ role: "assistant", content: [{ type: "text", text: "上游认证失败。" }] }] },
      { sessionKey: "draft:1780636411666238-3", runId: "turn-1" },
    );
    expect(sessionExtensionPatches.at(-1)).toMatchObject({
      sessionKey: "draft:1780636411666238-3",
      preserveActivity: true,
    });
  });

  it("does not invent default session or run ids for the optional agent tool", async () => {
    const tools: Array<{ tool: unknown; options: unknown }> = [];
    const api = {
      config: {}, logger: { warn: console.warn },
      pluginConfig: { workspaceDir: path.join(os.tmpdir(), "openclaw-multi-session-tool-test") },
      registerGatewayMethod: () => undefined,
      registerHook: () => undefined,
      on: () => undefined,
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

  it("does not expose the removed bridge agents tool", async () => {
    const tools: Array<{ tool: unknown; options: { names?: string[] } }> = [];
    const api = {
      config: {}, logger: { warn: console.warn },
      pluginConfig: {},
      registerGatewayMethod: () => undefined,
      registerHook: () => undefined,
      on: () => undefined,
      registerTool: (tool: unknown, options: { names?: string[] }) => {
        tools.push({ tool, options });
      },
    } as unknown as OpenClawPluginApi;

    plugin.register(api);

    expect(tools.map((item) => item.options.names).flat()).toEqual(["openclaw_multi_session_artifacts"]);
  });

  it("uses host context scope for the optional agent tool", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "tmp-openclaw-multi-session-tool-"));
    const current = await prepareXWorkmateArtifacts({
      params: { openclawSessionKey: "thread-main", runId: "turn-1" },
      pluginConfig: { workspaceDir: root },
    });
    const other = await prepareXWorkmateArtifacts({
      params: { openclawSessionKey: "thread-main", runId: "turn-2" },
      pluginConfig: { workspaceDir: root },
    });
    await fs.promises.writeFile(path.join(current.artifactDirectory, "current.txt"), "current");
    await fs.promises.writeFile(path.join(other.artifactDirectory, "other.txt"), "other");
    await fs.promises.writeFile(path.join(root, "global.txt"), "global");

    const tools: Array<{ tool: unknown; options: unknown }> = [];
    const api = {
      config: {}, logger: { warn: console.warn },
      pluginConfig: {},
      registerGatewayMethod: () => undefined,
      registerHook: () => undefined,
      on: () => undefined,
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
      openclawSessionKey: "thread-other",
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
