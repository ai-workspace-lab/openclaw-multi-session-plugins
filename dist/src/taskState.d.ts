import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
export declare const XWORKMATE_PLUGIN_ID = "openclaw-multi-session-plugins";
export declare const XWORKMATE_SESSION_EXTENSION_NAMESPACE = "xworkmate.sessionMapping";
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
export type XWorkmateTaskStore = Record<string, never>;
export declare function createXWorkmateTaskStore(): XWorkmateTaskStore;
export declare function registerXWorkmateSessionExtension(api: OpenClawPluginApi): void;
export declare function registerXWorkmateDetachedTaskRuntime(_api: OpenClawPluginApi, _taskStore: XWorkmateTaskStore): void;
export declare function recordXWorkmateSessionMapping(input: {
    api: OpenClawPluginApi;
    taskStore?: XWorkmateTaskStore;
    params: Record<string, unknown>;
    artifactScope?: string;
    source?: XWorkmateSessionMappingSource;
}): Promise<XWorkmateSessionMappingV1>;
export declare function normalizeXWorkmateTaskMetadataV1(input: Record<string, unknown>): XWorkmateTaskMetadataV1;
export declare function normalizeExpectedArtifactDirs(value: unknown): string[];
export declare function upsertXWorkmateSessionMapping(api: OpenClawPluginApi, input: {
    metadata: XWorkmateTaskMetadataV1;
    openclawSessionKey: string;
    source: XWorkmateSessionMappingSource;
}): Promise<XWorkmateSessionMappingV1>;
export declare function readXWorkmateSessionMapping(api: OpenClawPluginApi, lookup: {
    appThreadKey?: string;
    openclawSessionKey?: string;
}): Promise<XWorkmateSessionMappingV1 | undefined>;
export declare function getXWorkmateTaskSnapshot(input: {
    api: OpenClawPluginApi;
    taskStore?: XWorkmateTaskStore;
    params: Record<string, unknown>;
}): Promise<Record<string, unknown>>;
