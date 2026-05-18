import fs from "node:fs/promises";
import path from "node:path";
import { exportXWorkmateArtifacts, prepareXWorkmateArtifacts, } from "./exportArtifacts.js";
export async function runXWorkmateBridgeAgents(input) {
    const params = input.params ?? {};
    const pluginConfig = input.pluginConfig ?? {};
    const sessionKey = requiredString(params.sessionKey, "sessionKey required");
    const runId = requiredString(params.runId, "runId required");
    const taskPrompt = requiredString(params.taskPrompt, "taskPrompt required");
    const bridgeUrl = bridgeRpcUrl(pluginConfig);
    const bridgeToken = bridgeAuthToken(pluginConfig);
    if (!bridgeToken) {
        throw new Error("bridgeToken required");
    }
    const prepared = await prepareXWorkmateArtifacts({
        params: { sessionKey, runId, workspaceDir: params.workspaceDir },
        config: input.config,
        pluginConfig,
    });
    const orchestrationMode = optionalString(params.mode) || optionalString(params.orchestrationMode) || "sequence";
    const participants = safeStringList(params.participants);
    const steps = safeSteps(params.steps, participants.length > 0);
    if (steps.length === 0 && participants.length === 0) {
        throw new Error("steps or participants required");
    }
    const routing = {
        orchestrationMode,
        steps,
    };
    if (participants.length > 0) {
        routing.participants = participants;
    }
    const maxTurns = positiveInteger(params.maxTurns, 0);
    if (maxTurns > 0) {
        routing.maxTurns = maxTurns;
    }
    const stopConditions = safeStringList(params.stopConditions);
    if (stopConditions.length > 0) {
        routing.stopConditions = stopConditions;
    }
    const bridgeResult = await callBridgeRPC({
        bridgeUrl,
        bridgeToken,
        timeoutMs: positiveInteger(params.timeoutMs, positiveInteger(pluginConfig.bridgeTimeoutMs, 600_000)),
        body: {
            jsonrpc: "2.0",
            id: `openclaw-${Date.now()}`,
            method: "session.start",
            params: {
                sessionId: `openclaw:${sessionKey}`,
                threadId: sessionKey,
                taskPrompt,
                workingDirectory: prepared.artifactDirectory,
                multiAgent: true,
                mode: "multi-agent",
                routing,
            },
        },
    });
    await fs.mkdir(prepared.artifactDirectory, { recursive: true });
    await fs.writeFile(path.join(prepared.artifactDirectory, "multi-agent-result.json"), `${JSON.stringify(bridgeResult, null, 2)}\n`);
    await fs.writeFile(path.join(prepared.artifactDirectory, "multi-agent-result.md"), formatBridgeResultMarkdown(bridgeResult));
    const exported = await exportXWorkmateArtifacts({
        params: {
            sessionKey,
            runId,
            workspaceDir: params.workspaceDir,
            artifactScope: prepared.artifactScope,
            includeContent: false,
        },
        config: input.config,
        pluginConfig,
    });
    return { ...exported, bridgeResult };
}
async function callBridgeRPC(input) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), input.timeoutMs);
    try {
        const response = await fetch(input.bridgeUrl, {
            method: "POST",
            headers: {
                Authorization: bearer(input.bridgeToken),
                "Content-Type": "application/json",
                Accept: "application/json",
            },
            body: JSON.stringify(input.body),
            signal: controller.signal,
        });
        const text = await response.text();
        if (!response.ok) {
            throw new Error(`bridge request failed (${response.status}): ${text.trim()}`);
        }
        const decoded = JSON.parse(text);
        const error = asRecord(decoded.error);
        if (error) {
            throw new Error(optionalString(error.message) || "bridge rpc error");
        }
        const result = asRecord(decoded.result);
        if (!result) {
            throw new Error("bridge response missing result");
        }
        return result;
    }
    finally {
        clearTimeout(timer);
    }
}
function bridgeRpcUrl(pluginConfig) {
    const configured = optionalString(pluginConfig.bridgeUrl) || optionalString(process.env.XWORKMATE_BRIDGE_URL);
    if (!configured) {
        throw new Error("bridgeUrl required");
    }
    const trimmed = configured.replace(/\/+$/, "");
    if (trimmed.endsWith("/acp/rpc")) {
        return trimmed;
    }
    return `${trimmed}/acp/rpc`;
}
function bridgeAuthToken(pluginConfig) {
    return optionalString(pluginConfig.bridgeToken) || optionalString(process.env.XWORKMATE_BRIDGE_TOKEN);
}
function safeSteps(raw, allowEmpty) {
    if (!Array.isArray(raw)) {
        if (allowEmpty) {
            return [];
        }
        throw new Error("steps required");
    }
    return raw.map((item, index) => {
        const mapped = asRecord(item);
        if (!mapped) {
            throw new Error(`steps[${index}] must be an object`);
        }
        const providerId = optionalString(mapped.providerId) || optionalString(mapped.provider) || optionalString(mapped.agent);
        const prompt = optionalString(mapped.prompt) || optionalString(mapped.taskPrompt);
        if (!providerId) {
            throw new Error(`steps[${index}].providerId required`);
        }
        if (!prompt) {
            throw new Error(`steps[${index}].prompt required`);
        }
        return {
            providerId,
            prompt,
            ...(optionalString(mapped.outputAs) ? { outputAs: optionalString(mapped.outputAs) } : {}),
            ...(positiveInteger(mapped.timeoutMs, 0) > 0 ? { timeoutMs: positiveInteger(mapped.timeoutMs, 0) } : {}),
        };
    });
}
function safeStringList(raw) {
    if (!Array.isArray(raw)) {
        return [];
    }
    return raw.map((value) => optionalString(value)).filter((value) => value.length > 0);
}
function formatBridgeResultMarkdown(result) {
    const lines = ["# Multi-Agent Result", ""];
    lines.push(`- Status: ${optionalString(result.status) || "unknown"}`);
    lines.push(`- Mode: ${optionalString(result.orchestrationMode) || optionalString(result.mode) || "multi-agent"}`);
    const summary = optionalString(result.summary) || optionalString(result.output) || optionalString(result.message);
    if (summary) {
        lines.push("", "## Summary", "", summary);
    }
    const steps = Array.isArray(result.steps) ? result.steps : [];
    if (steps.length > 0) {
        lines.push("", "## Steps", "");
        for (const item of steps) {
            const step = asRecord(item) ?? {};
            lines.push(`- ${optionalString(step.providerId) || "unknown"}: ${optionalString(step.status) || "unknown"}${optionalString(step.error) ? ` (${optionalString(step.error)})` : ""}`);
        }
    }
    lines.push("");
    return `${lines.join("\n")}\n`;
}
function bearer(token) {
    return token.toLowerCase().startsWith("bearer ") ? token : `Bearer ${token}`;
}
function requiredString(value, message) {
    const text = optionalString(value);
    if (!text) {
        throw new Error(message);
    }
    return text;
}
function optionalString(value) {
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
        return "";
    }
    const text = String(value).trim();
    return text === "<nil>" ? "" : text;
}
function positiveInteger(value, fallback) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return fallback;
    }
    return Math.floor(parsed);
}
function asRecord(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return undefined;
    }
    return value;
}
