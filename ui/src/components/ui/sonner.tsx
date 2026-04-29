import { Toaster as SonnerToaster, type ToasterProps } from "sonner";

import { useTheme } from "@/lib/theme";

function Toaster({ ...props }: ToasterProps) {
	const { resolvedTheme } = useTheme();
	return (
		<SonnerToaster
			theme={resolvedTheme}
			className="toaster group"
			position="bottom-right"
			richColors
			closeButton
			{...props}
		/>
	);
}

export { Toaster };
