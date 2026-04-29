import {
	createContext,
	type ReactNode,
	useContext,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
} from "react";

import type { WsStatus } from "./ws";

export type GlobalWsStatus = WsStatus | "idle";

interface WsStatusRegistry {
	register: (key: string, status: WsStatus | null) => void;
	unregister: (key: string) => void;
}

interface WsStatusContextValue {
	registry: WsStatusRegistry;
	aggregate: GlobalWsStatus;
}

const WsStatusContext = createContext<WsStatusContextValue | null>(null);

function aggregate(map: Map<string, WsStatus>): GlobalWsStatus {
	if (map.size === 0) return "idle";
	let hasConnecting = false;
	let hasClosed = false;
	for (const status of map.values()) {
		if (status === "open") return "open";
		if (status === "connecting") hasConnecting = true;
		else if (status === "closed") hasClosed = true;
	}
	if (hasConnecting) return "connecting";
	if (hasClosed) return "closed";
	return "idle";
}

export function WsStatusProvider({ children }: { children: ReactNode }) {
	// Stable map across renders.
	const mapRef = useRef<Map<string, WsStatus>>(new Map());
	const [agg, setAgg] = useState<GlobalWsStatus>("idle");

	const registry = useMemo<WsStatusRegistry>(() => {
		const recompute = () => setAgg(aggregate(mapRef.current));
		return {
			register: (key, status) => {
				if (status === null) {
					if (mapRef.current.delete(key)) recompute();
					return;
				}
				const prev = mapRef.current.get(key);
				if (prev === status) return;
				mapRef.current.set(key, status);
				recompute();
			},
			unregister: (key) => {
				if (mapRef.current.delete(key)) recompute();
			},
		};
	}, []);

	const value = useMemo<WsStatusContextValue>(
		() => ({ registry, aggregate: agg }),
		[registry, agg],
	);

	return <WsStatusContext.Provider value={value}>{children}</WsStatusContext.Provider>;
}

export function useGlobalWsStatus(): GlobalWsStatus {
	const ctx = useContext(WsStatusContext);
	return ctx?.aggregate ?? "idle";
}

/**
 * Internal hook: registers the caller's current WsStatus with the provider.
 * Pass `null` when the websocket is inactive (e.g., url=null) to keep the
 * caller from polluting the aggregate. No-op when no provider is mounted.
 */
export function useRegisterWsStatus(status: WsStatus | null): void {
	const ctx = useContext(WsStatusContext);
	const key = useId();

	useEffect(() => {
		if (!ctx) return;
		ctx.registry.register(key, status);
	}, [ctx, key, status]);

	useEffect(() => {
		if (!ctx) return;
		return () => ctx.registry.unregister(key);
	}, [ctx, key]);
}
