import esbuild from "esbuild";

await esbuild.build({
	entryPoints: ["main.ts"],
	bundle: true,
	external: ["obsidian", "electron", "@codemirror/*", "@lezer/*"],
	format: "cjs",
	target: "es2020",
	outfile: "main.js",
	logLevel: "info",
});
