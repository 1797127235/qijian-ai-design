import { useEffect, useRef, useState } from "react";

export function useExitTransition<T>(value: T | undefined, exitMs = 120) {
  const [rendered, setRendered] = useState<T | undefined>(value);
  const [closing, setClosing] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    if (value !== undefined) {
      clearTimeout(timerRef.current);
      setRendered(value);
      setClosing(false);
      return;
    }
    if (rendered === undefined) return;
    setClosing(true);
    timerRef.current = setTimeout(() => {
      setRendered(undefined);
      setClosing(false);
    }, exitMs);
    return () => clearTimeout(timerRef.current);
    // rendered 只取当前快照，不随其变化重跑
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, exitMs]);

  return { rendered, closing };
}
