// Type the `.md` string imports in `src/tools/prompts/`: the agreements are
// inlined into the bundle, so no declaration here may ever export a value.
declare module "*.md" {
	const text: string;
	export default text;
}
