import { type XWorkmateArtifactExport } from "./exportArtifacts.js";
type BridgeAgentInput = {
    params: Record<string, unknown>;
    config?: unknown;
    pluginConfig?: Record<string, unknown>;
};
type BridgeAgentRun = XWorkmateArtifactExport & {
    bridgeResult: Record<string, unknown>;
};
export declare function runXWorkmateBridgeAgents(input: BridgeAgentInput): Promise<BridgeAgentRun>;
export {};
