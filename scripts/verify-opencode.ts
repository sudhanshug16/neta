import { access, constants, readFile } from "node:fs/promises";
import { join } from "node:path";
import { readPin, repositoryRoot, sha256 } from "./opencode-pin.ts";

const pin = await readPin();
const platforms = process.argv.includes("--all")
	? ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"] : [`${process.platform}-${process.arch}`];
for (const platform of platforms) {
	const dir = join(repositoryRoot, "dist/opencode", platform);
	const manifest = JSON.parse(await readFile(join(dir, "build-manifest.json"), "utf8"));
	const marker = JSON.parse(await readFile(join(dir, "neta-fork.json"), "utf8"));
	await access(join(dir, "opencode"), constants.X_OK);
	if (!(await readFile(join(dir, "LICENSE"), "utf8")).trim()) throw new Error(`Missing OpenCode license: ${platform}`);
	if (manifest.format !== 1 || manifest.certifiedSource !== true || manifest.platform !== platform
		|| manifest.upstreamCommit !== pin.commit || manifest.overlaySha256 !== pin.overlaySha256
		|| manifest.lockSha256 !== pin.lockSha256 || marker.integrationVersion !== pin.integrationVersion
		|| manifest.executableSha256 !== sha256(await readFile(join(dir, "opencode"))))
		throw new Error(`OpenCode artifact does not match reviewed integration: ${platform}`);
	console.log(`Verified OpenCode artifact ${platform}`);
}
