import { AlertCircle, Plus, RefreshCw } from 'lucide-react';
import { canCreatePrerequisite, type PrerequisiteAvailability, type PrerequisiteRule } from '../lib/prerequisite-rules';

type Props = {
  rule: PrerequisiteRule;
  availability: PrerequisiteAvailability;
  role?: string;
  error?: string;
  onCreate: () => void;
  onRetry?: () => void;
};

export function PrerequisiteFieldNotice({ rule, availability, role, error, onCreate, onRetry }: Props) {
  if (availability === 'ready') return null;
  if (availability === 'loading') {
    return <p className="prerequisite-field-notice" role="status">Loading {rule.entity} options…</p>;
  }
  if (availability === 'failed') {
    return <div className="prerequisite-field-notice prerequisite-field-error" role="alert">
      <strong><AlertCircle size={15} />Could not load {rule.entity} options</strong>
      <p>{error || 'Check your connection and try again.'}</p>
      {onRetry && <button className="button button-quiet" type="button" onClick={onRetry}><RefreshCw size={14} />Try again</button>}
    </div>;
  }

  const isFiltered = availability === 'filtered';
  const isInactive = availability === 'inactive';
  const canCreate = canCreatePrerequisite(rule, role);
  const title = isFiltered
    ? `No eligible ${rule.entity === 'class' ? 'classes' : `${rule.entity}s`} available`
    : isInactive ? `All ${rule.entity === 'teacher' ? 'teachers' : `${rule.entity}s`} are inactive` : rule.emptyTitle;
  const detail = isFiltered
    ? rule.filteredMessage
    : isInactive ? 'Existing records are inactive and cannot be selected here.' : rule.emptyMessage;

  return <div className="prerequisite-field-notice" role="status">
    <strong>{title}</strong>
    <p>{detail}</p>
    <div className="prerequisite-field-actions">
      {canCreate && <button className="button button-quiet" type="button" onClick={onCreate}><Plus size={14} />Create {rule.entity}</button>}
      {!canCreate && <small>You do not have permission to create {rule.entity === 'teacher' ? 'teachers' : `${rule.entity}s`}. Contact your School Administrator.</small>}
      <a href={rule.fullCreateRoute} target="_blank" rel="noreferrer">View {rule.entity === 'class' ? 'classes' : `${rule.entity}s`}</a>
    </div>
  </div>;
}
