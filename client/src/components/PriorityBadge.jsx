export default function PriorityBadge({ priority, className = '' }) {
  if (!priority) return <span className={`priority-badge priority-unknown ${className}`}>Priority pending</span>;
  return <span className={`priority-badge ${String(priority.level || '').toLowerCase()} ${className}`} title={priority.manualOverride?.reason ? `Administrator override: ${priority.manualOverride.reason}` : 'Server-calculated priority'}>
    {priority.level || '—'} · {priority.severity || 'Unrated'} · {priority.score ?? '—'}/100{priority.manualOverride && <small>Adjusted</small>}
  </span>;
}
