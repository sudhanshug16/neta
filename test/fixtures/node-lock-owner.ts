import { acquireLock } from "../../src/node/lockfile.ts";

const lock = await acquireLock();
process.stdout.write(`${lock.instanceId}\n`);
const keepAlive = setInterval(() => undefined, 1000);
process.on("SIGTERM", () => {
	void lock.release().then(() => {
		clearInterval(keepAlive);
	});
});
