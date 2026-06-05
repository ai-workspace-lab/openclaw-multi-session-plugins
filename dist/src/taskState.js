import { exportXWorkmateArtifacts } from "./exportArtifacts.js";
const XWORKMATE_SESSION_EXTENSION_NAMESPACE = "xworkmate";
const XWORKMATE_PLUGIN_ID = "openclaw-multi-session-plugins";
export function createXWorkmateTaskStore() {
    return {
        records: new Map(),
        sessionMappingsByAppKey: new Map(),
        sessionMappingsByOpenClawKey: new Map(),
    };
}
export function registerXWorkmateSessionExtension(api) {
    const registerExtension = api.session?.state?.registerSessionExtension ?? api.registerSessionExtension;
    if (typeof registerExtension !== "function") {
        return;
    }
    registerExtension({
        namespace: XWORKMATE_SESSION_EXTENSION_NAMESPACE,
        description: "XWorkmate OpenClaw/App session key mapping for artifact and task recovery.",
        sessionEntrySlotKey: "xworkmate",
        project: (ctx) => {
            const state = asRecord(ctx.state) ?? {};
            const appSessionKey = optionalString(state.appSessionKey) ||
                optionalString(state.appThreadId) ||
                optionalString(state.threadId) ||
                appSessionKeyFromOpenClawSessionKey(ctx.sessionKey);
            const openClawSessionKey = optionalString(state.openClawSessionKey) || ctx.sessionKey;
            return {
                ...state,
                appSessionKey,
                openClawSessionKey,
                sessionId: optionalString(state.sessionId) || optionalString(ctx.sessionId),
            };
        },
    });
}
export async function recordXWorkmateSessionMapping(input) {
    const appSessionKey = requiredString(input.params.sessionKey || input.params.appSessionKey, "sessionKey required");
    const runId = requiredString(input.params.runId, "runId required");
    const openClawSessionKey = optionalString(input.params.openClawSessionKey) ||
        optionalString(input.params.openClawSessionId) ||
        agentMainSessionKeyFor(appSessionKey);
    const expectedArtifactDirs = stringList(input.params.expectedArtifactDirs);
    const mapping = compactObject({
        appSessionKey,
        openClawSessionKey,
        appThreadId: optionalString(input.params.threadId) || appSessionKey,
        sessionId: optionalString(input.params.sessionId),
        runId,
        artifactScope: input.artifactScope || optionalString(input.params.artifactScope),
        expectedArtifactDirs: expectedArtifactDirs.length > 0 ? expectedArtifactDirs : undefined,
    });
    input.taskStore.sessionMappingsByAppKey.set(appSessionKey, mapping);
    input.taskStore.sessionMappingsByOpenClawKey.set(openClawSessionKey, mapping);
    const patchSessionExtension = resolvePatchSessionExtension(input.api);
    if (!patchSessionExtension) {
        // Legacy fallback owner: this plugin. Scope: tests and OpenClaw hosts that do not expose
        // session extension patching yet. Exit: remove this map once 2026.6.1+ hosts expose the patch
        // method on the public plugin API in all supported deployments.
        return;
    }
    await patchSessionExtension({
        key: openClawSessionKey,
        sessionKey: openClawSessionKey,
        pluginId: XWORKMATE_PLUGIN_ID,
        namespace: XWORKMATE_SESSION_EXTENSION_NAMESPACE,
        value: mapping,
    });
}
export function registerXWorkmateDetachedTaskRuntime(api, taskStore) {
    const registerRuntime = api.registerDetachedTaskRuntime;
    if (typeof registerRuntime !== "function") {
        return;
    }
    registerRuntime({
        createQueuedTaskRun: (params) => createOrUpdateXWorkmateTaskRecord(taskStore, { params, status: "queued" }),
        createRunningTaskRun: (params) => createOrUpdateXWorkmateTaskRecord(taskStore, { params, status: "running" }),
        startTaskRunByRunId: (params) => updateXWorkmateTaskRecordsByRunId(taskStore, params, { status: "running", startedAt: Date.now() }),
        recordTaskRunProgressByRunId: (params) => updateXWorkmateTaskRecordsByRunId(taskStore, params, {
            lastEventAt: Date.now(),
            progressSummary: optionalString(params.progressSummary) || optionalString(params.eventSummary),
        }),
        finalizeTaskRunByRunId: (params) => updateXWorkmateTaskRecordsByRunId(taskStore, params, terminalPatch(params)),
        completeTaskRunByRunId: (params) => updateXWorkmateTaskRecordsByRunId(taskStore, params, {
            status: "succeeded",
            endedAt: numberOrNow(params.endedAt),
            lastEventAt: numberOrNow(params.lastEventAt),
            terminalSummary: optionalString(params.terminalSummary) || optionalString(params.progressSummary),
            terminalOutcome: "succeeded",
        }),
        failTaskRunByRunId: (params) => updateXWorkmateTaskRecordsByRunId(taskStore, params, {
            status: taskStatusFrom(params.status, "failed"),
            endedAt: numberOrNow(params.endedAt),
            lastEventAt: numberOrNow(params.lastEventAt),
            error: optionalString(params.error),
            terminalSummary: optionalString(params.terminalSummary) || optionalString(params.progressSummary),
        }),
        setDetachedTaskDeliveryStatusByRunId: (params) => updateXWorkmateTaskRecordsByRunId(taskStore, params, {
            deliveryStatus: deliveryStatusFrom(params.deliveryStatus, "delivered"),
            error: optionalString(params.error),
        }),
        cancelDetachedTaskRunById: async (params) => {
            const taskId = optionalString(params.taskId);
            const record = taskId ? findXWorkmateTaskByTaskId(taskStore, taskId) : undefined;
            if (!record) {
                return { found: false, cancelled: false };
            }
            record.status = "cancelled";
            record.endedAt = Date.now();
            record.lastEventAt = record.endedAt;
            return { found: true, cancelled: true, reason: optionalString(params.reason), task: record };
        },
    });
}
export async function getXWorkmateTaskSnapshot(input) {
    const sessionKey = requiredString(input.params.sessionKey, "sessionKey required");
    const runId = requiredString(input.params.runId, "runId required");
    const mapping = resolveSessionMapping(input.taskStore, input.params, sessionKey);
    const openClawSessionKey = mapping?.openClawSessionKey || optionalString(input.params.openClawSessionKey) || agentMainSessionKeyFor(sessionKey);
    const appSessionKey = mapping?.appSessionKey || sessionKey;
    const nativeTask = resolveNativeTask(input.api, openClawSessionKey, runId) || resolveNativeTask(input.api, sessionKey, runId);
    const storedTask = findXWorkmateTask(input.taskStore, sessionKey, runId);
    const exported = await exportXWorkmateArtifacts({
        params: input.params,
        config: input.api.config,
        pluginConfig: input.api.pluginConfig,
    });
    const task = nativeTask || storedTask;
    const taskStatus = normalizeTaskStatus(optionalString(task.status), exported.artifacts.length > 0);
    if (storedTask && taskStatus === "succeeded" && storedTask.status !== "succeeded") {
        storedTask.status = "succeeded";
        storedTask.endedAt = Date.now();
        storedTask.lastEventAt = storedTask.endedAt;
        storedTask.terminalOutcome = "succeeded";
    }
    return {
        success: true,
        status: appStatusFromTaskStatus(taskStatus),
        taskStatus,
        mode: "gateway-chat",
        sessionKey,
        openClawSessionKey,
        appSessionKey,
        runId,
        task,
        artifactScope: exported.artifactScope,
        remoteWorkingDirectory: exported.remoteWorkingDirectory,
        remoteWorkspaceRefKind: exported.remoteWorkspaceRefKind,
        scopeKind: exported.scopeKind,
        artifacts: exported.artifacts,
        warnings: exported.warnings,
        artifactCount: exported.artifacts.length,
    };
}
export function createOrUpdateXWorkmateTaskRecord(input, options) {
    const sessionKey = requiredString(options.params.sessionKey || options.params.requesterSessionKey, "sessionKey required");
    const runId = requiredString(options.params.runId, "runId required");
    const key = taskRecordKey(sessionKey, runId);
    const now = Date.now();
    const existing = input.records.get(key);
    if (existing) {
        existing.status = options.status;
        existing.lastEventAt = now;
        if (options.status === "running" && !existing.startedAt) {
            existing.startedAt = now;
        }
        if (options.progressSummary) {
            existing.progressSummary = options.progressSummary;
        }
        return existing;
    }
    const record = {
        taskId: `xworkmate:${safeTaskIdSegment(sessionKey)}:${safeTaskIdSegment(runId)}`,
        runtime: "acp",
        taskKind: "xworkmate-openclaw",
        requesterSessionKey: optionalString(options.params.openClawSessionKey) || agentMainSessionKeyFor(sessionKey),
        ownerKey: sessionKey,
        scopeKind: "session",
        runId,
        label: optionalString(options.params.label) || "XWorkmate OpenClaw task",
        task: optionalString(options.params.taskPrompt) || optionalString(options.params.task) || "XWorkmate OpenClaw task",
        status: options.status,
        deliveryStatus: "pending",
        notifyPolicy: "state_changes",
        createdAt: now,
        startedAt: options.status === "running" ? now : undefined,
        lastEventAt: now,
        progressSummary: options.progressSummary,
    };
    input.records.set(key, record);
    return record;
}
function updateXWorkmateTaskRecordsByRunId(input, params, patch) {
    const runId = optionalString(params.runId);
    const sessionKey = optionalString(params.sessionKey || params.requesterSessionKey);
    const records = [...input.records.values()].filter((record) => {
        if (runId && record.runId !== runId) {
            return false;
        }
        if (sessionKey && record.ownerKey !== sessionKey && record.requesterSessionKey !== sessionKey) {
            return false;
        }
        return true;
    });
    for (const record of records) {
        Object.assign(record, compactObject(patch));
    }
    return records;
}
function resolveNativeTask(api, sessionKey, runId) {
    try {
        const bound = api.runtime?.tasks?.runs?.bindSession?.({ sessionKey });
        const resolved = bound?.resolve?.(runId) || bound?.get?.(runId);
        return asRecord(resolved);
    }
    catch (error) {
        api.logger?.warn?.(`xworkmate task native registry lookup failed: sessionKey=${sessionKey} runId=${runId} error=${String(error)}`);
        return undefined;
    }
}
function resolveSessionMapping(input, params, sessionKey) {
    const explicitOpenClawKey = optionalString(params.openClawSessionKey);
    if (explicitOpenClawKey) {
        const byOpenClaw = input.sessionMappingsByOpenClawKey.get(explicitOpenClawKey);
        if (byOpenClaw) {
            return byOpenClaw;
        }
    }
    return input.sessionMappingsByAppKey.get(sessionKey) || input.sessionMappingsByOpenClawKey.get(sessionKey);
}
function findXWorkmateTask(input, sessionKey, runId) {
    return input.records.get(taskRecordKey(sessionKey, runId));
}
function findXWorkmateTaskByTaskId(input, taskId) {
    return [...input.records.values()].find((record) => record.taskId === taskId);
}
function taskRecordKey(sessionKey, runId) {
    return `${sessionKey}\u0000${runId}`;
}
function appSessionKeyFromOpenClawSessionKey(sessionKey) {
    return sessionKey.startsWith("agent:main:") ? sessionKey.slice("agent:main:".length) : sessionKey;
}
function agentMainSessionKeyFor(sessionKey) {
    return sessionKey.startsWith("agent:") ? sessionKey : `agent:main:${sessionKey}`;
}
function terminalPatch(params) {
    const status = taskStatusFrom(params.status, "succeeded");
    return {
        status,
        endedAt: numberOrNow(params.endedAt),
        lastEventAt: numberOrNow(params.lastEventAt),
        error: optionalString(params.error),
        progressSummary: optionalString(params.progressSummary),
        terminalSummary: optionalString(params.terminalSummary),
        terminalOutcome: status === "succeeded" ? "succeeded" : "blocked",
    };
}
function normalizeTaskStatus(status, hasArtifacts) {
    const normalized = taskStatusFrom(status, hasArtifacts ? "succeeded" : "running");
    if (normalized === "running" && hasArtifacts) {
        return "succeeded";
    }
    return normalized;
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
function taskStatusFrom(value, fallback) {
    const status = optionalString(value);
    if (status === "queued" ||
        status === "running" ||
        status === "succeeded" ||
        status === "failed" ||
        status === "timed_out" ||
        status === "cancelled" ||
        status === "lost") {
        return status;
    }
    return fallback;
}
function deliveryStatusFrom(value, fallback) {
    const status = optionalString(value);
    if (status === "pending" ||
        status === "delivered" ||
        status === "session_queued" ||
        status === "failed" ||
        status === "parent_missing" ||
        status === "not_applicable") {
        return status;
    }
    return fallback;
}
function resolvePatchSessionExtension(api) {
    const stateApi = (api.session?.state ?? {});
    const apiRecord = api;
    const candidate = stateApi.patchSessionExtension || apiRecord.patchSessionExtension;
    return typeof candidate === "function"
        ? candidate
        : undefined;
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
function stringList(value) {
    if (!Array.isArray(value)) {
        return [];
    }
    const seen = new Set();
    const result = [];
    for (const entry of value) {
        const text = optionalString(entry);
        if (!text || seen.has(text)) {
            continue;
        }
        seen.add(text);
        result.push(text);
    }
    return result;
}
function numberOrNow(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : Date.now();
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
function safeTaskIdSegment(value) {
    return value.replace(/[^A-Za-z0-9._:-]+/g, "_");
}
