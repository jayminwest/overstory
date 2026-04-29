import { toast as sonnerToast } from "sonner";

interface ToastOptions {
	description?: string;
}

export const toast = {
	success: (msg: string, opts?: ToastOptions): void => {
		sonnerToast.success(msg, opts);
	},
	error: (msg: string, opts?: ToastOptions): void => {
		sonnerToast.error(msg, opts);
	},
	info: (msg: string, opts?: ToastOptions): void => {
		sonnerToast.info(msg, opts);
	},
};

export { Toaster } from "@/components/ui/sonner";
