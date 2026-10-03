import type { AnyAgentTool, OpenClawPluginApi } from 'openclaw/plugin-sdk/core';
import { executeWorker, type WorkerFile } from './workers/executeWorker.js';
export type ProductCapability = {
    schemaVersion: 1;
    mode: 'chat' | 'work' | 'code';
    model?: string;
};
export type PreparedWorkerRun = {
    sessionKey: string;
    runId: string;
    artifactDirectory: string;
    capability?: ProductCapability;
};
export declare function normalizeProductCapability(value: unknown): ProductCapability | undefined;
export declare function writeWorkerFiles(root: string, files: WorkerFile[]): Promise<string[]>;
type Context = {
    sessionKey?: string;
};
export declare function createWorkerTool(api: OpenClawPluginApi, ctx: Context, toolBindings: Map<string, PreparedWorkerRun>, execute?: typeof executeWorker): AnyAgentTool;
export {};
