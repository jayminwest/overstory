import type { CliBase, ProviderConfig } from "../types.ts";

/**
 * Build runtime-specific provider environment overlays.
 *
 * This maps provider configuration onto runtime-specific env names so a single
 * provider definition can be adapted to different CLI/runtime expectations.
 */
export function buildProviderRuntimeEnv(
	providerName: string,
	providerConfig: ProviderConfig,
	cliBase: CliBase,
): Record<string, string> {
	if (!providerConfig.runtimes.includes(cliBase)) {
		const supported = providerConfig.runtimes.join(", ");
		throw new Error(
			`Provider "${providerName}" does not support runtime "${cliBase}" (supported: ${supported})`,
		);
	}

	const adapter = providerConfig.adapters?.[cliBase];
	if (adapter === undefined) {
		return {};
	}

	const env: Record<string, string> = {};

	if (adapter.staticEnv !== undefined) {
		Object.assign(env, adapter.staticEnv);
	}

	if (adapter.baseUrlEnv !== undefined) {
		if (typeof providerConfig.baseUrl !== "string" || providerConfig.baseUrl.trim().length === 0) {
			throw new Error(
				`Provider "${providerName}" adapter for runtime "${cliBase}" requires provider.baseUrl`,
			);
		}
		env[adapter.baseUrlEnv] = providerConfig.baseUrl;
	}

	if (adapter.authTokenTargetEnv !== undefined) {
		if (
			typeof providerConfig.authTokenEnv !== "string" ||
			providerConfig.authTokenEnv.trim().length === 0
		) {
			throw new Error(
				`Provider "${providerName}" adapter for runtime "${cliBase}" requires provider.authTokenEnv`,
			);
		}

		const sourceToken = process.env[providerConfig.authTokenEnv];
		if (typeof sourceToken !== "string" || sourceToken.trim().length === 0) {
			throw new Error(
				`Missing required auth token env "${providerConfig.authTokenEnv}" for provider "${providerName}" runtime "${cliBase}"`,
			);
		}

		env[adapter.authTokenTargetEnv] = sourceToken;
	}

	return env;
}

/**
 * Build runtime-specific CLI args contributed by a provider adapter.
 */
export function buildProviderRuntimeCliArgs(
	providerConfig: ProviderConfig,
	cliBase: CliBase,
): string[] {
	const adapter = providerConfig.adapters?.[cliBase];
	if (adapter?.commandArgs === undefined) {
		return [];
	}
	return adapter.commandArgs;
}
