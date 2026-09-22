#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, access, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import pty from 'node-pty';
const root = resolve(import.meta.dirname);
const delay = ms => new Promise(done => setTimeout(done, ms));
async function until(check, label) { for (let i = 0; i < 1500; i++) { if (await check()) return; await delay(10); } throw Error(`Timeout: ${label}`); }
const temp = await mkdtemp('/private/tmp/neta-pi-components-');
const artifacts = join(root, 'artifacts'); await mkdir(artifacts, {recursive:true});
await rm(join(artifacts,'evidence.json'), {force:true});
assert.equal(JSON.parse(await readFile(resolve(root,'../../node_modules/@earendil-works/pi-coding-agent/package.json'),'utf8')).version,'0.85.0');
const hostCwd = join(temp,'host'); const clientCwd = join(temp,'client');
const hostConfig = join(temp,'host-config'); const clientConfig = join(temp,'client-config');
for (const dir of [hostCwd,clientCwd,hostConfig,clientConfig]) await mkdir(dir);
const bodies = []; let releaseStream;
const streamGate = new Promise(done => { releaseStream = done; });
const model = createServer(async (request,response) => {
  let body = ''; for await (const chunk of request) body += chunk; bodies.push(JSON.parse(body));
  response.writeHead(200, {'content-type':'text/event-stream'});
  const send = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({id:'proof',object:'chat.completion.chunk',choices:[{index:0,delta,finish_reason}]})}\n\n`);
  if (bodies.length === 1) {
    send({role:'assistant',content:'STREAM_FIRST_FRAGMENT'}); await streamGate;
    send({content:' STREAM_SECOND_FRAGMENT'});
    send({tool_calls:[{index:0,id:'proof_call',type:'function',function:{name:'proof_tool',arguments:JSON.stringify({note:'PTY dialog'})}}]});
    send({},'tool_calls');
  } else { send({role:'assistant',content:'FINAL_REMOTE_COMPLETION'}); send({},'stop'); }
  response.end('data: [DONE]\n\n');
});
model.listen(0,'127.0.0.1'); await once(model,'listening');
await writeFile(join(hostConfig,'models.json'),JSON.stringify({providers:{proof:{baseUrl:`http://127.0.0.1:${model.address().port}/v1`,api:'openai-completions',apiKey:'local-proof',models:[{id:'proof-model',contextWindow:4096,maxTokens:256,input:['text']}]}}}));
await writeFile(join(hostConfig,'settings.json'),JSON.stringify({defaultProjectTrust:'always',retry:{enabled:false}}));
const marker = join(hostCwd,'host-only-marker.txt');
const state = join(temp,'state.json');
const cli = resolve(root,'../../node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js');
const args = [cli,'--mode','rpc','--provider','proof','--model','proof-model','--session-dir',join(temp,'sessions'),'--extension',join(root,'proof-extension.ts'),'--no-extensions','--no-context-files','--offline','--no-builtin-tools'];
const clients = []; const captures = [];
function start(name, hostArgs) {
  const options = {args:hostArgs,hostCwd,hostConfig,marker,state,log:join(artifacts,`${name}.rpc.jsonl`)};
  const client = pty.spawn(process.execPath,[join(root,'remote-chat.mjs'),JSON.stringify(options)],{cwd:clientCwd,env:{PATH:process.env.PATH,HOME:clientCwd,TERM:'xterm-256color',PI_CODING_AGENT_DIR:clientConfig,PI_OFFLINE:'1'},cols:120,rows:40});
  const record = {name,text:'',exited:false}; captures.push(record); clients.push(client);
  client.onData(chunk => {record.text += chunk;}); client.onExit(() => {record.exited = true;});
  return {client,record};
}
const checks = {};
try {
  for (const name of ['first','reconnected']) { await writeFile(join(artifacts,`${name}.rpc.jsonl`),''); await writeFile(join(artifacts,`${name}.rpc.jsonl.stderr`),''); }
  const first = start('first',args);
  await until(() => first.record.text.includes('Remote chat ready'), 'initial editor');
  first.client.write('start component proof\r');
  await until(() => first.record.text.includes('STREAM_FIRST_FRAGMENT'),'first streamed fragment in PTY');
  assert(!first.record.text.includes('STREAM_SECOND_FRAGMENT')); checks.incrementalPtyStream = true; releaseStream();
  await until(() => first.record.text.includes('Remote confirmation'),'SelectList confirm');
  first.client.write('\t'); await delay(100); first.client.write('EXACT_STEER_FROM_PTY_724\r');
  await until(async () => (await readFile(join(artifacts,'first.rpc.jsonl'),'utf8')).includes('"command":"steer","success":true'), 'steer acknowledgement');
  first.client.write('\t'); await delay(100); first.client.write('\r');
  await until(() => first.record.text.includes('FINAL_REMOTE_COMPLETION') && first.record.text.includes('Remote turn complete'),'completed turn in PTY');
  assert.equal(bodies.length,2);
  assert(bodies[1].messages.some(message => message.role === 'user' && (message.content === 'EXACT_STEER_FROM_PTY_724' || message.content?.some?.(part => part.text === 'EXACT_STEER_FROM_PTY_724')))); checks.exactSteeringReachedModel = true;
  assert.equal(await readFile(marker,'utf8'),`HOST_ONLY_MARKER cwd=${hostCwd}`); assert(first.record.text.includes('HOST_ONLY_MARKER')); checks.hostToolExecution = true;
  const events = (await readFile(join(artifacts,'first.rpc.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
  for (const type of ['message_start','message_update','message_end','tool_execution_start','tool_execution_update','tool_execution_end']) assert(events.some(event => event.type === type));
  assert(events.some(event => event.method === 'notify')); assert(events.some(event => event.type === 'tool_execution_end' && event.result.details.confirmed === true)); checks.rpcEventMappingAndConfirm = true;
  const session = JSON.parse(await readFile(state,'utf8')).sessionFile; assert(session);
  first.client.write('\x04'); await until(() => first.record.exited,'first UI and host exit');
  const second = start('reconnected',[...args,'--session',session]);
  await until(() => second.record.text.includes('FINAL_REMOTE_COMPLETION') && /restored [1-9]/.test(second.record.text),'persisted history rendered in new UI');
  for (const text of ['start component proof','EXACT_STEER_FROM_PTY_724','HOST_ONLY_MARKER']) assert(second.record.text.includes(text));
  checks.restartHistory = true; second.client.write('\x04'); await until(() => second.record.exited,'second exit');
  await assert.rejects(access(join(clientConfig,'models.json'))); await assert.rejects(access(join(clientConfig,'auth.json'))); await assert.rejects(access(join(clientCwd,'host-only-marker.txt'))); checks.clientHasNoModelAuthOrToolMarker = true;
  const evidence = {result:'PASS',piVersion:'0.85.0',checks,hostCwd,clientCwd,hostConfig,clientConfig,session,limitations:['Component composition, not unmodified InteractiveMode','Internal component imports pinned to Pi 0.85.0','Local pipes, no SSH','No custom extension renderer parity']};
  await writeFile(join(artifacts,'evidence.json'),JSON.stringify(evidence,null,2)+'\n'); console.log(JSON.stringify(evidence,null,2));
} finally {
  releaseStream(); for (const client of clients) { try {client.kill();} catch {} }
  for (const record of captures) await writeFile(join(artifacts,`${record.name}.pty.txt`),record.text);
  model.closeAllConnections(); await new Promise(done => model.close(done));
}
