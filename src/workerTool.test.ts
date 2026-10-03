import { describe,it,expect,vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { normalizeProductCapability, writeWorkerFiles, createWorkerTool } from './workerTool.js';

describe('Gateway worker trust boundary',()=>{
 it('rejects malformed capabilities and runtime commands supplied as product metadata',()=>{
  expect(()=>normalizeProductCapability({schemaVersion:2,mode:'code'})).toThrow();
  expect(()=>normalizeProductCapability({schemaVersion:1,mode:'code',command:'sh'})).toThrow();
  expect(normalizeProductCapability({schemaVersion:1,mode:'work'})).toEqual({schemaVersion:1,mode:'work'});
 });
 it('never runs a worker without host-owned tool/run binding',async()=>{
  const run=vi.fn(); const tool=createWorkerTool({pluginConfig:{workerRuntime:{}},config:{}} as any,{sessionKey:'a'},new Map(),run);
  await expect(tool.execute('unbound',{engine:'dsh-acp',prompt:'write'} as any)).rejects.toThrow('host-owned');
  expect(run).not.toHaveBeenCalled();
 });
 it('rejects artifact traversal and symlinks before publishing',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'xm-worker-files-'));
  await expect(writeWorkerFiles(root,[{relativePath:'../escape',contentBase64:'eA==',size:1,sha256:'bad'}])).rejects.toThrow();
  const outside=await fs.mkdtemp(path.join(os.tmpdir(),'xm-outside-'));
  await fs.symlink(outside,path.join(root,'artifacts'));
  await expect(writeWorkerFiles(root,[{relativePath:'out.txt',contentBase64:'eA==',size:1,sha256:'bad'}])).rejects.toThrow();
 });
});

describe('Gateway worker bound happy path',()=>{
 it('normalizes only unified xworkmate model references',()=>{
  expect(normalizeProductCapability({schemaVersion:1,mode:'code',model:'xworkmate/test-model'})).toEqual({schemaVersion:1,mode:'code',model:'xworkmate/test-model'});
  expect(()=>normalizeProductCapability({schemaVersion:1,mode:'code',model:'other/test-model'})).toThrow('model');
  expect(()=>normalizeProductCapability({schemaVersion:1,mode:'code',model:'test-model'})).toThrow('model');
 });
 it('awaits the bound worker and publishes real files without exposing input path arguments',async()=>{
  const {createHash}=await import('node:crypto');
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'xm-worker-happy-'));
  const binding={sessionKey:'trusted-session',runId:'trusted-run',artifactDirectory:root,capability:{schemaVersion:1 as const,mode:'code' as const,model:'xworkmate/test-model'}};
  const bindings=new Map([['host-call',binding]]);
  const run=vi.fn(async(_input:any)=>({engine:'opencode-v2' as const,sessionId:'ses_real',text:'Actual worker result',files:[{relativePath:'code.diff',contentBase64:Buffer.from('real patch').toString('base64'),size:10,sha256:createHash('sha256').update('real patch').digest('hex')}]}));
  const runtime={modelService:{model:'test-model'}};
  const tool=createWorkerTool({pluginConfig:{workerRuntime:runtime},config:{}} as any,{sessionKey:'trusted-session'},bindings,run);
  const output=await tool.execute('host-call',{engine:'opencode-v2',prompt:'change'} as any) as any;
  expect(run).toHaveBeenCalledOnce();expect(run.mock.calls[0][0]).toMatchObject({engine:'opencode-v2',workspaceDir:root,model:'test-model',config:runtime});
  expect(output.details.parentRunId).toBe('trusted-run');expect(output.details.artifacts).toHaveLength(1);
  expect(await fs.readFile(path.join(root,output.details.artifacts[0]),'utf8')).toBe('real patch');
  expect(bindings.size).toBe(0);
  await expect(tool.execute('host-call',{engine:'opencode-v2',prompt:'replay'} as any)).rejects.toThrow('host-owned');
  await fs.rm(root,{recursive:true,force:true});
 });
});
