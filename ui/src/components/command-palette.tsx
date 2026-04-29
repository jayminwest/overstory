import { useQuery } from "@tanstack/react-query";
import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useState,
} from "react";
import { useNavigate } from "react-router-dom";

import {
	CommandDialog,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
	CommandSeparator,
} from "@/components/ui/command";
import { fetchRuns } from "@/lib/api";
import { useTheme } from "@/lib/theme";

interface CommandPaletteContextValue {
	open: boolean;
	setOpen: (open: boolean) => void;
}

const CommandPaletteContext = createContext<CommandPaletteContextValue | null>(null);

export function useCommandPalette(): CommandPaletteContextValue {
	const ctx = useContext(CommandPaletteContext);
	if (ctx) return ctx;
	return { open: false, setOpen: () => {} };
}

function isComposerFocused(): boolean {
	if (typeof document === "undefined") return false;
	const el = document.activeElement;
	if (!el) return false;
	const tag = el.tagName.toLowerCase();
	if (tag === "textarea" || tag === "input") return true;
	if ((el as HTMLElement).isContentEditable) return true;
	return false;
}

export function CommandPalette({ children }: { children?: ReactNode }) {
	const [open, setOpen] = useState(false);
	const { setTheme } = useTheme();
	const navigate = useNavigate();

	const value = useMemo<CommandPaletteContextValue>(() => ({ open, setOpen }), [open]);

	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key !== "k" && event.key !== "K") return;
			if (!(event.metaKey || event.ctrlKey)) return;
			if (isComposerFocused()) return;
			event.preventDefault();
			setOpen((prev) => !prev);
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, []);

	const runsQuery = useQuery({
		queryKey: ["runs"],
		queryFn: () => fetchRuns(5),
		enabled: open,
	});

	const runItems = runsQuery.data?.slice(0, 5) ?? [];

	const select = useCallback((fn: () => void) => {
		fn();
		setOpen(false);
	}, []);

	return (
		<CommandPaletteContext.Provider value={value}>
			{children}
			<CommandDialog open={open} onOpenChange={setOpen}>
				<CommandInput placeholder="Type a command or search…" />
				<CommandList>
					<CommandEmpty>No results found.</CommandEmpty>
					<CommandGroup heading="Theme">
						<CommandItem onSelect={() => select(() => setTheme("light"))}>Theme: Light</CommandItem>
						<CommandItem onSelect={() => select(() => setTheme("dark"))}>Theme: Dark</CommandItem>
						<CommandItem onSelect={() => select(() => setTheme("system"))}>
							Theme: System
						</CommandItem>
					</CommandGroup>
					<CommandSeparator />
					<CommandGroup heading="Navigate">
						<CommandItem onSelect={() => select(() => navigate("/coordinator"))}>
							Go to Coordinator
						</CommandItem>
						<CommandItem onSelect={() => select(() => navigate("/"))}>Go to Fleet</CommandItem>
						<CommandItem onSelect={() => select(() => navigate("/mail"))}>Go to Mail</CommandItem>
					</CommandGroup>
					{runItems.length > 0 && (
						<>
							<CommandSeparator />
							<CommandGroup heading="Recent runs">
								{runItems.map((run) => (
									<CommandItem
										key={run.id}
										onSelect={() => select(() => navigate(`/?run=${encodeURIComponent(run.id)}`))}
									>
										{`Recent run: ${run.id}`}
									</CommandItem>
								))}
							</CommandGroup>
						</>
					)}
				</CommandList>
			</CommandDialog>
		</CommandPaletteContext.Provider>
	);
}
