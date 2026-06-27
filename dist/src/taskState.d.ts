import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
export declare const XWORKMATE_SESSION_EXTENSION_NAMESPACE = "xworkmate.sessionMapping";
export declare const XWORKMATE_TASK_RUNS_EXTENSION_NAMESPACE = "xworkmate.taskRuns";
export type XWorkmateTaskMetadataV1 = {
    schemaVersion: 1;
    appThreadKey: string;
    openclawSessionKey?: string;
    expectedArtifactDirs: string[];
    requestId?: string;
    externalTaskId?: string;
    createdAt: string;
};
export type XWorkmateSessionMappingSource = "session_start" | "bridge_prepare";
export type XWorkmateSessionMappingV1 = {
    schemaVersion: 1;
    appThreadKey: string;
    openclawSessionKey: string;
    expectedArtifactDirs: string[];
    createdAt: string;
    updatedAt: string;
    source: XWorkmateSessionMappingSource;
};
export type XWorkmateTaskLookupErrorCode = "mapping_not_found" | "task_not_found" | "no_native_task_record" | "conflict" | "invalid_lookup";
export type XWorkmateTaskLookupError = {
    ok: false;
    code: XWorkmateTaskLookupErrorCode;
    message: string;
    mapping?: XWorkmateSessionMappingV1;
    expectedArtifactDirs?: string[];
};
export type XWorkmateRecordedTaskRunV1 = {
    schemaVersion: 1;
    runId: string;
    status: "running" | "completed" | "failed";
    success: boolean;
    startedAt: string;
    updatedAt: string;
    completedAt?: string;
    output?: string;
    error?: string;
};
export declare function registerXWorkmateSessionExtension(api: OpenClawPluginApi): void;
export declare function recordXWorkmateSessionMapping(input: {
    api: OpenClawPluginApi;
    params: Record<string, unknown>;
    artifactScope?: string;
    source?: XWorkmateSessionMappingSource;
}): Promise<XWorkmateSessionMappingV1>;
export declare function recordXWorkmateTaskRunStarted(input: {
    api: OpenClawPluginApi;
    openclawSessionKey: string;
    runId: string;
}): Promise<XWorkmateRecordedTaskRunV1>;
export declare function recordXWorkmateTaskRunTerminal(input: {
    api: OpenClawPluginApi;
    openclawSessionKey: string;
    runId: string;
    success: boolean;
    output?: unknown;
    error?: unknown;
}): Promise<XWorkmateRecordedTaskRunV1>;
export declare function getXWorkmateTaskSnapshot(input: {
    api: OpenClawPluginApi;
    params: Record<string, unknown>;
}): Promise<Record<string, unknown>>;
