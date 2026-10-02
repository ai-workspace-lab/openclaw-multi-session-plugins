import { describe, it, expect, vi, afterEach } from 'vitest';
vi.mock('node:fs/promises', () => ({ readFile: vi.fn(async () => 'OPENCODE_PASSWORD=fixture-only\n') }));
import { executeWorker, type WorkerConfig } from './executeWorker.js';
const config: WorkerConfig = { command: ['/usr/bin/sudo', '-n', '/usr/local/libexec/xworkmate-worker-launch'], stateRoot: '/var/lib/xworkmate-workers/runs', modelService: { baseUrl: 'https://models.example/v1', model: 'test-model', credentialEnvFile: '/run/xworkmate-workers/model.env' }, opencode: { baseUrl: 'http://127.0.0.1:4097', authEnvFile: '/run/xworkmate-workers/opencode.env' } };
const input = { engine: 'opencode-v2' as const, prompt: 'hello', runId: '12345678-1234-4234-8234-123456789abc', workspaceDir: '/tmp/run', config };
afterEach(() => vi.unstubAllGlobals());
describe('OpenCode v2 pinned HTTP fixtures', () => {
 it('uses v2 Model.Ref, waits after durable admission, and denies tools', async () => {
  const calls: { path: string; body?: any }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
   const path = new URL(url).pathname; calls.push({ path, body: init.body ? JSON.parse(String(init.body)) : undefined });
   const data = path === '/api/model' ? { data: [{ id: 'test-model', providerID: 'xworkmate', modelID: 'backend-test-model', enabled: true }] }
    : path === '/api/session' ? { data: { id: 'ses_fixture' } }
    : path.endsWith('/context') ? { data: [{ type: 'assistant', content: [{ type: 'text', text: 'completed' }] }] }
    : { data: { id: 'inbox_fixture' } };
   return path.endsWith('/wait') ? new Response(null, { status: 204 }) : Response.json(data);
  }));
  expect(await executeWorker(input)).toMatchObject({ engine: 'opencode-v2', text: 'completed' });
  expect(calls[1].body.model).toEqual({ id: 'test-model', providerID: 'xworkmate' });
  expect(calls[1].body.permissions).toEqual([{ action: '*', resource: '*', effect: 'deny' }, { action: 'external_directory', resource: '*', effect: 'deny' }]);
  expect(calls.map(c => c.path)).toEqual(['/api/model', '/api/session', '/api/session/ses_fixture/prompt', '/api/experimental/session/ses_fixture/wait', '/api/session/ses_fixture/context']);
 });
 it('collects actual turn diff and shell log through v2 HTTP', async () => {
  const paths: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
   const path = new URL(url).pathname; paths.push(path);
   const data = path === '/api/model' ? { data: [{ id: 'test-model', providerID: 'xworkmate', modelID: 'backend-model', enabled: true }] }
    : path === '/api/session' ? { data: { id: 'ses_artifact' } }
    : path.endsWith('/context') ? { data: [{ type: 'assistant', content: [{ type: 'text', text: 'changed' }, { type: 'tool', name: 'shell', executed: true, state: { status: 'completed', input: { command: 'npm test' }, content: [{ type: 'text', text: 'tests passed' }] } }] }] }
    : path.endsWith('/diff') ? { data: [{ file: 'a.ts', patch: '--- a/a.ts\n+++ b/a.ts\n-old\n+new\n', additions: 1, deletions: 1, status: 'modified' }] }
    : { data: { id: 'msg_fixture' } };
   return path.endsWith('/wait') ? new Response(null, { status: 204 }) : Response.json(data);
  }));
  const result = await executeWorker({ ...input, config: { ...config, collectArtifacts: true } });
  expect(result.files?.map(f => f.relativePath)).toEqual(['code.diff', 'tests.log']);
  expect(paths.at(-1)).toBe('/api/session/ses_artifact/diff');
  expect(Buffer.from(result.files![1].contentBase64, 'base64').toString()).toContain('tests passed');
 });
 it('fails closed if unified provider is missing', async () => {
  const fetch = vi.fn(async () => Response.json({ data: [{ providerID: 'deepseek', modelID: 'test-model' }] })); vi.stubGlobal('fetch', fetch);
  await expect(executeWorker(input)).rejects.toThrow('not deployed'); expect(fetch).toHaveBeenCalledTimes(1);
 });
 it('interrupts and waits using an independent signal after HTTP abort', async () => {
  const paths: string[] = []; const abort = new AbortController();
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
   const path = new URL(url).pathname; paths.push(path);
   if (path === '/api/model') return Response.json({ data: [{ id: 'test-model', providerID: 'xworkmate', modelID: 'backend-test-model', enabled: true }] });
   if (path === '/api/session') return Response.json({ data: { id: 'ses_fixture' } });
   if (path.endsWith('/prompt')) { abort.abort(); throw new Error('HTTP aborted'); }
   expect(init.signal?.aborted).toBe(false);
   return path.endsWith('/wait') ? new Response(null, { status: 204 }) : Response.json({ interrupted: true });
  }));
  await expect(executeWorker({ ...input, signal: abort.signal })).rejects.toThrow('HTTP aborted');
  expect(paths.slice(-2)).toEqual(['/api/session/ses_fixture/interrupt', '/api/experimental/session/ses_fixture/wait']);
 });
});
