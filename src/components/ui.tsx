import type { ReactNode } from "react";

export function Badge({ tone = "soft", children }: { tone?: "hard" | "soft" | "tbc" | "ok" | "ban"; children: ReactNode }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}

export function Seal({
  pending,
  disabled,
  onClick,
  children,
}: {
  pending?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  children: ReactNode;
}) {
  if (pending) {
    return (
      <button type="button" className="seal pending" disabled={disabled} onClick={onClick}>
        {children}
      </button>
    );
  }
  return <span className="seal">{children}</span>;
}

export function GateBar({ note, children }: { note: string; children: ReactNode }) {
  return (
    <div className="gate-bar">
      {children}
      <span className="note">{note}</span>
    </div>
  );
}

export function TaskState({
  title,
  detail,
  error,
  action,
}: {
  title: string;
  detail: string;
  error?: boolean;
  action?: ReactNode;
}) {
  return (
    <div className="task-state">
      <div className="box">
        {!error && <div className="pulse-dot" aria-hidden="true" />}
        <h2 className="h-card">{title}</h2>
        <p className={`lede ${error ? "error-text" : ""}`} role={error ? "alert" : undefined}>{detail}</p>
        {action}
      </div>
    </div>
  );
}

export function Spinner() {
  return <span className="spin" aria-hidden="true" />;
}
