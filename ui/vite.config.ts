import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [react(), tailwindcss()],
	resolve: {
		alias: {
			"@": path.resolve(__dirname, "./src"),
		},
	},
	server: {
		port: 5173,
		proxy: {
			"/api": {
				target: process.env.OVERSTORY_SERVE_URL ?? "http://localhost:8080",
				changeOrigin: true,
			},
			"/ws": {
				target: process.env.OVERSTORY_SERVE_URL ?? "http://localhost:8080",
				ws: true,
				changeOrigin: true,
			},
		},
	},
	build: {
		outDir: "dist",
	},
});
