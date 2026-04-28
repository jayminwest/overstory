import { rm } from "node:fs/promises";
import bunPluginTailwind from "bun-plugin-tailwind";

const outdir = "./dist";
await rm(outdir, { recursive: true, force: true });

const result = await Bun.build({
	entrypoints: ["./index.html"],
	outdir,
	plugins: [bunPluginTailwind],
	minify: true,
	sourcemap: "linked",
	target: "browser",
});

if (!result.success) {
	for (const log of result.logs) console.error(log);
	process.exit(1);
}

for (const out of result.outputs) {
	console.log(`  ${out.path}  ${(out.size / 1024).toFixed(2)} KB`);
}
