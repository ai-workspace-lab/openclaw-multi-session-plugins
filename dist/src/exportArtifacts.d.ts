type XWorkmateArtifact = {
    relativePath: string;
    label: string;
    contentType: string;
    sizeBytes: number;
    sha256: string;
    artifactRef: string;
    artifactScope?: string;
    scopeKind?: XWorkmateArtifactScopeKind;
    encoding?: "base64";
    content?: string;
};
type XWorkmateArtifactScopeKind = "task";
type XWorkmateArtifactExport = {
    runId: string;
    sessionKey: string;
    remoteWorkingDirectory: string;
    remoteWorkspaceRefKind: "remotePath";
    artifactScope?: string;
    scopeKind: XWorkmateArtifactScopeKind;
    artifacts: XWorkmateArtifact[];
    warnings: string[];
    expectedArtifactDirs: string[];
    expectedArtifactDirStatus: XWorkmateExpectedArtifactDirStatus[];
    constraintSatisfied: boolean;
    missingRequiredExtensions: string[];
};
type XWorkmateArtifactPrepare = {
    runId: string;
    sessionKey: string;
    remoteWorkingDirectory: string;
    remoteWorkspaceRefKind: "remotePath";
    artifactScope: string;
    scopeKind: "task";
    artifactDirectory: string;
    relativeArtifactDirectory: string;
    warnings: string[];
    expectedArtifactDirs: string[];
    expectedArtifactDirStatus: XWorkmateExpectedArtifactDirStatus[];
};
type XWorkmateExpectedArtifactDirStatus = {
    relativePath: string;
    exists: boolean;
};
type XWorkmateArtifactSnapshot = {
    runId: string;
    sessionKey: string;
    remoteWorkingDirectory: string;
    remoteWorkspaceRefKind: "remotePath";
    artifactScope: string;
    scopeKind: "task";
    artifactDirectory: string;
    snapshotDirectory: string;
    copiedFiles: string[];
    warnings: string[];
};
type ExportInput = {
    params: Record<string, unknown>;
    config?: unknown;
    pluginConfig?: Record<string, unknown>;
};
type ReadInput = {
    params: Record<string, unknown>;
    config?: unknown;
    pluginConfig?: Record<string, unknown>;
};
export declare function prepareXWorkmateArtifacts(input: ExportInput): Promise<XWorkmateArtifactPrepare>;
export declare function collectAndSnapshotXWorkmateArtifacts(input: ExportInput): Promise<XWorkmateArtifactSnapshot>;
export declare function exportXWorkmateArtifacts(input: ExportInput): Promise<XWorkmateArtifactExport>;
export declare function readXWorkmateArtifact(input: ReadInput): Promise<XWorkmateArtifactExport>;
export declare function formatArtifactManifestMarkdown(input: {
    remoteWorkingDirectory: string;
    artifactScope?: string;
    scopeKind?: XWorkmateArtifactScopeKind;
    artifacts: XWorkmateArtifact[];
    warnings: string[];
}): string;
export {};
