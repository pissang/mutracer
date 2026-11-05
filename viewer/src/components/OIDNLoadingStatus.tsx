import { LoaderCircle } from 'lucide-react';
import { useViewer } from '../store';

export function OIDNLoadingStatus() {
  const loading = useViewer((s) => s.oidnLoading);
  if (!loading) return null;
  return (
    <div className="float oidn-loading" role="status">
      <LoaderCircle size={14} aria-hidden="true" />
      <span>Loading OIDN…</span>
    </div>
  );
}
