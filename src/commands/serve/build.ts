/**
 * Auto-build helper for `ov serve` (production mode).
 *
 * Detects whether ui/dist/index.html is missing or older than any tracked
 * source/config file in the ui/ workspace, runs `bun install` (only if
 * node_modules is missing) followed by `bun run build` when so. Silent when
 * the existing build is up to date.
 *
 * The runner and filesystem helpers are injectable so tests can drive the
 * decision logic without invoking real subprocess builds.
 */

import {
	existsSync as defaultExistsSync,
	readdirSync as defaultReaddirSync,
	statSync as defaultStatSync,
} from "node:fs";
import { join, sep } from "node:path";

export interface RunnerResult {
	exitCode: number;
	stderr: string;
}

export interface EnsureUiBuildOptions {
	uiDir: string;
	log?: (msg: string) => void;
	_statSync?: typeof defaultStatSync;
	_existsSync?: typeof defaultExistsSync;
	_readdirSync?: typeof defaultReaddirSync;
	_runner?: (cmd: string[], cwd: string) => Promise<RunnerResult>;
}

/** Files at the workspace root that affect the build output. */
const ROOT_TRACKED_FILES = [
	"index.html",
	"build.ts",
	"package.json",
	"tsconfig.app.json",
	"tsconfig.json",
	"components.json",
];

/**
 * Recursively walk a directory, calling visit() on each regular file path.
 * Skips entries that throw on stat (broken symlinks, races during npm
 * install). Uses the injected readdir/stat for testability.
 */
function walkDir(
	dir: string,
	visit: (path: string) => void,
	exists: typeof defaultExistsSync,
	readdir: typeof defaultReaddirSync,
	stat: typeof defaultStatSync,
): void {
	if (!exists(dir)) return;
	let entries: string[];
	try {
		entries = readdir(dir);
	} catch {
		return;
	}
	for (const name of entries) {
		const full = dir + sep + name;
		let st: ReturnType<typeof defaultStatSync>;
		try {
			st = stat(full);
		} catch {
			continue;
		}
		if (st.isDirectory()) {
			walkDir(full, visit, exists, readdir, stat);
		} else if (st.isFile()) {
			visit(full);
		}
	}
}

async function defaultRunner(cmd: string[], cwd: string): Promise<RunnerResult> {
	if (cmd.length === 0) {
		throw new Error("ensureUiBuild runner: empty command");
	}
	const proc = Bun.spawn(cmd as string[], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});

	const stderrChunks: string[] = [];
	const pipe = async (
		stream: ReadableStream<Uint8Array> | null,
		sink: (line: string) => void,
		capture?: string[],
	): Promise<void> => {
		if (stream === null) return;
		const decoder = new TextDecoder();
		let buf = "";
		const reader = stream.getReader();
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				const chunk = decoder.decode(value, { stream: true });
				if (capture) capture.push(chunk);
				buf += chunk;
				let idx = buf.indexOf("\n");
				while (idx !== -1) {
					sink(buf.slice(0, idx));
					buf = buf.slice(idx + 1);
					idx = buf.indexOf("\n");
				}
			}
			if (buf.length > 0) sink(buf);
		} finally {
			reader.releaseLock();
		}
	};

	const writeOut = (line: string): void => {
		process.stderr.write(`[ui-build] ${line}\n`);
	};

	await Promise.all([pipe(proc.stdout, writeOut), pipe(proc.stderr, writeOut, stderrChunks)]);

	const exitCode = await proc.exited;
	return { exitCode, stderr: stderrChunks.join("") };
}

/**
 * Ensure that ui/dist/ has a build that is newer than every tracked source
 * file. No-op when the build is current. Throws when a required subprocess
 * (install / build) fails; the thrown Error includes the captured stderr.
 */
export async function ensureUiBuild(opts: EnsureUiBuildOptions): Promise<void> {
	const exists = opts._existsSync ?? defaultExistsSync;
	const stat = opts._statSync ?? defaultStatSync;
	const readdir = opts._readdirSync ?? defaultReaddirSync;
	const runner = opts._runner ?? defaultRunner;
	const log =
		opts.log ??
		((msg: string): void => {
			process.stderr.write(`[ui-build] ${msg}\n`);
		});

	const distIndex = join(opts.uiDir, "dist", "index.html");
	let needBuild = false;
	if (!exists(distIndex)) {
		needBuild = true;
	} else {
		let distMtime = 0;
		try {
			distMtime = stat(distIndex).mtimeMs;
		} catch {
			needBuild = true;
		}

		if (!needBuild) {
			let newest = 0;
			const visit = (path: string): void => {
				try {
					const m = stat(path).mtimeMs;
					if (m > newest) newest = m;
				} catch {
					// File vanished between readdir and stat — ignore.
				}
			};

			walkDir(join(opts.uiDir, "src"), visit, exists, readdir, stat);
			for (const name of ROOT_TRACKED_FILES) {
				const full = join(opts.uiDir, name);
				if (exists(full)) visit(full);
			}

			if (newest > distMtime) needBuild = true;
		}
	}

	if (!needBuild) return;

	if (!exists(join(opts.uiDir, "node_modules"))) {
		log("Installing UI dependencies…");
		const install = await runner(["bun", "install"], opts.uiDir);
		if (install.exitCode !== 0) {
			throw new Error(
				`UI dependency install failed (exit ${install.exitCode}): ${install.stderr.trim()}`,
			);
		}
	}

	log("Building UI…");
	const build = await runner(["bun", "run", "build"], opts.uiDir);
	if (build.exitCode !== 0) {
		throw new Error(`UI build failed (exit ${build.exitCode}): ${build.stderr.trim()}`);
	}
	log("UI built");
}
