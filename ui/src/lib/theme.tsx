import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useState,
} from "react";

export type Theme = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

const STORAGE_KEY = "overstory-theme";
const MEDIA_QUERY = "(prefers-color-scheme: dark)";

interface ThemeContextValue {
	theme: Theme;
	resolvedTheme: ResolvedTheme;
	setTheme: (theme: Theme) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function readStoredTheme(): Theme {
	if (typeof window === "undefined") return "system";
	try {
		const stored = window.localStorage.getItem(STORAGE_KEY);
		if (stored === "light" || stored === "dark" || stored === "system") {
			return stored;
		}
	} catch {
		// localStorage may be unavailable (private mode); fall through.
	}
	return "system";
}

function readSystemPreference(): ResolvedTheme {
	if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
		return "light";
	}
	return window.matchMedia(MEDIA_QUERY).matches ? "dark" : "light";
}

function applyDocumentClass(resolved: ResolvedTheme): void {
	if (typeof document === "undefined") return;
	document.documentElement.classList.toggle("dark", resolved === "dark");
}

export function ThemeProvider({ children }: { children: ReactNode }) {
	const [theme, setThemeState] = useState<Theme>(() => readStoredTheme());
	const [systemPref, setSystemPref] = useState<ResolvedTheme>(() => readSystemPreference());

	const resolvedTheme: ResolvedTheme = theme === "system" ? systemPref : theme;

	useEffect(() => {
		applyDocumentClass(resolvedTheme);
	}, [resolvedTheme]);

	useEffect(() => {
		if (theme !== "system") return;
		if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
		const mql = window.matchMedia(MEDIA_QUERY);
		const handler = (event: MediaQueryListEvent) => {
			setSystemPref(event.matches ? "dark" : "light");
		};
		// Always sync once on subscribe in case it changed since the initial read.
		setSystemPref(mql.matches ? "dark" : "light");
		mql.addEventListener("change", handler);
		return () => mql.removeEventListener("change", handler);
	}, [theme]);

	const setTheme = useCallback((next: Theme) => {
		setThemeState(next);
		if (typeof window === "undefined") return;
		try {
			window.localStorage.setItem(STORAGE_KEY, next);
		} catch {
			// Ignore storage failures; in-memory state still updates.
		}
	}, []);

	const value = useMemo<ThemeContextValue>(
		() => ({ theme, resolvedTheme, setTheme }),
		[theme, resolvedTheme, setTheme],
	);

	return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
	const ctx = useContext(ThemeContext);
	if (ctx) return ctx;
	// Safe fallback when no provider mounted (e.g., isolated tests, Builder 2 hasn't wired yet).
	return {
		theme: "system",
		resolvedTheme: "light",
		setTheme: () => {},
	};
}
