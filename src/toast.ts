import { createContext, useContext } from "react";

export type ToastTone = "success" | "warning" | "error" | "info";

export const ToastContext = createContext<{ toast: (message: string, tone?: ToastTone) => void } | null>(null);

const silent = () => undefined;

// Outside the provider (a page rendered on its own), toasts are dropped; the action still happens.
export function useToast(): (message: string, tone?: ToastTone) => void {
  return useContext(ToastContext)?.toast ?? silent;
}
