import { describe, expect, test } from "bun:test";
import { estimateCost, getPricingForModel } from "./pricing";

describe("getPricingForModel()", () => {
	describe("Claude tiers", () => {
		test("matches opus by substring in full model ID", () => {
			const result = getPricingForModel("claude-opus-4-20250514");
			expect(result).not.toBeNull();
			expect(result?.inputPerMTok).toBe(15);
			expect(result?.outputPerMTok).toBe(75);
		});

		test("matches sonnet by substring in full model ID", () => {
			const result = getPricingForModel("claude-sonnet-4-20250514");
			expect(result).not.toBeNull();
			expect(result?.inputPerMTok).toBe(3);
			expect(result?.outputPerMTok).toBe(15);
		});

		test("matches haiku by substring in full model ID", () => {
			const result = getPricingForModel("claude-haiku-3-5-20241022");
			expect(result).not.toBeNull();
			expect(result?.inputPerMTok).toBe(0.8);
			expect(result?.outputPerMTok).toBe(4);
		});
	});

	describe("OpenAI tiers", () => {
		test("matches gpt-4o-mini", () => {
			const result = getPricingForModel("gpt-4o-mini");
			expect(result).not.toBeNull();
			expect(result?.inputPerMTok).toBe(0.15);
		});

		test("matches gpt-4o", () => {
			const result = getPricingForModel("gpt-4o");
			expect(result).not.toBeNull();
			expect(result?.inputPerMTok).toBe(2.5);
		});

		test("matches gpt-5", () => {
			const result = getPricingForModel("gpt-5");
			expect(result).not.toBeNull();
			expect(result?.inputPerMTok).toBe(10);
		});

		test("matches o3", () => {
			const result = getPricingForModel("o3");
			expect(result).not.toBeNull();
			expect(result?.inputPerMTok).toBe(10);
			expect(result?.outputPerMTok).toBe(40);
		});

		test("matches o1", () => {
			const result = getPricingForModel("o1");
			expect(result).not.toBeNull();
			expect(result?.inputPerMTok).toBe(15);
			expect(result?.outputPerMTok).toBe(60);
		});
	});

	describe("Priority ordering", () => {
		test("gpt-4o-mini matches before gpt-4o (substring overlap)", () => {
			const mini = getPricingForModel("gpt-4o-mini");
			const full = getPricingForModel("gpt-4o");
			expect(mini).not.toBeNull();
			expect(full).not.toBeNull();
			if (mini === null || full === null) return;
			// gpt-4o-mini is cheaper
			expect(mini.inputPerMTok).toBeLessThan(full.inputPerMTok);
			// A model string "gpt-4o-mini" resolves to mini pricing, not gpt-4o
			expect(mini.inputPerMTok).toBe(0.15);
		});

		test("o3 matches before o1 (o1 string contains o1, o3 does not contain o1)", () => {
			const o3 = getPricingForModel("o3");
			const o1 = getPricingForModel("o1");
			expect(o3).not.toBeNull();
			expect(o1).not.toBeNull();
			if (o3 === null || o1 === null) return;
			expect(o3.outputPerMTok).toBe(40);
			expect(o1.outputPerMTok).toBe(60);
		});
	});

	describe("Gemini tiers", () => {
		test("matches gemini-flash by 'flash' substring", () => {
			const result = getPricingForModel("gemini-flash-2.0");
			expect(result).not.toBeNull();
			expect(result?.inputPerMTok).toBe(0.1);
			expect(result?.outputPerMTok).toBe(0.4);
		});

		test("matches gemini-pro by 'gemini' + 'pro' substrings", () => {
			const result = getPricingForModel("gemini-2.0-pro-exp");
			expect(result).not.toBeNull();
			expect(result?.inputPerMTok).toBe(1.25);
			expect(result?.outputPerMTok).toBe(5);
		});
	});

	describe("Case insensitivity", () => {
		test("Claude-OPUS-4 resolves correctly", () => {
			const result = getPricingForModel("Claude-OPUS-4");
			expect(result).not.toBeNull();
			expect(result?.inputPerMTok).toBe(15);
		});

		test("SONNET resolves correctly", () => {
			const result = getPricingForModel("SONNET");
			expect(result).not.toBeNull();
			expect(result?.inputPerMTok).toBe(3);
		});

		test("Haiku resolves correctly", () => {
			const result = getPricingForModel("Haiku");
			expect(result).not.toBeNull();
			expect(result?.inputPerMTok).toBe(0.8);
		});
	});

	describe("Unknown models", () => {
		test("returns null for llama-3-70b", () => {
			expect(getPricingForModel("llama-3-70b")).toBeNull();
		});

		test("returns null for empty string", () => {
			expect(getPricingForModel("")).toBeNull();
		});

		test("returns null for random gibberish", () => {
			expect(getPricingForModel("xyzzy-foo-bar-9000")).toBeNull();
		});
	});
});

describe("estimateCost()", () => {
	test("Typical Claude Opus usage: 1M input, 100K output, 500K cacheRead, 200K cacheCreation → $24.00", () => {
		const cost = estimateCost({
			inputTokens: 1_000_000,
			outputTokens: 100_000,
			cacheReadTokens: 500_000,
			cacheCreationTokens: 200_000,
			modelUsed: "claude-opus-4-20250514",
		});
		// inputCost = 1 * 15 = 15.00
		// outputCost = 0.1 * 75 = 7.50
		// cacheReadCost = 0.5 * 1.5 = 0.75
		// cacheCreationCost = 0.2 * 3.75 = 0.75
		// total = 24.00
		expect(cost).toBe(24.0);
	});

	test("Typical Claude Sonnet usage: 500K input, 50K output, 100K cacheRead, 50K cacheCreation", () => {
		const cost = estimateCost({
			inputTokens: 500_000,
			outputTokens: 50_000,
			cacheReadTokens: 100_000,
			cacheCreationTokens: 50_000,
			modelUsed: "claude-sonnet-4-20250514",
		});
		// inputCost = 0.5 * 3 = 1.50
		// outputCost = 0.05 * 15 = 0.75
		// cacheReadCost = 0.1 * 0.3 = 0.03
		// cacheCreationCost = 0.05 * 0.75 = 0.0375
		// total = 2.3175
		expect(cost).toBeCloseTo(2.3175, 4);
	});

	test("Zero tokens returns 0 (not null)", () => {
		const cost = estimateCost({
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheCreationTokens: 0,
			modelUsed: "claude-opus-4",
		});
		expect(cost).toBe(0);
	});

	test("Null modelUsed returns null", () => {
		const cost = estimateCost({
			inputTokens: 1000,
			outputTokens: 500,
			cacheReadTokens: 0,
			cacheCreationTokens: 0,
			modelUsed: null,
		});
		expect(cost).toBeNull();
	});

	test("Unknown model returns null", () => {
		const cost = estimateCost({
			inputTokens: 1000,
			outputTokens: 500,
			cacheReadTokens: 0,
			cacheCreationTokens: 0,
			modelUsed: "llama-3-70b",
		});
		expect(cost).toBeNull();
	});

	test("Input-only usage: only inputTokens > 0, rest zero", () => {
		const cost = estimateCost({
			inputTokens: 1_000_000,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheCreationTokens: 0,
			modelUsed: "claude-sonnet-4",
		});
		// inputCost = 1 * 3 = 3.00
		expect(cost).toBe(3.0);
	});

	test("Output-only usage: only outputTokens > 0, rest zero", () => {
		const cost = estimateCost({
			inputTokens: 0,
			outputTokens: 1_000_000,
			cacheReadTokens: 0,
			cacheCreationTokens: 0,
			modelUsed: "claude-sonnet-4",
		});
		// outputCost = 1 * 15 = 15.00
		expect(cost).toBe(15.0);
	});

	test("Cache-heavy usage: large cacheRead + cacheCreation, verify math", () => {
		const cost = estimateCost({
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 10_000_000,
			cacheCreationTokens: 5_000_000,
			modelUsed: "claude-opus-4",
		});
		// cacheReadCost = 10 * 1.5 = 15.00
		// cacheCreationCost = 5 * 3.75 = 18.75
		// total = 33.75
		expect(cost).toBeCloseTo(33.75, 5);
	});
});

describe("Cache pricing ratios", () => {
	test("Claude cache read is 10% of input price (verified on opus)", () => {
		const pricing = getPricingForModel("claude-opus-4");
		expect(pricing).not.toBeNull();
		if (pricing === null) return;
		const ratio = pricing.cacheReadPerMTok / pricing.inputPerMTok;
		expect(ratio).toBeCloseTo(0.1, 10);
	});

	test("Claude cache creation is 25% of input price (verified on sonnet)", () => {
		const pricing = getPricingForModel("claude-sonnet-4");
		expect(pricing).not.toBeNull();
		if (pricing === null) return;
		const ratio = pricing.cacheCreationPerMTok / pricing.inputPerMTok;
		expect(ratio).toBeCloseTo(0.25, 10);
	});
});
