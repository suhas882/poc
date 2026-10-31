import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';

const ToastCtx = createContext<(message: string) => void>(() => {});

/** One polite live region for short confirmations ("Note saved", "Route recorded"). */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [message, setMessage] = useState('');
  const timer = useRef<number>();
  const show = useCallback((m: string) => {
    setMessage(m);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setMessage(''), 3200);
  }, []);
  return (
    <ToastCtx.Provider value={show}>
      {children}
      <div className={`toast${message ? ' is-visible' : ''}`} role="status" aria-live="polite">{message}</div>
    </ToastCtx.Provider>
  );
}

export const useToast = () => useContext(ToastCtx);
