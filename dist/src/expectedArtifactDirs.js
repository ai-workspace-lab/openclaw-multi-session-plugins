function optionalString(value) {
    return typeof value === "string" ? value.trim() : "";
}
function safeExpectedArtifactDir(value) {
    const relativePath = optionalString(value);
    if (!relativePath) {
        return "";
    }
    if (/^[A-Za-z]:[\\/]/u.test(relativePath) || relativePath.startsWith("/") || relativePath.includes("\0")) {
        throw new Error("expectedArtifactDir must stay inside the workspace");
    }
    const normalized = relativePath.split(/[\\/]/).filter(Boolean).join("/");
    if (!normalized || normalized.split("/").some((part) => part === ".." || part === ".")) {
        throw new Error("expectedArtifactDir must stay inside the workspace");
    }
    return normalized.endsWith("/") ? normalized : `${normalized}/`;
}
export function normalizeExpectedArtifactDirs(value) {
    if (!Array.isArray(value)) {
        return [];
    }
    const seen = new Set();
    const result = [];
    for (const entry of value) {
        const normalized = safeExpectedArtifactDir(entry);
        if (!normalized || seen.has(normalized)) {
            continue;
        }
        seen.add(normalized);
        result.push(normalized);
    }
    return result;
}
