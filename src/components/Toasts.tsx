import { CheckCircleIcon, InfoIcon, WarningIcon, XCircleIcon } from "@phosphor-icons/react";
import { useCallback, useMemo, useState, type ReactNode } from "react";

import { ToastContext, type ToastTone } from "../toast";

const toastIcons = { success: CheckCircleIcon, warning: WarningIcon, error: XCircleIcon, info: InfoIcon };

type ToastMessage = { id: number; tone: ToastTone; message: string };

// Short confirmations of what just happened, bottom right. Errors that need a decision stay
// inline next to what failed instead.
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const toast = useCallback((message: string, tone: ToastTone = "info") => {
    const id = Date.now() + Math.random();
    setToasts((current) => [...current, { id, tone, message }]);
    window.setTimeout(() => setToasts((current) => current.filter((item) => item.id !== id)), 4_500);
  }, []);
  const value = useMemo(() => ({ toast }), [toast]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toast-stack" aria-live="polite">
        {toasts.map((item) => {
          const Icon = toastIcons[item.tone];
          return <div className={`toast toast--${item.tone}`} key={item.id}>
            <Icon className="toast__icon" size={18} weight="fill" aria-hidden /><span>{item.message}</span>
          </div>;
        })}
      </div>
    </ToastContext.Provider>
  );
}
