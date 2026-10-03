import { type ChildProcessWithoutNullStreams } from 'node:child_process';
export type WorkerEngine = 'dsh-acp' | 'dsh-sdk' | 'opencode-v2';
export interface WorkerConfig {
    command: string[];
    stateRoot: string;
    modelService: {
        baseUrl: string;
        model: string;
        credentialEnvFile: string;
    };
    opencode: {
        baseUrl: string;
        authEnvFile: string;
        permissions?: {
            action: 'read' | 'edit' | 'shell';
            resource: string;
            effect: 'allow' | 'deny';
        }[];
    };
    timeoutMs?: number;
    maxOutputBytes?: number;
    collectArtifacts?: boolean;
}
export interface WorkerInput {
    engine: WorkerEngine;
    prompt: string;
    runId: string;
    workspaceDir: string;
    model?: string;
    signal?: AbortSignal;
    config: WorkerConfig;
}
export interface WorkerFile {
    relativePath: string;
    contentBase64: string;
    sha256: string;
    size: number;
}
export interface WorkerResult {
    text: string;
    engine: WorkerEngine;
    sessionId?: string;
    files?: WorkerFile[];
}
type Obj = Record<string, any>;
export declare function validateWorkerInput(input: WorkerInput): {
    model: string;
    timeoutMs: number;
    maxOutputBytes: number;
    cwd: string;
};
/** Strict bounded NDJSON RPC peer; stdout is protocol-only, stderr never returned. */
export declare class WorkerRpc {
    readonly child: ChildProcessWithoutNullStreams;
    readonly limit: number;
    private next;
    private pending;
    private buffer;
    private bytes;
    private stderrBytes;
    private failure?;
    readonly failed: Promise<never>;
    private rejectFailure;
    private timer;
    onNotification: (method: string, params: Obj) => void;
    constructor(child: ChildProcessWithoutNullStreams, timeoutMs: number, limit: number);
    request(method: string, params?: Obj): Promise<any>;
    notify(method: string, params: Obj): void;
    private send;
    private ingest;
    fail(error: Error): void;
    dispose(): Promise<void>;
    close(): void;
}
export declare function executeWorker(input: WorkerInput): Promise<WorkerResult>;
export {};
