import { createServer } from "node:http";

// A disposable OpenAI-compatible stream for the built-bundle smoke test.
// No model account, credentials, or network service is involved.
const server = createServer((request, response) => {
	request.resume();
	if (request.method !== "POST" || !request.url?.endsWith("/chat/completions")) {
		response.writeHead(404).end();
		return;
	}
	const chunks = [
		{
			choices: [{ index: 0, delta: { role: "assistant", content: "smoke native reply" } }],
		},
		{
			choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
		},
	];
	response.writeHead(200, { "content-type": "text/event-stream" });
	for (const chunk of chunks)
		response.write(
			`data: ${JSON.stringify({ id: "smoke-reply", object: "chat.completion.chunk", created: 1, model: "test-model", ...chunk })}\n\n`,
		);
	response.end("data: [DONE]\n\n");
});

server.listen(0, "127.0.0.1", () => {
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("fake model listener did not start");
	process.stdout.write(`http://127.0.0.1:${address.port}\n`);
});
