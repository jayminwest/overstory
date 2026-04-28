import { NavLink, Outlet } from "react-router-dom";

import { cn } from "@/lib/utils";

export function Layout() {
	return (
		<div className="flex h-screen">
			<Sidebar />
			<main className="flex-1 overflow-auto">
				<Outlet />
			</main>
		</div>
	);
}

function Sidebar() {
	return (
		<aside className="w-60 border-r border-border flex flex-col">
			<div className="p-4 border-b border-border">
				<span className="font-semibold text-sm">Overstory</span>
			</div>
			<nav className="flex-1 p-2 space-y-1">
				<SidebarLink to="/" label="Fleet" end />
				<SidebarLink to="/agents" label="Agents" />
				<SidebarLink to="/mail" label="Mail" />
			</nav>
		</aside>
	);
}

function SidebarLink({ to, label, end }: { to: string; label: string; end?: boolean }) {
	return (
		<NavLink
			to={to}
			end={end}
			className={({ isActive }) =>
				cn(
					"flex items-center px-3 py-2 rounded-md text-sm transition-colors",
					isActive
						? "bg-accent text-accent-foreground font-medium"
						: "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
				)
			}
		>
			{label}
		</NavLink>
	);
}
