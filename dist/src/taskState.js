import { exportXWorkmateArtifacts } from "./exportArtifacts.js";
import { normalizeExpectedArtifactDirs } from "./expectedArtifactDirs.js";
const XWORKMATE_PLUGIN_ID = "openclaw-multi-session-plugins";
export const XWORKMATE_SESSION_EXTENSION_NAMESPACE = "xworkmate.sessionMapping";
export const XWORKMATE_TASK_RUNS_EXTENSION_NAMESPACE = "xworkmate.taskRuns";
const MAX_RECORDED_TASK_RUNS = 32;
export function registerXWorkmateSessionExtension(api) {
    const registerExtension = api.session?.state?.registerSessionExtension ?? api.registerSessionExtension;
    if (typeof registerExtension !== "function") {
        return;
    }
    registerExtension({
        namespace: XWORKMATE_SESSION_EXTENSION_NAMESPACE,
        description: "Durable XWorkmate app/OpenClaw session key mapping.",
        sessionEntrySlotKey: "xworkmate",
        project: (ctx) => {
            const state = asRecord(ctx.state);
            return state ?? {};
        },
    });
}
export async function recordXWorkmateSessionMapping(input) {
    const metadata = normalizeXWorkmateTaskMetadataV1(input.params);
    const openclawSessionKey = requiredString(input.params.openclawSessionKey ?? metadata.openclawSessionKey, "openclawSessionKey required");
    return upsertXWorkmateSessionMapping(input.api, {
        metadata: {
            ...metadata,
            openclawSessionKey,
        },
        openclawSessionKey,
        source: input.source ?? "bridge_prepare",
    });
}
export async function recordXWorkmateTaskRunStarted(input) {
    const now = new Date().toISOString();
    return upsertXWorkmateTaskRun(input.api, {
        openclawSessionKey: requiredString(input.openclawSessionKey, "openclawSessionKey required"),
        runId: requiredString(input.runId, "runId required"),
        status: "running",
        success: false,
        startedAt: now,
        updatedAt: now,
    });
}
export async function recordXWorkmateTaskRunTerminal(input) {
    const now = new Date().toISOString();
    return upsertXWorkmateTaskRun(input.api, {
        openclawSessionKey: requiredString(input.openclawSessionKey, "openclawSessionKey required"),
        runId: requiredString(input.runId, "runId required"),
        status: input.success ? "completed" : "failed",
        success: input.success,
        updatedAt: now,
        completedAt: now,
        output: sanitizeTaskRunOutput(input.output),
        error: sanitizeTaskRunError(input.error),
    });
}
function normalizeXWorkmateTaskMetadataV1(input) {
    const envelope = asRecord(input.xworkmate) ?? asRecord(input.xworkmateMetadata) ?? input;
    const schemaVersion = Number(envelope.schemaVersion ?? 1);
    if (schemaVersion !== 1) {
        throw new Error("schemaVersion must be 1");
    }
    const appThreadKey = requiredString(envelope.appThreadKey, "appThreadKey required");
    const createdAt = optionalString(envelope.createdAt) || new Date().toISOString();
    return compactObject({
        schemaVersion: 1,
        appThreadKey,
        openclawSessionKey: optionalString(envelope.openclawSessionKey),
        expectedArtifactDirs: normalizeExpectedArtifactDirs(envelope.expectedArtifactDirs),
        requestId: optionalString(envelope.requestId),
        externalTaskId: optionalString(envelope.externalTaskId ?? envelope.taskId),
        createdAt,
    });
}
async function upsertXWorkmateSessionMapping(api, input) {
    const patchSessionEntry = resolvePatchSessionEntry(api);
    if (!patchSessionEntry) {
        throw new Error("OpenClaw runtime session patch API is unavailable");
    }
    const now = new Date().toISOString();
    let mapping;
    await patchSessionEntry({
        sessionKey: input.openclawSessionKey,
        fallbackEntry: {
            sessionId: input.openclawSessionKey,
            updatedAt: Date.now(),
        },
        preserveActivity: true,
        update: (entry) => {
            const existing = readMappingFromEntry(entry);
            if (existing) {
                assertMappingCompatible(existing, input.metadata.appThreadKey, input.openclawSessionKey);
                mapping = {
                    ...existing,
                    expectedArtifactDirs: input.metadata.expectedArtifactDirs,
                    updatedAt: now,
                    source: existing.source,
                };
            }
            else {
                mapping = compactObject({
                    schemaVersion: 1,
                    appThreadKey: input.metadata.appThreadKey,
                    openclawSessionKey: input.openclawSessionKey,
                    expectedArtifactDirs: input.metadata.expectedArtifactDirs,
                    createdAt: input.metadata.createdAt || now,
                    updatedAt: now,
                    source: input.source,
                });
            }
            return {
                pluginExtensions: writeMappingToPluginExtensions(entry.pluginExtensions, mapping),
            };
        },
    });
    if (!mapping) {
        throw new Error("failed to write xworkmate session mapping");
    }
    return mapping;
}
async function readXWorkmateSessionMapping(api, lookup) {
    const getSessionEntry = resolveGetSessionEntry(api);
    if (!getSessionEntry) {
        return undefined;
    }
    const openclawSessionKey = optionalString(lookup.openclawSessionKey);
    if (openclawSessionKey) {
        return readMappingFromEntry(getSessionEntry({ sessionKey: openclawSessionKey }));
    }
    const appThreadKey = optionalString(lookup.appThreadKey);
    if (!appThreadKey) {
        return undefined;
    }
    const listSessionEntries = resolveListSessionEntries(api);
    for (const item of listSessionEntries?.() ?? []) {
        const mapping = readMappingFromEntry(item.entry);
        if (mapping?.appThreadKey === appThreadKey) {
            return mapping;
        }
    }
    return undefined;
}
export async function getXWorkmateTaskSnapshot(input) {
    const params = input.params ?? {};
    const appThreadKey = optionalString(params.appThreadKey);
    const explicitOpenclawSessionKey = optionalString(params.openclawSessionKey);
    const mapping = await readXWorkmateSessionMapping(input.api, {
        appThreadKey,
        openclawSessionKey: explicitOpenclawSessionKey,
    });
    if (!mapping && appThreadKey && !explicitOpenclawSessionKey) {
        return lookupError("mapping_not_found", `No OpenClaw session mapping found for ${appThreadKey}`);
    }
    const openclawSessionKey = mapping?.openclawSessionKey || explicitOpenclawSessionKey;
    if (!openclawSessionKey) {
        return lookupError("invalid_lookup", "openclawSessionKey or appThreadKey required");
    }
    const runId = optionalString(params.runId);
    const taskId = optionalString(params.taskId);
    const task = resolveNativeTask(input.api, {
        openclawSessionKey,
        runId,
        taskId,
    });
    const includeArtifacts = params.includeArtifacts !== false;
    if (!task) {
        const recordedRun = runId
            ? readXWorkmateTaskRun(input.api, openclawSessionKey, runId)
            : undefined;
        const exported = includeArtifacts && runId
            ? await exportArtifactsForTaskLookup(input, params, openclawSessionKey, runId, mapping)
            : undefined;
        if (recordedRun) {
            return {
                success: recordedRun.status === "running" ? true : recordedRun.success,
                status: recordedRun.status,
                taskStatus: recordedRun.status,
                terminal: recordedRun.status !== "running",
                terminalSource: recordedRun.status === "running" ? "session_prepare" : "agent_end",
                mode: "gateway-chat",
                mapping,
                appThreadKey: mapping?.appThreadKey ?? appThreadKey,
                openclawSessionKey,
                runId,
                taskId: taskId || runId,
                task: {
                    taskId: taskId || runId,
                    runId,
                    status: recordedRun.status,
                    success: recordedRun.success,
                    source: "xworkmate_run_state",
                    startedAt: recordedRun.startedAt,
                    updatedAt: recordedRun.updatedAt,
                    completedAt: recordedRun.completedAt,
                    error: recordedRun.error,
                },
                output: recordedRun.output,
                resultSummary: recordedRun.output,
                error: recordedRun.error,
                message: recordedRun.output ?? recordedRun.error,
                expectedArtifactDirs: mapping?.expectedArtifactDirs ?? [],
                artifactScope: exported?.artifactScope,
                remoteWorkingDirectory: exported?.remoteWorkingDirectory,
                remoteWorkspaceRefKind: exported?.remoteWorkspaceRefKind,
                scopeKind: exported?.scopeKind,
                artifacts: exported?.artifacts ?? [],
                constraintSatisfied: exported?.constraintSatisfied,
                missingRequiredExtensions: exported?.missingRequiredExtensions,
                warnings: exported?.warnings ?? [],
                artifactCount: exported?.artifacts.length ?? 0,
            };
        }
        if (exported?.artifacts.length) {
            return {
                success: false,
                status: "unknown",
                taskStatus: "unknown",
                evidence: "artifacts_present",
                mode: "gateway-chat",
                mapping,
                appThreadKey: mapping?.appThreadKey ?? appThreadKey,
                openclawSessionKey,
                runId,
                taskId: taskId || runId,
                task: {
                    taskId: taskId || runId,
                    runId,
                    status: "unknown",
                    source: "artifact_fallback",
                },
                expectedArtifactDirs: mapping?.expectedArtifactDirs ?? [],
                artifactScope: exported.artifactScope,
                remoteWorkingDirectory: exported.remoteWorkingDirectory,
                remoteWorkspaceRefKind: exported.remoteWorkspaceRefKind,
                scopeKind: exported.scopeKind,
                artifacts: exported.artifacts,
                constraintSatisfied: exported.constraintSatisfied,
                missingRequiredExtensions: exported.missingRequiredExtensions,
                warnings: [
                    ...exported.warnings,
                    `Native OpenClaw task record was unavailable for ${openclawSessionKey}; artifacts are present but task status is unknown.`,
                ],
                artifactCount: exported.artifacts.length,
            };
        }
        const code = runId || taskId ? "no_native_task_record" : "task_not_found";
        return lookupError(code, `No native OpenClaw task record found for ${openclawSessionKey}`, mapping);
    }
    const taskStatus = optionalString(task.status) || "running";
    const exported = includeArtifacts
        ? await exportArtifactsForTaskLookup(input, params, openclawSessionKey, runId || optionalString(task.runId) || optionalString(task.taskId), mapping)
        : undefined;
    return {
        success: true,
        status: appStatusFromTaskStatus(taskStatus),
        taskStatus,
        mode: "gateway-chat",
        mapping,
        appThreadKey: mapping?.appThreadKey ?? appThreadKey,
        openclawSessionKey,
        runId: runId || optionalString(task.runId),
        taskId: taskId || optionalString(task.taskId),
        task,
        expectedArtifactDirs: mapping?.expectedArtifactDirs ?? [],
        artifactScope: exported?.artifactScope,
        remoteWorkingDirectory: exported?.remoteWorkingDirectory,
        remoteWorkspaceRefKind: exported?.remoteWorkspaceRefKind,
        scopeKind: exported?.scopeKind,
        artifacts: exported?.artifacts ?? [],
        constraintSatisfied: exported?.constraintSatisfied,
        missingRequiredExtensions: exported?.missingRequiredExtensions,
        warnings: exported?.warnings ?? [],
        artifactCount: exported?.artifacts.length ?? 0,
    };
}
async function upsertXWorkmateTaskRun(api, input) {
    const patchSessionEntry = resolvePatchSessionEntry(api);
    if (!patchSessionEntry) {
        throw new Error("OpenClaw runtime session patch API is unavailable");
    }
    let recorded;
    await patchSessionEntry({
        sessionKey: input.openclawSessionKey,
        fallbackEntry: {
            sessionId: input.openclawSessionKey,
            updatedAt: Date.now(),
        },
        preserveActivity: true,
        update: (entry) => {
            const runs = readTaskRunsFromEntry(entry);
            const existing = runs[input.runId];
            recorded = compactObject({
                schemaVersion: 1,
                runId: input.runId,
                status: input.status,
                success: input.success,
                startedAt: existing?.startedAt ?? input.startedAt ?? input.updatedAt,
                updatedAt: input.updatedAt,
                completedAt: input.completedAt,
                output: input.output,
                error: input.error,
            });
            runs[input.runId] = recorded;
            const boundedRuns = Object.fromEntries(Object.entries(runs)
                .sort((left, right) => right[1].updatedAt.localeCompare(left[1].updatedAt))
                .slice(0, MAX_RECORDED_TASK_RUNS));
            return {
                pluginExtensions: {
                    ...(entry.pluginExtensions ?? {}),
                    [XWORKMATE_PLUGIN_ID]: {
                        ...(entry.pluginExtensions?.[XWORKMATE_PLUGIN_ID] ?? {}),
                        [XWORKMATE_TASK_RUNS_EXTENSION_NAMESPACE]: {
                            schemaVersion: 1,
                            runs: boundedRuns,
                        },
                    },
                },
            };
        },
    });
    if (!recorded) {
        throw new Error("failed to write xworkmate task run state");
    }
    return recorded;
}
function readXWorkmateTaskRun(api, openclawSessionKey, runId) {
    const entry = resolveGetSessionEntry(api)?.({ sessionKey: openclawSessionKey });
    return readTaskRunsFromEntry(entry)[runId];
}
function readTaskRunsFromEntry(entry) {
    const pluginState = asRecord(entry?.pluginExtensions?.[XWORKMATE_PLUGIN_ID]);
    const store = asRecord(pluginState?.[XWORKMATE_TASK_RUNS_EXTENSION_NAMESPACE]);
    if (store?.schemaVersion !== 1) {
        return {};
    }
    const runs = asRecord(store.runs) ?? {};
    const result = {};
    for (const [key, rawValue] of Object.entries(runs)) {
        const raw = asRecord(rawValue);
        const runId = optionalString(raw?.runId) || key;
        const status = optionalString(raw?.status);
        if (!runId || (status !== "running" && status !== "completed" && status !== "failed")) {
            continue;
        }
        result[runId] = compactObject({
            schemaVersion: 1,
            runId,
            status,
            success: raw?.success === true,
            startedAt: optionalString(raw?.startedAt) || new Date(0).toISOString(),
            updatedAt: optionalString(raw?.updatedAt) || new Date(0).toISOString(),
            completedAt: optionalString(raw?.completedAt),
            output: optionalString(raw?.output),
            error: optionalString(raw?.error),
        });
    }
    return result;
}
function sanitizeTaskRunOutput(value) {
    const raw = optionalString(value);
    if (!raw) {
        return undefined;
    }
    return raw.slice(0, 16 * 1024);
}
function sanitizeTaskRunError(value) {
    const raw = optionalString(value);
    if (!raw) {
        return undefined;
    }
    return raw
        .replace(/\b(sk|nvapi)-[A-Za-z0-9._-]+\b/gi, "$1-<redacted>")
        .replace(/(api[_ -]?key\s*[:=]\s*)[^\s,;]+/gi, "$1<redacted>")
        .slice(0, 2048);
}
async function exportArtifactsForTaskLookup(input, params, openclawSessionKey, runId, mapping) {
    return exportXWorkmateArtifacts({
        params: {
            ...params,
            openclawSessionKey,
            runId,
            expectedArtifactDirs: mapping?.expectedArtifactDirs ?? normalizeExpectedArtifactDirs(params.expectedArtifactDirs),
            includeContent: params.includeContent ?? false,
        },
        config: input.api.config,
        pluginConfig: input.api.pluginConfig,
    });
}
function resolveNativeTask(api, input) {
    try {
        const bound = api.runtime?.tasks?.runs?.bindSession?.({ sessionKey: input.openclawSessionKey });
        if (!bound) {
            return undefined;
        }
        const lookup = input.taskId || input.runId || "";
        const resolved = lookup ? bound.resolve?.(lookup) || bound.get?.(lookup) : bound.findLatest?.();
        return asRecord(resolved);
    }
    catch (error) {
        api.logger?.warn?.(`xworkmate native task lookup failed: sessionKey=${input.openclawSessionKey} error=${String(error)}`);
        return undefined;
    }
}
function lookupError(code, message, mapping) {
    return {
        ok: false,
        code,
        message,
        ...(mapping ? { mapping, expectedArtifactDirs: mapping.expectedArtifactDirs } : {}),
    };
}
function readMappingFromEntry(entry) {
    const pluginState = asRecord(entry?.pluginExtensions?.[XWORKMATE_PLUGIN_ID]);
    const raw = asRecord(pluginState?.[XWORKMATE_SESSION_EXTENSION_NAMESPACE]);
    if (!raw || raw.schemaVersion !== 1) {
        return undefined;
    }
    const appThreadKey = optionalString(raw.appThreadKey);
    const openclawSessionKey = optionalString(raw.openclawSessionKey);
    if (!appThreadKey || !openclawSessionKey) {
        return undefined;
    }
    return {
        schemaVersion: 1,
        appThreadKey,
        openclawSessionKey,
        expectedArtifactDirs: normalizeExpectedArtifactDirs(raw.expectedArtifactDirs),
        createdAt: optionalString(raw.createdAt) || new Date(0).toISOString(),
        updatedAt: optionalString(raw.updatedAt) || optionalString(raw.createdAt) || new Date(0).toISOString(),
        source: parseMappingSource(raw.source),
    };
}
function writeMappingToPluginExtensions(current, mapping) {
    if (!mapping) {
        return current;
    }
    return {
        ...(current ?? {}),
        [XWORKMATE_PLUGIN_ID]: {
            ...(current?.[XWORKMATE_PLUGIN_ID] ?? {}),
            [XWORKMATE_SESSION_EXTENSION_NAMESPACE]: mapping,
        },
    };
}
function assertMappingCompatible(existing, appThreadKey, openclawSessionKey) {
    if (existing.appThreadKey !== appThreadKey || existing.openclawSessionKey !== openclawSessionKey) {
        throw new Error("conflict: xworkmate session mapping already points to a different session");
    }
}
function resolvePatchSessionEntry(api) {
    const runtimeSession = (api.runtime?.agent?.session ?? {});
    const candidate = runtimeSession.patchSessionEntry;
    return typeof candidate === "function" ? candidate : undefined;
}
function resolveGetSessionEntry(api) {
    const runtimeSession = (api.runtime?.agent?.session ?? {});
    const candidate = runtimeSession.getSessionEntry;
    return typeof candidate === "function" ? candidate : undefined;
}
function resolveListSessionEntries(api) {
    const runtimeSession = (api.runtime?.agent?.session ?? {});
    const candidate = runtimeSession.listSessionEntries;
    return typeof candidate === "function"
        ? candidate
        : undefined;
}
function appStatusFromTaskStatus(status) {
    if (status === "succeeded") {
        return "completed";
    }
    if (status === "failed" || status === "timed_out" || status === "cancelled" || status === "lost") {
        return "failed";
    }
    return "running";
}
function parseMappingSource(value) {
    const source = optionalString(value);
    if (source === "session_start" || source === "bridge_prepare") {
        return source;
    }
    return "bridge_prepare";
}
function requiredString(value, message) {
    const text = optionalString(value);
    if (!text) {
        throw new Error(message);
    }
    return text;
}
function optionalString(value) {
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
        return "";
    }
    const text = String(value).trim();
    return text === "<nil>" ? "" : text;
}
function asRecord(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return undefined;
    }
    return value;
}
function compactObject(value) {
    return Object.fromEntries(Object.entries(value).filter((entry) => entry[1] !== undefined && entry[1] !== ""));
}
