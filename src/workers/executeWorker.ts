/** Pinned protocols: DSH 639ed015 (ACP/SDK stdio), OpenCode 35a41b5d (v2 /api).
 * Each invocation owns one disposable runtime/session. Permission requests are denied.
 * Cancellation stops execution; it never promises filesystem rollback.
 */
import { openCodeFiles } from './opencodeFiles.js';
import { exportWorkerFiles } from './exportFiles.js';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

export type WorkerEngine = 'dsh-acp' | 'dsh-sdk' | 'opencode-v2';
export interface WorkerConfig {
 command: string[];
 stateRoot: string;
 modelService: { baseUrl: string; model: string; credentialEnvFile: string };
 opencode: { baseUrl: string; authEnvFile: string; permissions?: { action: 'read' | 'edit' | 'shell'; resource: string; effect: 'allow' | 'deny' }[] };
 timeoutMs?: number;
 maxOutputBytes?: number;
 collectArtifacts?: boolean;
}
export interface WorkerInput { engine: WorkerEngine; prompt: string; runId: string; workspaceDir: string; model?: string; signal?: AbortSignal; config: WorkerConfig }
export interface WorkerFile { relativePath: string; contentBase64: string; sha256: string; size: number }
export interface WorkerResult { text: string; engine: WorkerEngine; sessionId?: string; files?: WorkerFile[] }
type Obj = Record<string, any>;
const obj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const abortError = () => new Error('Worker aborted; filesystem rollback is not supported');
export function validateWorkerInput(input: WorkerInput) {
 if (!['dsh-acp', 'dsh-sdk', 'opencode-v2'].includes(input.engine)) throw new Error('Unsupported worker engine');
 if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(input.runId)) throw new Error('Worker requires a canonical UUID');
 if (JSON.stringify(input.config.command) !== JSON.stringify(['/usr/bin/sudo', '-n', '/usr/local/libexec/xworkmate-worker-launch'])) throw new Error('Invalid worker launcher');
 if (input.config.stateRoot !== '/var/lib/xworkmate-workers/runs') throw new Error('Invalid worker state root');
 if (!isAbsolute(input.workspaceDir)) throw new Error('Workspace must be absolute');
 if (typeof input.prompt !== 'string' || !input.prompt.trim() || Buffer.byteLength(input.prompt) > 262144) throw new Error('Invalid or oversized worker prompt');
 let url: URL;
 try { url = new URL(input.config.modelService.baseUrl); } catch { throw new Error('Invalid model service URL'); }
 if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !url.pathname.endsWith('/v1')) throw new Error('Invalid model service URL');
 if (!/^\/run\/xworkmate-workers\/[a-zA-Z0-9_-]+\.env$/.test(input.config.modelService.credentialEnvFile)) throw new Error('Invalid model credential environment path');
 if (input.config.opencode.baseUrl !== 'http://127.0.0.1:4097' || input.config.opencode.authEnvFile !== '/run/xworkmate-workers/opencode.env') throw new Error('Invalid OpenCode endpoint or credential path');
 for (const rule of input.config.opencode.permissions ?? []) {
  if (!['read', 'edit', 'shell'].includes(rule.action) || !['allow', 'deny'].includes(rule.effect) || typeof rule.resource !== 'string' || !rule.resource || rule.resource.length > 1024) throw new Error('Invalid operator worker permission');
  if (rule.action !== 'shell' && (isAbsolute(rule.resource) || rule.resource.split('/').includes('..'))) throw new Error('File permissions must use workspace relative patterns');
 }
 const model = input.model ?? input.config.modelService.model;
 if (!model || model !== input.config.modelService.model) throw new Error('Model must match the deployed unified service route');
 const timeoutMs = input.config.timeoutMs ?? 120000;
 const maxOutputBytes = input.config.maxOutputBytes ?? 1048576;
 if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 900000) throw new Error('Invalid worker timeout');
 if (!Number.isInteger(maxOutputBytes) || maxOutputBytes < 1024 || maxOutputBytes > 33554432) throw new Error('Invalid worker output bound');
 return { model, timeoutMs, maxOutputBytes, cwd: `${input.config.stateRoot}/${input.engine}/${input.runId}/workspace` };
}

/** Strict bounded NDJSON RPC peer; stdout is protocol-only, stderr never returned. */
export class WorkerRpc {
 private next = 1;
 private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
 private buffer = Buffer.alloc(0);
 private bytes = 0;
 private stderrBytes = 0;
 private failure?: Error;
 readonly failed: Promise<never>;
 private rejectFailure!: (error: Error) => void;
 private timer: ReturnType<typeof setTimeout>;
 onNotification: (method: string, params: Obj) => void = () => {};
 constructor(readonly child: ChildProcessWithoutNullStreams, timeoutMs: number, readonly limit: number) {
  this.failed = new Promise<never>((_, reject) => { this.rejectFailure = reject; });
  this.failed.catch(() => {});
  this.timer = setTimeout(() => this.fail(new Error('Worker timeout')), timeoutMs);
  child.stdout.on('data', (chunk: Buffer) => this.ingest(chunk));
  child.stderr.on('data', (chunk: Buffer) => { this.stderrBytes += chunk.length; if (this.stderrBytes > limit) this.fail(new Error('Worker stderr output bound exceeded')); });
  child.on('error', () => this.fail(new Error('Worker launch failed')));
  child.on('exit', () => this.fail(new Error('Worker transport exited')));
 }
 request(method: string, params?: Obj): Promise<any> {
  if (this.failure) return Promise.reject(this.failure);
  const id = this.next++;
  return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.send({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }); });
 }
 notify(method: string, params: Obj) { this.send({ jsonrpc: '2.0', method, params }); }
 private send(frame: Obj) { if (!this.failure && !this.child.stdin.destroyed) this.child.stdin.write(JSON.stringify(frame) + '\n'); }
 private ingest(chunk: Buffer) {
  this.bytes += chunk.length;
  if (this.bytes > this.limit) return this.fail(new Error('Worker output bound exceeded'));
  this.buffer = Buffer.concat([this.buffer, chunk]);
  for (;;) {
   const end = this.buffer.indexOf(10); if (end < 0) break;
   const line = this.buffer.subarray(0, end).toString('utf8'); this.buffer = this.buffer.subarray(end + 1);
   let frame: Obj;
   try { const parsed = JSON.parse(line); if (!obj(parsed) || parsed.jsonrpc !== '2.0') throw new Error(); frame = parsed; }
   catch { return this.fail(new Error('Malformed worker JSON-RPC frame')); }
   if (typeof frame.method === 'string') {
    if (frame.id !== undefined) {
     // Fail closed: only the standardized permission request is answerable.
     this.send({ jsonrpc: '2.0', id: frame.id, ...(frame.method === 'session/request_permission'
      ? { result: { outcome: (() => {
       const options = frame.params?.options;
       const deny = Array.isArray(options) ? options.find((o: Obj) => o.kind === 'reject_once' && typeof o.optionId === 'string') : undefined;
       return deny ? { outcome: 'selected', optionId: deny.optionId } : { outcome: 'cancelled' };
      })() } }
      : { error: { code: -32601, message: 'Unsupported client request' } }) });
    } else {
     try { this.onNotification(frame.method, obj(frame.params) ? frame.params : {}); }
     catch { this.fail(new Error('Malformed worker notification')); }
    }
   } else if (typeof frame.id === 'number') {
    const pending = this.pending.get(frame.id); if (!pending) return this.fail(new Error('Unknown worker RPC response'));
    this.pending.delete(frame.id);
    if (frame.error !== undefined) pending.reject(new Error('Worker protocol request rejected'));
    else if ('result' in frame) pending.resolve(frame.result);
    else { const error = new Error('Malformed worker RPC response'); pending.reject(error); return this.fail(error); }
   } else return this.fail(new Error('Malformed worker RPC frame'));
  }
 }
 fail(error: Error) {
  if (this.failure) return;
  this.failure = error; this.rejectFailure(error);
  for (const p of this.pending.values()) p.reject(error);
  this.pending.clear(); this.close();
 }
 async dispose(): Promise<void> {
  this.close();
  if (this.child.exitCode !== null || this.child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
   const timer = setTimeout(() => { this.child.removeListener('exit', exited); reject(new Error('Worker process exit unverified')); }, 2500);
   const exited = () => { clearTimeout(timer); resolve(); };
   this.child.once('exit', exited);
  });
 }
 close() {
  clearTimeout(this.timer); this.child.stdin.end();
  if (this.child.exitCode === null) {
   this.child.kill('SIGTERM');
   const timer = setTimeout(() => { if (this.child.exitCode === null) this.child.kill('SIGKILL'); }, 1000); timer.unref();
  }
 }
}
function launched(input: WorkerInput, timeoutMs: number, limit: number) {
 const [bin, ...args] = input.config.command;
 // No host OAuth, HOME, provider credential, or inherited environment.
 return new WorkerRpc(spawn(bin!, [...args, input.engine, input.runId], { env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' }, stdio: 'pipe' }), timeoutMs, limit);
}
const bounded = (text: string, limit: number) => { if (Buffer.byteLength(text) > limit) throw new Error('Worker text output bound exceeded'); return text; };
const textBlocks = (blocks: any[]) => blocks.filter(b => obj(b) && b.type === 'text' && typeof b.text === 'string').map(b => b.text).join('');
async function dsh(input: WorkerInput, options: ReturnType<typeof validateWorkerInput>): Promise<WorkerResult> {
 const peer = launched(input, options.timeoutMs, options.maxOutputBytes);
 let sessionId = input.runId;
 let text = '';
 let promptPending = false;
 let cancelTimer: ReturnType<typeof setTimeout> | undefined;
 const abort = () => {
  if (input.engine === 'dsh-sdk') peer.fail(new Error('DSH SDK has no mid-turn cancel; owned runtime terminated without rollback'));
  else if (promptPending) {
   peer.notify('session/cancel', { sessionId });
   cancelTimer = setTimeout(() => peer.fail(new Error('ACP cancellation settlement timeout; owned runtime terminated without rollback')), 5000);
  } else peer.fail(abortError());
 };
 input.signal?.addEventListener('abort', abort, { once: true });
 try {
  if (input.signal?.aborted) throw abortError();
  if (input.engine === 'dsh-acp') {
   peer.onNotification = (method, params) => {
    if (method !== 'session/update' || params.sessionId !== sessionId) return;
    const update = params.update;
    if (obj(update) && update.sessionUpdate === 'agent_message_chunk' && obj(update.content) && update.content.type === 'text' && typeof update.content.text === 'string') text = bounded(text + update.content.text, options.maxOutputBytes);
   };
   const init = await peer.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
   if (init?.protocolVersion !== 1 || init?.agentInfo?.name !== 'deepseek-harness-acp') throw new Error('Unsupported DSH ACP runtime');
   const session = await peer.request('session/new', { cwd: options.cwd, mcpServers: [] });
   if (typeof session?.sessionId !== 'string' || !Array.isArray(session.configOptions)) throw new Error('Malformed ACP session');
   sessionId = session.sessionId;
   const value = JSON.stringify(['xworkmate', options.model]);
   const modelOption = session.configOptions.find((v: Obj) => v.id === 'model');
   if (!modelOption || !Array.isArray(modelOption.options) || !modelOption.options.some((v: Obj) => v.value === value || (v.group === 'xworkmate' && Array.isArray(v.options) && v.options.some((p: Obj) => p.value === value)))) throw new Error('DSH unified xworkmate model route is not deployed');
   await peer.request('session/set_config_option', { sessionId, configId: 'model', value });
   promptPending = true;
   const result = await peer.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: input.prompt }] });
   promptPending = false;
   if (input.signal?.aborted) throw abortError();
   if (result?.stopReason !== 'end_turn') throw new Error('DSH ACP turn did not complete successfully');
   await peer.request('session/close', { sessionId });
  } else {
   let idleResolve!: () => void;
   const idle = new Promise<void>(resolve => { idleResolve = resolve; });
   let running = false;
   let settled = false;
   let failed = false;
   peer.onNotification = (method, p) => {
    if (p.sessionId !== sessionId) return;
    if (method === 'session.event') {
     const event = p.event;
     if (event?.type === 'assistant/message') {
      if (!Array.isArray(event.data?.message?.content)) throw new Error();
      text = bounded(textBlocks(event.data.message.content), options.maxOutputBytes);
     }
     if (event?.type === 'turn/end') { settled = true; failed = event.data?.reason?.kind !== 'completed'; }
    }
    if (method === 'session.status') {
     if (p.status === 'running') running = true;
     if (p.status === 'idle' && running && settled) idleResolve();
    }
   };
   const init = await peer.request('initialize', { cwd: options.cwd, provider: 'xworkmate', model: options.model });
   if (init?.serverInfo?.name !== 'deepseek-harness-sdk-runtime') throw new Error('Unsupported DSH SDK runtime');
   // Keep a pending request until idle so transport/timeouts reject the wait as well.
   const receipt = await peer.request('session/prompt', { sessionId, contentBlocks: [{ type: 'text', text: input.prompt }] });
   if (typeof receipt?.messageId !== 'string') throw new Error('Malformed DSH SDK enqueue receipt');
   await Promise.race([idle, peer.failed]);
   if (failed) throw new Error('DSH SDK turn failed');
   await peer.request('shutdown');
  }
  return { engine: input.engine, sessionId, text };
 } finally { input.signal?.removeEventListener('abort', abort); if (cancelTimer) clearTimeout(cancelTimer); await peer.dispose(); }
}

async function opencode(input: WorkerInput, options: ReturnType<typeof validateWorkerInput>): Promise<WorkerResult> {
 const file = await readFile(input.config.opencode.authEnvFile, 'utf8');
 if (Buffer.byteLength(file) > 16384) throw new Error('Invalid OpenCode credential file');
 const match = file.match(/^OPENCODE_PASSWORD=([^\r\n]+)$/m);
 if (!match?.[1]) throw new Error('OpenCode runtime credential unavailable');
 const password = match[1].replace(/^(['"])(.*)\1$/, '$2');
 const headers = { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`, 'content-type': 'application/json' };
 const controller = new AbortController();
 const timer = setTimeout(() => controller.abort(), options.timeoutMs);
 const abort = () => controller.abort(); input.signal?.addEventListener('abort', abort, { once: true });
 let sessionId: string | undefined;
 const request = async (path: string, body?: Obj, signal: AbortSignal = controller.signal) => {
  const response = await fetch(input.config.opencode.baseUrl + path, { method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined, signal, redirect: 'error' });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`OpenCode request failed (${response.status})`); }
  if (response.status === 204) return undefined;
  const reader = response.body?.getReader(); if (!reader) throw new Error('Missing OpenCode response');
  const chunks: Uint8Array[] = []; let bytes = 0;
  try { for (;;) { const part = await reader.read(); if (part.done) break; bytes += part.value.length; if (bytes > options.maxOutputBytes) throw new Error('OpenCode output bound exceeded'); chunks.push(part.value); } }
  finally { await reader.cancel(); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('Malformed OpenCode JSON response'); }
 };
 try {
  if (input.signal?.aborted) throw abortError();
  const catalog = await request('/api/model');
  if (!Array.isArray(catalog?.data) || !catalog.data.some((m: Obj) => m.providerID === 'xworkmate' && m.id === options.model && typeof m.modelID === 'string' && m.modelID.length > 0 && m.enabled === true)) throw new Error('OpenCode unified xworkmate provider/model is not deployed');
  const created = await request('/api/session', { title: `XWorkmate ${input.runId}`, location: { directory: input.workspaceDir }, model: { id: options.model, providerID: 'xworkmate' }, permissions: [{ action: '*', resource: '*', effect: 'deny' }, ...(input.config.opencode.permissions ?? []), { action: 'external_directory', resource: '*', effect: 'deny' }] });
  if (typeof created?.data?.id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(created.data.id)) throw new Error('Malformed OpenCode session');
  sessionId = created.data.id;
  const prefix = `/api/session/${sessionId}`;
  await request(prefix + '/prompt', { text: input.prompt });
  await request(`/api/experimental/session/${sessionId}/wait`, {});
  const context = await request(prefix + '/context');
  if (!Array.isArray(context?.data)) throw new Error('Malformed OpenCode session context');
  const assistant = context.data.filter((m: Obj) => m.type === 'assistant').at(-1);
  if (!assistant || assistant.error || !Array.isArray(assistant.content)) throw new Error('OpenCode completed without successful assistant output');
  const result: WorkerResult = { engine: input.engine, sessionId, text: bounded(textBlocks(assistant.content), options.maxOutputBytes) };
  if (input.config.collectArtifacts) {
   const diff = await request(prefix + '/diff?context=3');
   if (!Array.isArray(diff?.data)) throw new Error('Malformed OpenCode v2 diff response');
   result.files = openCodeFiles(diff.data, context.data, options.maxOutputBytes);
  }
  return result;
 } catch (error) {
  if (sessionId) {
   // Independent bounded signal: aborted HTTP does not cancel server execution.
   const cleanup = AbortSignal.timeout(5000);
   try {
    await request(`/api/session/${sessionId}/interrupt?resume=false`, {}, cleanup);
    await request(`/api/experimental/session/${sessionId}/wait`, {}, cleanup);
   } catch { throw new Error('OpenCode cancellation settlement unverified; server task may still be active'); }
  }
  throw error;
 } finally { clearTimeout(timer); input.signal?.removeEventListener('abort', abort); }
}
export async function executeWorker(input: WorkerInput): Promise<WorkerResult> {
 const options = validateWorkerInput(input);
 if (input.signal?.aborted) throw abortError();
 const effective = input.config.collectArtifacts && input.engine !== 'opencode-v2' ? { ...input, prompt: input.prompt + `\nSave final deliverable files only under ${options.cwd}/output. Avoid copying source trees or credentials.` } : input;
 const result = await (input.engine === 'opencode-v2' ? opencode(effective, options) : dsh(effective, options));
 if (input.config.collectArtifacts && input.engine !== 'opencode-v2') result.files = await exportWorkerFiles(input);
 return result;
}
