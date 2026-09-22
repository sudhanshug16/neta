import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..");

test("rmux current screen drops remote text after /neta-reset", async () => {
	const dir = await mkdtemp(join(tmpdir(), "neta-reset-screen-"));
	const descriptor = join(dir, "node.json");
	const socket = join(dir, "node.sock");
	let activeSession = "session-old";
	const requests: Array<{ method: string; sessionId?: string; text?: string }> = [];
	const server = createServer((connection) => {
		let input = "";
		connection.setEncoding("utf8");
		connection.on("data", (chunk) => {
			input += chunk;
			for (;;) {
				const end = input.indexOf("\n"); if (end < 0) return;
				const request = JSON.parse(input.slice(0, end)) as { id: string; method: string; params?: { sessionId?: string; text?: string } };
				input = input.slice(end + 1);
				requests.push({ method: request.method, sessionId: request.params?.sessionId, text: request.params?.text });
				const reply = (result: unknown) => connection.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
				if (request.method === "hello") reply({ machine:{id:"m",name:"local",createdAt:new Date().toISOString()}, protocolVersion:3,nodeVersion:"test",pid:process.pid });
				else if (request.method === "conversation.tail") reply({sessionId:request.params?.sessionId,turns:[],blocks:[],prevCursor:null,provider:"fake",model:"test-model"});
				else if (request.method === "models.list") reply({models:[{id:"test-model",name:"Test",provider:"fake"}]});
				else if (request.method === "conversation.reset") { activeSession="session-new"; reply({sessionId:activeSession,provider:"fake",model:"test-model"}); }
				else if (request.method === "conversation.untail") reply({});
				else if (request.method === "conversation.prompt") {
					const sessionId=request.params?.sessionId ?? activeSession, text=request.params?.text ?? ""; reply({turnId:`turn-${sessionId}`});
					const notify=(params:unknown)=>connection.write(`${JSON.stringify({jsonrpc:"2.0",method:"turn",params})}\n`);
					notify({sessionId,turn:{id:`turn-${sessionId}`,sessionId,role:"user",startedAt:new Date().toISOString()}});
					notify({sessionId,block:{turnId:`turn-${sessionId}`,seq:1,at:new Date().toISOString(),role:"agent",kind:"text",text:`REMOTE_${sessionId === "session-old" ? "OLD_" : "NEW_"}${text}`}});
					notify({sessionId,turn:{id:`turn-${sessionId}`,sessionId,role:"user",startedAt:new Date().toISOString(),endedAt:new Date().toISOString()}});
				} else reply({});
			}
		});
	});
	await new Promise<void>((resolve,reject)=>{server.once("error",reject);server.listen(socket,resolve);});
	try {
		const bin=join(dir,"bin"); await mkdir(join(dir,"pi"),{recursive:true}); await mkdir(bin,{recursive:true});
		for(const name of ["fd","rg"]){const path=join(bin,name);await writeFile(path,"#!/bin/sh\nexit 0\n");await chmod(path,0o700);}
		await writeFile(descriptor,JSON.stringify({socket,token:"test",pid:process.pid,protocolVersion:3,startedAt:new Date().toISOString()}));
		const child=Bun.spawn(["python3",join(root,"test/fixtures/pi-reset-screen.py")],{cwd:root,env:{...process.env,NETA_RMUX:join(root,".cache/rmux/bin/rmux"),NETA_RMUX_SOCKET:join(dir,"rmux.sock"),NETA_DESCRIPTOR:descriptor,NETA_TARGET_SESSION_ID:"session-old",NETA_TARGET_PROVIDER:"fake",NETA_TARGET_MODEL:"test-model",NETA_PI_READY_MARKER:"fake · test-model",NETA_PI_VERIFY_ROOT:root,NETA_PI_VERIFY_SESSION_DIR:join(dir,"pi"),PI_CODING_AGENT_DIR:join(dir,"pi-config"),PI_OFFLINE:"1",PATH:`${bin}:${process.env.PATH ?? ""}`},stdout:"pipe",stderr:"pipe"});
		const [output,error,status]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
		expect(status, `${error}\nrequests=${JSON.stringify(requests)}`).toBe(0); expect(output).toContain("REMOTE_OLD_OLD_SCREEN_MARKER"); expect(output).toContain("REMOTE_NEW_FRESH_SCREEN_MARKER");
		const afterReset=output.split("--- AFTER_RESET ---\n")[1]?.split("--- AFTER ---")[0] ?? ""; expect(afterReset).not.toContain("REMOTE_OLD_OLD_SCREEN_MARKER");
		expect(requests.filter((request) => request.method === "conversation.prompt").map((request) => request.sessionId)).toEqual(["session-old", "session-new"]);
	} finally { server.close(); await rm(dir,{recursive:true,force:true}); }
},30_000);
