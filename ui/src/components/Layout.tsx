import { useQuery } from "@tanstack/react-query";
import { useCallback } from "react";
import { NavLink, Outlet, useSearchParams } from "react-router-dom";

import { ConnectionStatus } from "@/components/connection-status";
import { ThemeToggle } from "@/components/theme-toggle";
import { fetchRuns } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useGlobalWsStatus } from "@/lib/ws-status";
import { RunPicker } from "@/routes/fleet/RunPicker";

export function Layout() {
	return (
		<div className="flex flex-col h-screen">
			<TopBar />
			<main className="flex-1 overflow-auto">
				<Outlet />
			</main>
		</div>
	);
}

function TopBar() {
	const runsQuery = useQuery({
		queryKey: ["runs"],
		queryFn: () => fetchRuns(50),
		refetchInterval: 5000,
	});
	const runs = runsQuery.data ?? [];

	const [params, setParams] = useSearchParams();
	const selectedRunId = params.get("run") ?? runs[0]?.id ?? null;

	const setSelectedRunId = useCallback(
		(id: string) => {
			setParams(
				(prev) => {
					const next = new URLSearchParams(prev);
					next.set("run", id);
					return next;
				},
				{ replace: true },
			);
		},
		[setParams],
	);

	const wsStatus = useGlobalWsStatus();

	return (
		<header className="border-b border-border shrink-0 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
			<div className="h-14 flex items-center gap-6 px-6">
				<span className="font-semibold text-sm tracking-tight">Overstory</span>
				<nav className="flex items-center gap-1">
					<NavItem to="/coordinator" label="Coordinator" />
					<NavItem to="/" label="Fleet" end />
					<NavItem to="/mail" label="Mail" />
				</nav>
				<div className="flex-1" />
				<RunPicker runs={runs} selectedRunId={selectedRunId} onSelect={setSelectedRunId} />
				<ConnectionStatus status={wsStatus} />
				<ThemeToggle />
			</div>
		</header>
	);
}

function NavItem({ to, label, end }: { to: string; label: string; end?: boolean }) {
	return (
		<NavLink
			to={to}
			end={end}
			className={({ isActive }) =>
				cn(
					"px-3 py-1.5 rounded-md text-sm transition-colors",
					isActive
						? "bg-accent text-accent-foreground font-medium"
						: "text-muted-foreground hover:bg-accent/50 hover:text-accent-foreground",
				)
			}
		>
			{label}
		</NavLink>
	);
}
