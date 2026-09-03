#!/usr/bin/env node
// The `neta` command entry. Command parsing lands here in workstream 08; until
// then this is an empty program that builds, runs and exits 0.
export async function main(_argv: string[]): Promise<number> {
	return 0;
}

if (process.argv[1]?.endsWith("main.js")) {
	void main(process.argv.slice(2)).then((code) => process.exit(code));
}
