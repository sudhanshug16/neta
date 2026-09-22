import { copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
const target = join(import.meta.dir, "..", "dist", "toad");
await mkdir(target, { recursive: true });
for (const file of ["app.py", "bridge.py", "node_client.py", "navigation.py", "prefix.py", "machines.py", "fixture.py", "pyproject.toml", "uv.lock", "README.md"]) {
	await copyFile(join(import.meta.dir, "..", "prototypes", "toad-mvp", file), join(target, file));
}
