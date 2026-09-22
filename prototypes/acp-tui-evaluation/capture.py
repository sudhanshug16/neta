import subprocess,json,pathlib
root=pathlib.Path('/private/tmp/neta-acp-eval')
p=subprocess.Popen(['node','/Users/runner/workspace/neta/test/fixtures/fake-acp-agent.mjs'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,text=True)
updates=[]
def call(i,method,params):
 p.stdin.write(json.dumps(dict(jsonrpc='2.0',id=i,method=method,params=params))+'\n');p.stdin.flush()
 while True:
  line=p.stdout.readline()
  if not line: raise RuntimeError('fixture exited')
  msg=json.loads(line)
  if msg.get('method')=='session/update': updates.append(msg['params']['update'])
  elif msg.get('method')=='session/request_permission':
   p.stdin.write(json.dumps(dict(jsonrpc='2.0',id=msg['id'],result={'outcome':{'outcome':'cancelled'}}))+'\n');p.stdin.flush()
  elif msg.get('id')==i:
   if 'error' in msg: raise RuntimeError(msg)
   return msg['result']
try:
 call(1,'initialize',{'protocolVersion':1,'clientCapabilities':{}})
 session=call(2,'session/new',{'cwd':'/private/tmp/neta-acp-eval','mcpServers':[]})['sessionId']
 for i,prompt in enumerate(['STREAM','DIFF','THINK','EDIT'],3):
  result=call(i,'session/prompt',{'sessionId':session,'prompt':[{'type':'text','text':prompt}]})
 (root/'updates.ndjson').write_text(''.join(json.dumps(u)+'\n' for u in updates))
 print(json.dumps({'sessionId':session,'updates':len(updates),'result':result}))
finally:p.terminate();p.wait()
