import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import type { WorkerInput, WorkerFile } from './executeWorker.js';
/** The root-owned launcher exports ONLY workspace/output after its unit is idle. */
export async function exportWorkerFiles(input: WorkerInput): Promise<WorkerFile[]> {
 if (input.engine === 'opencode-v2') throw new Error('OpenCode artifact export is not provided by the DSH launcher');
 const [bin, ...args] = input.config.command;
 const raw = await new Promise<string>((resolve, reject) => {
  const child = spawn(bin!, [...args, 'export', input.engine, input.runId], { env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const chunks: Buffer[] = []; let bytes = 0; let failure: Error | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let exitTimer: ReturnType<typeof setTimeout> | undefined;
  const fail = (reason: string) => {
   if (failure) return; failure = new Error(reason); child.kill('SIGTERM');
   killTimer = setTimeout(() => child.kill('SIGKILL'), 1000);
   exitTimer = setTimeout(() => reject(new Error('Worker exporter process exit unverified')), 2500);
  };
  const timer = setTimeout(() => fail('Worker artifact export timeout'), 10000);
  const abort = () => fail('Worker artifact export aborted'); input.signal?.addEventListener('abort', abort, { once: true });
  child.stdout.on('data', (b: Buffer) => { bytes += b.length; if (bytes > 1500000) fail('Worker artifact manifest output bound exceeded'); else chunks.push(b); });
  child.stderr.on('data', (b: Buffer) => { bytes += b.length; if (bytes > 1500000) fail('Worker artifact output bound exceeded'); });
  child.on('error', () => fail('Worker artifact exporter failed to launch'));
  child.on('close', (code) => { clearTimeout(timer); input.signal?.removeEventListener('abort', abort); if (killTimer) clearTimeout(killTimer); if (exitTimer) clearTimeout(exitTimer); if (failure) reject(failure); else code === 0 ? resolve(Buffer.concat(chunks).toString('utf8')) : reject(new Error('Worker artifact exporter failed')); });
  if (input.signal?.aborted) abort();
 });
 return validateWorkerManifest(raw, input.engine, input.runId);
}
export function validateWorkerManifest(raw: string, engine: string, runId: string): WorkerFile[] {
 let manifest: any; try { manifest = JSON.parse(raw); } catch { throw new Error('Malformed worker artifact manifest'); }
 if (!manifest || typeof manifest !== 'object' || manifest.profile !== engine || manifest.runId !== runId || !Array.isArray(manifest.artifacts) || manifest.artifacts.length > 8) throw new Error('Invalid worker artifact scope');
 let total = 0; const paths = new Set<string>();
 return manifest.artifacts.map((file: any) => {
  if (!file || typeof file !== 'object' || typeof file.relativePath !== 'string' || !file.relativePath || file.relativePath.includes('\\') || file.relativePath.includes('\0') || posix.isAbsolute(file.relativePath) || posix.normalize(file.relativePath) !== file.relativePath || file.relativePath.split('/').includes('..') || paths.has(file.relativePath)) throw new Error('Invalid worker artifact path');
  paths.add(file.relativePath);
  if (!Number.isSafeInteger(file.size) || file.size < 0 || typeof file.contentBase64 !== 'string' || !/^[a-zA-Z0-9+/]*={0,2}$/.test(file.contentBase64) || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error('Invalid worker artifact encoding');
  const data = Buffer.from(file.contentBase64, 'base64'); total += data.length;
  if (data.toString('base64') !== file.contentBase64 || data.length !== file.size || total > 1048576 || createHash('sha256').update(data).digest('hex') !== file.sha256) throw new Error('Worker artifact integrity or size check failed');
  return { relativePath: file.relativePath, contentBase64: file.contentBase64, size: file.size, sha256: file.sha256 };
 });
}
