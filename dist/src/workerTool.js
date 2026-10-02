import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { executeWorker } from './workers/executeWorker.js';
export function normalizeProductCapability(value) {
    if (value === undefined)
        return undefined;
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('Invalid product capability');
    const v = value;
    if (v.schemaVersion !== 1 || !['chat', 'work', 'code'].includes(String(v.mode)) || Object.keys(v).some(k => !['schemaVersion', 'mode', 'model'].includes(k)))
        throw new Error('Invalid product capability v1');
    if (v.model !== undefined && (typeof v.model !== 'string' || !v.model.startsWith('xworkmate/') || !v.model.slice('xworkmate/'.length).trim() || v.model !== v.model.trim() || v.model.length > 256 || /[\r\n\0]/.test(v.model)))
        throw new Error('Invalid product model');
    return { schemaVersion: 1, mode: v.mode, ...(v.model ? { model: String(v.model).trim() } : {}) };
}
// No pathname in model/tool arguments can become a host filesystem grant.
export async function writeWorkerFiles(root, files) {
    if (files.length > 64)
        throw new Error('Worker artifact count exceeded');
    const realRoot = await fs.realpath(root);
    let total = 0;
    const decoded = files.map(file => {
        if (!file.relativePath || path.isAbsolute(file.relativePath) || file.relativePath.includes('\\') || file.relativePath.split('/').some(s => !s || s === '.' || s === '..' || s.startsWith('.') || /^(node_modules|credentials|secrets)$/i.test(s)) || /\.(pem|key|p12)$/i.test(file.relativePath))
            throw new Error('Invalid worker artifact path');
        const bytes = Buffer.from(file.contentBase64, 'base64');
        total += bytes.length;
        if (total > 32 * 1024 * 1024 || bytes.length !== file.size || createHash('sha256').update(bytes).digest('hex') !== file.sha256)
            throw new Error('Invalid worker artifact integrity or size');
        return { file, bytes };
    });
    const output = [];
    for (const { file, bytes } of decoded) {
        const relative = path.join('artifacts', 'worker', file.relativePath);
        const target = path.join(realRoot, relative);
        let directory = realRoot;
        for (const segment of path.relative(realRoot, path.dirname(target)).split(path.sep)) {
            directory = path.join(directory, segment);
            try {
                await fs.mkdir(directory, { mode: 0o700 });
            }
            catch (error) {
                if (error.code !== 'EEXIST')
                    throw error;
            }
            const st = await fs.lstat(directory);
            if (!st.isDirectory() || st.isSymbolicLink())
                throw new Error('Unsafe worker artifact directory');
        }
        // Exclusive creation prevents overwriting a user file or following a link.
        await fs.writeFile(target, bytes, { flag: 'wx', mode: 0o600 });
        output.push(relative);
    }
    return output;
}
export function createWorkerTool(api, ctx, toolBindings, execute = executeWorker) {
    return {
        name: 'xworkmate_worker', label: 'XWorkmate isolated worker',
        description: 'Run one authorized Work or Code task through a deployed DSH ACP or OpenCode v2 OS worker. Waits for the result; returns real text and scoped artifact references. It never installs engines or accepts host commands/paths. SDK batch is separate and has no interactive cancel.',
        parameters: { type: 'object', additionalProperties: false, properties: { engine: { type: 'string', enum: ['dsh-acp', 'dsh-sdk', 'opencode-v2'] }, prompt: { type: 'string' } }, required: ['engine', 'prompt'] },
        async execute(toolCallId, params, signal) {
            const binding = toolBindings.get(toolCallId);
            toolBindings.delete(toolCallId);
            if (!binding || binding.sessionKey !== ctx.sessionKey)
                throw new Error('Worker requires host-owned tool/run binding');
            if (Object.keys(params).some(k => !['engine', 'prompt'].includes(k)))
                throw new Error('Worker arguments cannot contain commands, models or paths');
            const engine = params.engine;
            const mode = binding.capability?.mode;
            if ((mode === 'code' && engine !== 'opencode-v2') || (mode === 'work' && engine !== 'dsh-acp') || mode === 'chat')
                throw new Error('Worker engine does not match the selected product capability');
            const runtime = api.pluginConfig?.workerRuntime;
            if (!runtime)
                throw new Error('OS worker runtime is not configured');
            const workerRunId = randomUUID();
            const selected = binding.capability?.model;
            // Product catalog model refs may carry the unified provider prefix.
            if (selected && !selected.startsWith('xworkmate/'))
                throw new Error('Product model requires unified xworkmate provider');
            const model = selected?.slice('xworkmate/'.length);
            const result = await execute({ engine, prompt: String(params.prompt ?? ''), runId: workerRunId, workspaceDir: binding.artifactDirectory, ...(model ? { model } : {}), signal, config: runtime });
            if (signal?.aborted)
                throw new Error('Worker cancelled before artifact publication');
            const exported = await writeWorkerFiles(binding.artifactDirectory, (result.files ?? []).map(file => ({ ...file, relativePath: workerRunId + "/" + file.relativePath })));
            const text = [result.text, ...exported.map(name => `Artifact: ${name}`)].filter(Boolean).join('\n');
            return { content: [{ type: 'text', text }], details: { engine: result.engine, parentRunId: binding.runId, workerRunId, sessionId: result.sessionId, artifacts: exported } };
        },
    };
}
