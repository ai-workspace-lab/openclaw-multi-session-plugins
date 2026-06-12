import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  XWORKMATE_PLUGIN_ID,
  XWORKMATE_SESSION_EXTENSION_NAMESPACE,
  getXWorkmateTaskSnapshot,
  normalizeXWorkmateTaskMetadataV1,
  recordXWorkmateSessionMapping,
  readXWorkmateSessionMapping,
} from "./taskState.js";

function createApiFixture(tasks: Record<string, unknown> = {}, pluginConfig: Record<string, unknown> = {}) {
  const sessions = new Map<string, any>();
  const api = {
    config: {},
    pluginConfig,
    logger: { warn: () => {} },
    runtime: {
      agent: {
        session: {
          getSessionEntry: ({ sessionKey }: { sessionKey: string }) => sessions.get(sessionKey),
          listSessionEntries: () =>
            [...sessions.entries()].map(([sessionKey, entry]) => ({
              sessionKey,
              entry,
            })),
          patchSessionEntry: async ({
            sessionKey,
            fallbackEntry,
            update,
          }: {
            sessionKey: string;
            fallbackEntry?: any;
            update: (entry: any) => Partial<any> | null;
          }) => {
            const current = sessions.get(sessionKey) ?? fallbackEntry;
            if (!current) {
              return null;
            }
            const patch = update(current);
            if (patch) {
              sessions.set(sessionKey, { ...current, ...patch });
            }
            return sessions.get(sessionKey) ?? null;
          },
        },
      },
      tasks: {
        runs: {
          bindSession: ({ sessionKey }: { sessionKey: string }) => ({
            resolve: (token: string) => tasks[`${sessionKey}:${token}`],
            get: (token: string) => tasks[`${sessionKey}:${token}`],
            findLatest: () => tasks[`${sessionKey}:latest`],
          }),
        },
      },
    },
  };
  return { api: api as any, sessions };
}

async function createWorkspaceFixture() {
  return fs.mkdtemp(path.join(os.tmpdir(), "xworkmate-task-state-"));
}

describe("xworkmate task state mapping", () => {
  it("requires typed appThreadKey metadata", () => {
    expect(() =>
      normalizeXWorkmateTaskMetadataV1({
        schemaVersion: 1,
        sessionKey: "draft:legacy",
        expectedArtifactDirs: ["artifacts/"],
      }),
    ).toThrow("appThreadKey required");
  });

  it("writes a durable pluginExtensions mapping without deriving the OpenClaw key", async () => {
    const { api, sessions } = createApiFixture();

    const mapping = await recordXWorkmateSessionMapping({
      api,
      params: {
        schemaVersion: 1,
        appThreadKey: "draft:1780658097668838-1",
        openclawSessionKey: "draft:1780658097668838-1",
        runId: "run-1",
        expectedArtifactDirs: ["assets/images", "reports/"],
        createdAt: "2026-06-05T00:00:00.000Z",
      },
    });

    expect(mapping).toMatchObject({
      schemaVersion: 1,
      appThreadKey: "draft:1780658097668838-1",
      openclawSessionKey: "draft:1780658097668838-1",
      expectedArtifactDirs: ["assets/images/", "reports/"],
      source: "bridge_prepare",
    });
    expect(
      sessions.get("draft:1780658097668838-1").pluginExtensions[XWORKMATE_PLUGIN_ID][
        XWORKMATE_SESSION_EXTENSION_NAMESPACE
      ],
    ).toMatchObject(mapping);
  });

  it("fails closed when an existing mapping points to a different app thread", async () => {
    const { api } = createApiFixture();
    await recordXWorkmateSessionMapping({
      api,
      params: {
        schemaVersion: 1,
        appThreadKey: "draft:first",
        openclawSessionKey: "draft:first",
        runId: "run-1",
      },
    });

    await expect(
      recordXWorkmateSessionMapping({
        api,
        params: {
          schemaVersion: 1,
          appThreadKey: "draft:second",
          openclawSessionKey: "draft:first",
          runId: "run-2",
        },
      }),
    ).rejects.toThrow("conflict");
  });

  it("resolves appThreadKey through pluginExtensions before querying native tasks", async () => {
    const { api } = createApiFixture({
      "draft:1780658097668838-1:run-1": {
        taskId: "task-1",
        runId: "run-1",
        status: "succeeded",
      },
    });
    await recordXWorkmateSessionMapping({
      api,
      params: {
        schemaVersion: 1,
        appThreadKey: "draft:1780658097668838-1",
        openclawSessionKey: "draft:1780658097668838-1",
        runId: "run-1",
        expectedArtifactDirs: ["artifacts/"],
      },
    });

    const result = await getXWorkmateTaskSnapshot({
      api,
      params: {
        appThreadKey: "draft:1780658097668838-1",
        runId: "run-1",
        includeArtifacts: false,
      },
    });

    expect(result).toMatchObject({
      success: true,
      status: "completed",
      openclawSessionKey: "draft:1780658097668838-1",
      expectedArtifactDirs: ["artifacts/"],
    });
  });

  it("reports unknown evidence from task artifacts when native task record is unavailable", async () => {
    const workspaceDir = await createWorkspaceFixture();
    const appThreadKey = "draft:sample-task";
    const openclawSessionKey = "agent:main:draft:sample-task";
    const runId = "turn-sample";
    const artifactDir = path.join(workspaceDir, "tasks", "agent_main_draft_sample-task", runId);
    await fs.mkdir(artifactDir, { recursive: true });
    await fs.writeFile(path.join(artifactDir, "series.config.json"), "{}\n", "utf8");

    const { api } = createApiFixture({}, { workspaceDir });
    await recordXWorkmateSessionMapping({
      api,
      params: {
        schemaVersion: 1,
        appThreadKey,
        openclawSessionKey,
        runId,
      },
    });

    const result = await getXWorkmateTaskSnapshot({
      api,
      params: {
        appThreadKey,
        openclawSessionKey,
        runId,
      },
    });

    expect(result).toMatchObject({
      success: false,
      status: "unknown",
      taskStatus: "unknown",
      evidence: "artifacts_present",
      openclawSessionKey,
      runId,
      task: {
        source: "artifact_fallback",
        status: "unknown",
      },
      artifacts: [
        {
          relativePath: "series.config.json",
          contentType: "application/json",
        },
      ],
      artifactCount: 1,
    });
    expect((result.warnings as string[]).some((entry) => entry.includes("task status is unknown"))).toBe(true);
  });

  it("returns no_native_task_record when neither native task record nor task artifacts exist", async () => {
    const workspaceDir = await createWorkspaceFixture();
    const { api } = createApiFixture({}, { workspaceDir });
    await recordXWorkmateSessionMapping({
      api,
      params: {
        schemaVersion: 1,
        appThreadKey: "draft:no-task",
        openclawSessionKey: "draft:no-task",
        runId: "run-1",
      },
    });

    const result = await getXWorkmateTaskSnapshot({
      api,
      params: {
        appThreadKey: "draft:no-task",
        runId: "run-1",
      },
    });

    expect(result).toMatchObject({
      ok: false,
      code: "no_native_task_record",
      mapping: {
        appThreadKey: "draft:no-task",
        openclawSessionKey: "draft:no-task",
      },
    });
  });

  it("does not accept legacy sessionKey as a task lookup alias", async () => {
    const { api } = createApiFixture({
      "draft:legacy:run-1": {
        taskId: "task-legacy",
        runId: "run-1",
        status: "succeeded",
      },
    });

    const result = await getXWorkmateTaskSnapshot({
      api,
      params: {
        sessionKey: "draft:legacy",
        runId: "run-1",
        includeArtifacts: false,
      },
    });

    expect(result).toMatchObject({
      ok: false,
      code: "invalid_lookup",
    });
  });

  it("can read mapping by appThreadKey from pluginExtensions", async () => {
    const { api } = createApiFixture();
    await recordXWorkmateSessionMapping({
      api,
      params: {
        schemaVersion: 1,
        appThreadKey: "draft:lookup",
        openclawSessionKey: "draft:lookup",
        runId: "run-1",
      },
    });

    await expect(readXWorkmateSessionMapping(api, { appThreadKey: "draft:lookup" })).resolves.toMatchObject({
      appThreadKey: "draft:lookup",
      openclawSessionKey: "draft:lookup",
    });
  });
});
