import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router-dom";

import { CommandPalette } from "@/components/command-palette";
import { Layout } from "@/components/Layout";
import { ThemeProvider } from "@/lib/theme";
import { Toaster } from "@/lib/toast";
import { WsStatusProvider } from "@/lib/ws-status";
import { AgentDetail } from "@/routes/AgentDetail";
import { ConsolePage } from "@/routes/coordinator/ConsolePage";
import { Home } from "@/routes/Home";
import { Mail } from "@/routes/Mail";

import "./index.css";

const queryClient = new QueryClient({
	defaultOptions: {
		queries: {
			refetchOnWindowFocus: false,
		},
	},
});

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("Root element not found");

createRoot(rootEl).render(
	<StrictMode>
		<ThemeProvider>
			<WsStatusProvider>
				<QueryClientProvider client={queryClient}>
					<BrowserRouter>
						<CommandPalette>
							<Routes>
								<Route path="/" element={<Layout />}>
									<Route index element={<Home />} />
									<Route path="/agents/:name" element={<AgentDetail />} />
									<Route path="coordinator" element={<ConsolePage />} />
									<Route path="mail" element={<Mail />} />
									<Route
										path="*"
										element={
											<div className="p-6 text-muted-foreground text-sm">404 — page not found.</div>
										}
									/>
								</Route>
							</Routes>
						</CommandPalette>
						<Toaster />
					</BrowserRouter>
				</QueryClientProvider>
			</WsStatusProvider>
		</ThemeProvider>
	</StrictMode>,
);
