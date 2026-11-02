import { useEffect } from 'react';
import { CircleAlert, CircleCheck, Info, TriangleAlert, X } from 'lucide-react';
import { useViewer } from '../store';

const ICONS = { info: Info, success: CircleCheck, warning: TriangleAlert, error: CircleAlert };

export function Toast() {
  const toast = useViewer((s) => s.toast);
  useEffect(() => {
    // A question stays available until the user answers or dismisses it.
    if (!toast || toast.actions?.length) return;
    const timer = setTimeout(() => useViewer.setState({ toast: null }), toast.tone === 'error' || toast.tone === 'warning' ? 7000 : 3500);
    return () => clearTimeout(timer);
  }, [toast]);
  if (!toast) return null;
  const Icon = ICONS[toast.tone];
  return (
    <div className="toast" role={toast.tone === 'error' ? 'alert' : 'status'} data-tone={toast.tone} key={toast.id}>
      <Icon className="toast__icon" size={16} aria-hidden />
      <span className="toast__message">{toast.message}</span>
      {!!toast.actions?.length && <div className="toast__actions">
        {toast.actions.map((action) => (
          <button key={action.label} className="btn btn--primary toast__action" onClick={() => {
            action.onClick();
            if (useViewer.getState().toast?.id === toast.id) useViewer.setState({ toast: null });
          }}>{action.label}</button>
        ))}
      </div>}
      <button className="icon-btn icon-btn--bare toast__dismiss" aria-label="Dismiss" onClick={() => useViewer.setState({ toast: null })}>
        <X size={14} />
      </button>
    </div>
  );
}
