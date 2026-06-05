import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
type XWorkmateTaskRecord = {
    taskId: string;
    runtime: "acp";
    taskKind: "xworkmate-openclaw";
    requesterSessionKey: string;
    ownerKey: string;
    scopeKind: "session";
    runId: string;
    label: string;
    task: string;
    status: "queued" | "running" | "succeeded" | "failed" | "timed_out" | "cancelled" | "lost";
    deliveryStatus: "pending" | "delivered" | "session_queued" | "failed" | "parent_missing" | "not_applicable";
    notifyPolicy: "done_only" | "state_changes" | "silent";
    createdAt: number;
    startedAt?: number;
    endedAt?: number;
    lastEventAt?: number;
    error?: string;
    progressSummary?: string;
    terminalSummary?: string;
    terminalOutcome?: "succeeded" | "blocked";
};
type XWorkmateSessionMapping = {
    appSessionKey: string;
    openClawSessionKey: string;
    appThreadId?: string;
    sessionId?: string;
    runId: string;
    artifactScope?: string;
    expectedArtifactDirs?: string[];
};
export type XWorkmateTaskStore = {
    records: Map<string, XWorkmateTaskRecord>;
    sessionMappingsByAppKey: Map<string, XWorkmateSessionMapping>;
    sessionMappingsByOpenClawKey: Map<string, XWorkmateSessionMapping>;
};
export declare function createXWorkmateTaskStore(): XWorkmateTaskStore;
export declare function registerXWorkmateSessionExtension(api: OpenClawPluginApi): void;
export declare function recordXWorkmateSessionMapping(input: {
    api: OpenClawPluginApi;
    taskStore: XWorkmateTaskStore;
    params: Record<string, unknown>;
    artifactScope?: string;
}): Promise<void>;
export declare function registerXWorkmateDetachedTaskRuntime(api: OpenClawPluginApi, taskStore: XWorkmateTaskStore): void;
export declare function getXWorkmateTaskSnapshot(input: {
    api: OpenClawPluginApi;
    taskStore: XWorkmateTaskStore;
    params: Record<string, unknown>;
}): Promise<Record<string, unknown>>;
export declare function createOrUpdateXWorkmateTaskRecord(input: XWorkmateTaskStore, options: {
    params: Record<string, unknown>;
    status: XWorkmateTaskRecord["status"];
    progressSummary?: string;
}): XWorkmateTaskRecord;
export {};
