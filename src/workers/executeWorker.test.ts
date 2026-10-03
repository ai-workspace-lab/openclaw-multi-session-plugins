import { describe, it, expect, vi, afterEach } from 'vitest';
import { executeWorker, validateWorkerInput, type WorkerConfig } from './executeWorker.js';
const config: WorkerConfig = {
 command: ['/usr/bin/sudo', '-n', '/usr/local/libexec/xworkmate-worker-launch'],
 stateRoot: '/var/lib/xworkmate-workers/runs',
 opencode: { baseUrl: 'http://127.0.0.1:4097', authEnvFile: '/run/xworkmate-workers/opencode.env' },
 modelService: { baseUrl: 'https://models.example/v1', model: 'test-model', credentialEnvFile: '/run/xworkmate-workers/model.env' },
};
const runId = '12345678-1234-4234-8234-123456789abc';
const input = { engine: 'dsh-acp' as const, prompt: 'hello', runId, workspaceDir: '/tmp/gateway/run', config };
afterEach(() => vi.unstubAllGlobals());
describe('bounded worker admission', () => {
 it('accepts only canonical run IDs and fixed launcher', () => {
  expect(validateWorkerInput(input).cwd).toBe(`/var/lib/xworkmate-workers/runs/dsh-acp/${runId}/workspace`);
  expect(() => validateWorkerInput({ ...input, runId: '../escape' })).toThrow(/canonical/);
  expect(() => validateWorkerInput({ ...input, config: { ...config, command: ['sh', '-c'] } })).toThrow(/launcher/);
 });
 it('rejects credentials in model URL, nonlocal OpenCode, oversized prompts', () => {
  expect(() => validateWorkerInput({ ...input, config: { ...config, modelService: { ...config.modelService, baseUrl: 'https://user:secret@models.example/v1' } } })).toThrow(/model service/);
  expect(() => validateWorkerInput({ ...input, prompt: 'x'.repeat(262145) })).toThrow(/prompt/);
  expect(() => validateWorkerInput({ ...input, config: { ...config, opencode: { ...config.opencode, baseUrl: 'http://other:4097' } } })).toThrow(/OpenCode/);
 });
 it('does not start a cancelled request', async () => {
  const abort = new AbortController(); abort.abort();
  await expect(executeWorker({ ...input, signal: abort.signal })).rejects.toThrow(/abort/i);
 });
});
