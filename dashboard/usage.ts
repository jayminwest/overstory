#!/usr/bin/env bun
import { join } from "node:path";

const CLAUDE_DIR = join(process.env.HOME ?? "", ".claude");
const PROJECTS_DIR = join(CLAUDE_DIR, "projects");
const WINDOW_MS = 5 * 60 * 60 * 1000; // 5 hours

// Model weights for Max token accounting (Opus uses ~5x more quota than Sonnet)
const MODEL_WEIGHTS: Record<string, number> = {
	"claude-opus-4-6": 5,
	"claude-opus-4-20250514": 5,
	"claude-sonnet-4-6": 1,
	"claude-sonnet-4-20250514": 1,
	"claude-haiku-4-5-20251001": 0.2,
};

// API pricing per 1M tokens for cost estimation
const API_PRICING: Record<
	string,
	{ input: number; output: number; cacheRead: number; cacheWrite: number }
> = {
	"claude-opus-4-6": { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
	"claude-opus-4-20250514": { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
	"claude-sonnet-4-6": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
	"claude-sonnet-4-20250514": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
	"claude-haiku-4-5-20251001": { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
};

interface UsageEntry {
	timestamp: string;
	model: string;
	input_tokens: number;
	output_tokens: number;
	cache_creation_input_tokens: number;
	cache_read_input_tokens: number;
	sessionId: string;
	project: string;
}

interface ModelUsage {
	input_tokens: number;
	output_tokens: number;
	cache_creation_input_tokens: number;
	cache_read_input_tokens: number;
	requests: number;
	weighted_tokens: number;
	api_cost_usd: number;
}

async function scanJsonlFile(
	filePath: string,
	cutoff: number,
	project: string,
): Promise<UsageEntry[]> {
	const entries: UsageEntry[] = [];
	try {
		const content = await Bun.file(filePath).text();
		const lines = content.split("\n");
		for (const line of lines) {
			if (!line.trim()) continue;
			try {
				const d = JSON.parse(line);
				if (d.type !== "assistant") continue;
				const ts = d.timestamp;
				if (!ts) continue;
				const tsMs = new Date(ts).getTime();
				if (tsMs < cutoff) continue;
				const usage = d.message?.usage;
				if (!usage) continue;
				entries.push({
					timestamp: ts,
					model: d.message?.model || "unknown",
					input_tokens: usage.input_tokens || 0,
					output_tokens: usage.output_tokens || 0,
					cache_creation_input_tokens: usage.cache_creation_input_tokens || 0,
					cache_read_input_tokens: usage.cache_read_input_tokens || 0,
					sessionId: d.sessionId || "",
					project,
				});
			} catch {
				/* skip */
			}
		}
	} catch {
		/* skip */
	}
	return entries;
}

function computeApiCost(
	model: string,
	input: number,
	output: number,
	cacheRead: number,
	cacheWrite: number,
): number {
	const pricing = API_PRICING[model] ?? API_PRICING["claude-sonnet-4-6"];
	if (!pricing) return 0;
	return (
		(input / 1_000_000) * pricing.input +
		(output / 1_000_000) * pricing.output +
		(cacheRead / 1_000_000) * pricing.cacheRead +
		(cacheWrite / 1_000_000) * pricing.cacheWrite
	);
}

async function main() {
	const projectRoot = process.argv[2];
	if (!projectRoot) {
		console.log(JSON.stringify({ error: "Project root required" }));
		return;
	}

	const now = Date.now();
	const cutoff = now - WINDOW_MS;
	const allEntries: UsageEntry[] = [];

	// Derive the Claude Code project directory name (path with / replaced by -)
	const encodedPath = projectRoot.replace(/\//g, "-");
	const targetDir = join(PROJECTS_DIR, encodedPath);

	// Scan only the target project directory for JSONL files
	try {
		const glob = new Bun.Glob("*.jsonl");
		for (const file of glob.scanSync(targetDir)) {
			const filePath = join(targetDir, file);
			// Quick check: skip files not modified in the last 5 hours
			const bunFile = Bun.file(filePath);
			if (bunFile.lastModified < cutoff) continue;
			allEntries.push(...(await scanJsonlFile(filePath, cutoff, encodedPath)));
		}
	} catch {
		// Directory not accessible or doesn't exist
	}

	// Aggregate by model
	const byModel: Record<string, ModelUsage> = {};
	let totalWeighted = 0;
	let totalApiCost = 0;
	let totalRequests = 0;

	for (const entry of allEntries) {
		if (!byModel[entry.model]) {
			byModel[entry.model] = {
				input_tokens: 0,
				output_tokens: 0,
				cache_creation_input_tokens: 0,
				cache_read_input_tokens: 0,
				requests: 0,
				weighted_tokens: 0,
				api_cost_usd: 0,
			};
		}
		// biome-ignore lint: guaranteed by the block above
		const m = byModel[entry.model]!;
		m.input_tokens += entry.input_tokens;
		m.output_tokens += entry.output_tokens;
		m.cache_creation_input_tokens += entry.cache_creation_input_tokens;
		m.cache_read_input_tokens += entry.cache_read_input_tokens;
		m.requests++;

		const weight = MODEL_WEIGHTS[entry.model] ?? 1;
		const weighted = (entry.input_tokens + entry.output_tokens) * weight;
		m.weighted_tokens += weighted;
		totalWeighted += weighted;

		const cost = computeApiCost(
			entry.model,
			entry.input_tokens,
			entry.output_tokens,
			entry.cache_read_input_tokens,
			entry.cache_creation_input_tokens,
		);
		m.api_cost_usd += cost;
		totalApiCost += cost;
		totalRequests++;
	}

	// Unique sessions in window
	const uniqueSessions = new Set(allEntries.map((e) => e.sessionId)).size;
	const uniqueProjects = new Set(allEntries.map((e) => e.project)).size;

	// Total raw tokens
	const totalInput = allEntries.reduce((s, e) => s + e.input_tokens, 0);
	const totalOutput = allEntries.reduce((s, e) => s + e.output_tokens, 0);
	const totalCacheRead = allEntries.reduce((s, e) => s + e.cache_read_input_tokens, 0);
	const totalCacheWrite = allEntries.reduce((s, e) => s + e.cache_creation_input_tokens, 0);

	// Time series: bucket entries into 15-minute intervals for the last 5 hours
	const BUCKET_MS = 15 * 60 * 1000;
	const bucketCount = Math.ceil(WINDOW_MS / BUCKET_MS);
	const timeSeries: Array<{ t: string; tokens: number; weighted: number; requests: number }> = [];
	for (let i = 0; i < bucketCount; i++) {
		const bucketStart = cutoff + i * BUCKET_MS;
		const bucketEnd = bucketStart + BUCKET_MS;
		const bucketEntries = allEntries.filter((e) => {
			const t = new Date(e.timestamp).getTime();
			return t >= bucketStart && t < bucketEnd;
		});
		const tokens = bucketEntries.reduce((s, e) => s + e.input_tokens + e.output_tokens, 0);
		const weighted = bucketEntries.reduce((s, e) => {
			const w = MODEL_WEIGHTS[e.model] || 1;
			return s + (e.input_tokens + e.output_tokens) * w;
		}, 0);
		timeSeries.push({
			t: new Date(bucketStart).toISOString(),
			tokens,
			weighted,
			requests: bucketEntries.length,
		});
	}

	// Oldest and newest entry in window
	const sorted = allEntries.sort(
		(a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
	);
	const oldest = sorted[0]?.timestamp || null;
	const newest = sorted[sorted.length - 1]?.timestamp || null;

	const result = {
		window: {
			hours: 5,
			cutoff: new Date(cutoff).toISOString(),
			now: new Date(now).toISOString(),
			oldest_entry: oldest,
			newest_entry: newest,
		},
		totals: {
			input_tokens: totalInput,
			output_tokens: totalOutput,
			cache_read_input_tokens: totalCacheRead,
			cache_creation_input_tokens: totalCacheWrite,
			raw_tokens: totalInput + totalOutput,
			weighted_tokens: totalWeighted,
			requests: totalRequests,
			sessions: uniqueSessions,
			projects: uniqueProjects,
			api_cost_usd: Math.round(totalApiCost * 1000) / 1000,
		},
		by_model: byModel,
		time_series: timeSeries,
	};

	console.log(JSON.stringify(result));
}

await main();
