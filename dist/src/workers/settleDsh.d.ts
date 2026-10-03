import type { WorkerInput } from './executeWorker.js';
/** Wrapper exit alone is insufficient: the root-owned launcher confirms cgroup
 * inactivity and prevents a late start of this exact run via its cancel marker.
 * Cleanup intentionally ignores the caller's already aborted signal.
 */
export declare function settleDshUnit(input: WorkerInput): Promise<void>;
