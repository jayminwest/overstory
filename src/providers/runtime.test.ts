import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { buildProviderRuntimeCliArgs, buildProviderRuntimeEnv } from "./runtime.ts";

describe("buildProviderRuntimeEnv", () => {
	let envSnapshot: Record<string, string | undefined>;

	beforeEach(() => {
		envSnapshot = {
			OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
			OPENAI_API_KEY: process.env.OPENAI_API_KEY,
			OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
			EXTRA_FLAG: process.env.EXTRA_FLAG,
		};
	});

	afterEach(() => {
		for (const [key, value] of Object.entries(envSnapshot)) {
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
	});

	test("applies static env and adapter base/token mappings", () => {
		process.env.OPENROUTER_API_KEY = "secret-token";

		const env = buildProviderRuntimeEnv(
			"openrouter",
			{
				type: "gateway",
				runtimes: ["codex"],
				baseUrl: "https://openrouter.ai/api/v1",
				authTokenEnv: "OPENROUTER_API_KEY",
				adapters: {
					codex: {
						staticEnv: { EXTRA_FLAG: "enabled" },
						baseUrlEnv: "OPENAI_BASE_URL",
						authTokenTargetEnv: "OPENAI_API_KEY",
					},
				},
			},
			"codex",
		);

		expect(env).toEqual({
			EXTRA_FLAG: "enabled",
			OPENAI_BASE_URL: "https://openrouter.ai/api/v1",
			OPENAI_API_KEY: "secret-token",
		});
	});

	test("throws clear error when runtime is not supported by provider", () => {
		expect(() =>
			buildProviderRuntimeEnv(
				"anthropic",
				{
					type: "native",
					runtimes: ["claude"],
				},
				"codex",
			),
		).toThrow(/does not support runtime "codex"/);
	});

	test("throws clear error when mapped auth token is missing", () => {
		delete process.env.OPENROUTER_API_KEY;

		expect(() =>
			buildProviderRuntimeEnv(
				"openrouter",
				{
					type: "gateway",
					runtimes: ["codex"],
					baseUrl: "https://openrouter.ai/api/v1",
					authTokenEnv: "OPENROUTER_API_KEY",
					adapters: {
						codex: {
							authTokenTargetEnv: "OPENAI_API_KEY",
						},
					},
				},
				"codex",
			),
		).toThrow(/Missing required auth token env "OPENROUTER_API_KEY"/);
	});

	test("returns empty env when no adapter exists for runtime", () => {
		const env = buildProviderRuntimeEnv(
			"codex",
			{
				type: "native",
				runtimes: ["codex"],
			},
			"codex",
		);

		expect(env).toEqual({});
	});
});

describe("buildProviderRuntimeCliArgs", () => {
	test("returns adapter command args when configured", () => {
		const args = buildProviderRuntimeCliArgs(
			{
				type: "native",
				runtimes: ["codex"],
				adapters: {
					codex: {
						commandArgs: ["--dangerously-bypass-approvals-and-sandbox"],
					},
				},
			},
			"codex",
		);

		expect(args).toEqual(["--dangerously-bypass-approvals-and-sandbox"]);
	});

	test("returns empty args when adapter has none", () => {
		const args = buildProviderRuntimeCliArgs(
			{
				type: "native",
				runtimes: ["codex"],
				adapters: {
					codex: {},
				},
			},
			"codex",
		);
		expect(args).toEqual([]);
	});
});
