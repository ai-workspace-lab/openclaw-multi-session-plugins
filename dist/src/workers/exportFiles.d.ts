import type { WorkerInput, WorkerFile } from './executeWorker.js';
/** The root-owned launcher exports ONLY workspace/output after its unit is idle. */
export declare function exportWorkerFiles(input: WorkerInput): Promise<WorkerFile[]>;
export declare function validateWorkerManifest(raw: string, engine: string, runId: string): WorkerFile[];
