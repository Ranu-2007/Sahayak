import { useMemo, useState } from 'react';
import { Activity, AlertTriangle, ArrowRight, MapPin, PackageCheck, PackageSearch, ShieldCheck, Siren, Users } from 'lucide-react';
import CoordinationMap from './CoordinationMap.jsx';
import PriorityBadge from './PriorityBadge.jsx';
import { filterAndRankComplaints } from './resolverComplaints.js';
import api from '../api.js';
import IncidentDetails from './IncidentDetails.jsx';
import './dashboard-overrides.css';
import './incident-live.css';

const knownCoordinates = coordinates => Array.isArray(coordinates) && coordinates.length === 2 && coordinates.every(Number.isFinite) && !(coordinates[0] === 0 && coordinates[1] === 0);
function straightLineDistance(a, b) {
  const radians = value => value * Math.PI / 180;
  const dLat = radians(b[1] - a[1]), dLon = radians(b[0] - a[0]);
  const factor = Math.sin(dLat / 2) ** 2 + Math.cos(radians(a[1])) * Math.cos(radians(b[1])) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(factor), Math.sqrt(1 - factor));
}
function Card({ icon: Icon, label, value, detail, tone = 'green', loading, onClick }) {
  return <button type="button" className={`dashboard-summary-card ${tone}`} onClick={onClick} aria-label={`${label}: ${loading ? 'loading' : value}. ${detail}`}><span className="dashboard-summary-icon"><Icon size={17}/></span><span className="dashboard-summary-label">{label}</span>{loading ? <span className="kpi-skeleton" aria-hidden="true"/> : <strong key={value} className="kpi-value">{value}</strong>}<small>{detail}</small><span className="kpi-open-hint">Open filtered view <ArrowRight size={12}/></span></button>;
}
function assignedProvider(request) {
  const assignment = (request.assignments || []).find(item => ['offered', 'accepted', 'in_progress', 'partially_fulfilled'].includes(item.status)) || (request.assignments || []).at(-1);
  if (!assignment) return 'Unassigned';
  const providerName = assignment.provider?.name || 'Provider';
  return assignment.status === 'offered' ? `Offer pending acceptance · ${providerName}` : providerName;
}
function availabilityGroups(providers) {
  const groups = { Available: [], Busy: [], Unavailable: [], 'Pending verification': [], 'Needs reconfirmation': [] };
  for (const provider of providers) {
    const age = provider.lastAvailabilityUpdated ? (Date.now() - new Date(provider.lastAvailabilityUpdated).getTime()) / 60000 : Infinity;
    if (provider.verificationStatus !== 'verified') groups['Pending verification'].push(provider);
    else if (provider.availability === 'unavailable') groups.Unavailable.push(provider);
    else if (!Number.isFinite(age) || age > 60) groups['Needs reconfirmation'].push(provider);
    else if (provider.availability === 'limited' || (provider.currentWorkload || 0) > 0) groups.Busy.push(provider);
    else if (provider.availability === 'available') groups.Available.push(provider);
    else groups['Needs reconfirmation'].push(provider);
  }
  return groups;
}

function formatAge(hours) {
  if (!Number.isFinite(hours)) return 'Time unavailable';
  if (hours < 1) return `${Math.max(1, Math.floor(hours * 60))} min`;
  const whole = Math.floor(hours), minutes = Math.floor((hours - whole) * 60);
  return `${whole}h${minutes ? ` ${minutes}m` : ''}`;
}
export default function CoordinationDashboard({ requests, providers, summary, incidents = [], liveStatus, loading, error, role, selectedId, onSelectRequest, matchesByRequest, matchSummaries, busy, onLoadMatches, onVerifyRequest, onAssign, onRefresh, onNavigate }) {
  const selected = requests.find(row => String(row._id) === String(selectedId));
  const [priorityFilter, setPriorityFilter] = useState('all');
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [minAffected, setMinAffected] = useState('');
  const [unassignedOnly, setUnassignedOnly] = useState(false);
  const [nearbyCenter, setNearbyCenter] = useState(null);
  const [nearbyMessage, setNearbyMessage] = useState('');
  const [prioritySaving, setPrioritySaving] = useState(false);
  const [priorityError, setPriorityError] = useState('');
  const [priorityNotice, setPriorityNotice] = useState('');
  const [openIncidentId, setOpenIncidentId] = useState('');
  const [incidentCategory, setIncidentCategory] = useState('all');
  const [incidentLocation, setIncidentLocation] = useState('');
  const [incidentSeverity, setIncidentSeverity] = useState('all');
  const [incidentPriority, setIncidentPriority] = useState('all');
  const [incidentStatus, setIncidentStatus] = useState('active');
  const [incidentResponderFilter, setIncidentResponderFilter] = useState('all');
  const matchable = selected && ['verified', 'awaiting_match', 'matching'].includes(selected.status) && new Date(selected.responseDeadline) > new Date();
  const groups = useMemo(() => availabilityGroups(providers), [providers]);
  const availableResources = summary?.availableResources || [];
  const categories = [...new Set(requests.map(row => row.category).filter(Boolean))].sort();
  const incidentCategories = [...new Set(incidents.map(row => row.category).filter(Boolean))].sort();
  const visibleIncidents = incidents.filter(incident => (incidentCategory === 'all' || incident.category === incidentCategory) && (!incidentLocation.trim() || `${incident.location} ${incident.title}`.toLowerCase().includes(incidentLocation.trim().toLowerCase())) && (incidentSeverity === 'all' || incident.priority?.severity?.toLowerCase() === incidentSeverity || incident.maximumSeverity === incidentSeverity) && (incidentPriority === 'all' || incident.priority?.level === incidentPriority) && (incidentStatus === 'all' || incident.status === incidentStatus) && (incidentResponderFilter === 'all' || incidentResponderFilter === 'active' && Number(incident.responderCount || 0) > 0 || incidentResponderFilter === 'unassigned' && Number(incident.responderCount || 0) === 0));
  const incidentStats = summary?.incidents || {};
  const jumpTo = id => requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  const rankedRequests = useMemo(() => filterAndRankComplaints(requests, { severity: priorityFilter, category: categoryFilter, minAffected, nearbyCenter, unassignedOnly }).map(row => ({ row, priority: row.priority })), [requests, priorityFilter, categoryFilter, minAffected, nearbyCenter, unassignedOnly]);
  const rankedMatches = selected ? matchesByRequest[selected._id] : null;
  const nearbyProviders = useMemo(() => {
    if (!selected?.location?.coordinatesAuthorized || !knownCoordinates(selected.location.coordinates)) return [];
    return providers.filter(provider => provider.verificationStatus === 'verified' && provider.availability !== 'unavailable' && knownCoordinates(provider.location?.coordinates)).map(provider => ({ provider, distance: straightLineDistance(selected.location.coordinates, provider.location.coordinates) })).filter(item => Number.isFinite(item.provider.serviceRadiusKm) && item.distance <= item.provider.serviceRadiusKm).sort((a, b) => a.distance - b.distance).slice(0, 5);
  }, [providers, selected]);

  return <div className="coordination-dashboard">
    <div className="verification-note"><AlertTriangle size={15}/><span>Sahayak supports coordination and does not replace official emergency services. For immediate life-threatening danger, contact local emergency services. Provider availability and inventory are self-reported unless marked verified.</span></div>
    <section className="dashboard-summary-grid" aria-label="Live incident summary" aria-busy={loading}>
      <Card icon={Siren} label="Active incidents" value={summary ? incidentStats.active ?? 0 : '—'} detail="Current incident clusters" tone="blue" loading={loading && !summary} onClick={() => { setIncidentStatus('active'); setIncidentPriority('all'); setIncidentSeverity('all'); setIncidentCategory('all'); setIncidentLocation(''); setIncidentResponderFilter('all'); jumpTo('live-incidents'); }}/>
      <Card icon={AlertTriangle} label="Critical incidents" value={summary ? incidentStats.critical ?? 0 : '—'} detail="P1 incidents needing attention" tone="coral" loading={loading && !summary} onClick={() => { setIncidentStatus('active'); setIncidentPriority('P1'); setIncidentSeverity('all'); setIncidentCategory('all'); setIncidentLocation(''); setIncidentResponderFilter('all'); jumpTo('live-incidents'); }}/>
      <Card icon={PackageSearch} label="Unassigned incidents" value={summary ? incidentStats.unassigned ?? 0 : '—'} detail="No active responder attached" tone="amber" loading={loading && !summary} onClick={() => { setIncidentStatus('active'); setIncidentPriority('all'); setIncidentSeverity('all'); setIncidentCategory('all'); setIncidentLocation(''); setIncidentResponderFilter('unassigned'); jumpTo('live-incidents'); }}/>
      <Card icon={Users} label="Responders currently active" value={summary ? incidentStats.activeResponders ?? 0 : '—'} detail="Unique responders with active tasks" tone="green" loading={loading && !summary} onClick={() => { setIncidentStatus('active'); setIncidentPriority('all'); setIncidentSeverity('all'); setIncidentCategory('all'); setIncidentLocation(''); setIncidentResponderFilter('active'); jumpTo('live-incidents'); }}/>
      <Card icon={Activity} label="People estimated affected" value={summary ? Number(incidentStats.peopleAffected || 0).toLocaleString() : '—'} detail="Incident estimates may overlap" tone="blue" loading={loading && !summary} onClick={() => { setIncidentStatus('active'); setIncidentPriority('all'); setIncidentSeverity('all'); setIncidentCategory('all'); setIncidentLocation(''); setIncidentResponderFilter('all'); jumpTo('live-incidents'); }}/>
      <Card icon={PackageCheck} label="Resolved today" value={summary ? incidentStats.resolvedToday ?? 0 : '—'} detail="Incidents resolved since midnight" tone="green" loading={loading && !summary} onClick={() => { setIncidentStatus('resolved'); setIncidentPriority('all'); setIncidentSeverity('all'); setIncidentCategory('all'); setIncidentLocation(''); setIncidentResponderFilter('all'); jumpTo('live-incidents'); }}/>
    </section>

    <section className="panel incident-live-panel" id="live-incidents"><div className="panel-header"><div><div className="section-kicker">SAHAYAK LIVE · INCIDENT INTELLIGENCE</div><h2>Reports linked to active incidents <span className="request-total">{incidents.length}</span></h2><small className="live-capabilities">Live incident detection · Incident aggregation · Dynamic situation updates</small></div><span className={`live-connection ${liveStatus === 'connected' ? 'connected' : ''}`}><i/>{liveStatus === 'connected' ? 'Socket connected' : liveStatus === 'reconnecting' ? 'Reconnecting' : 'Connecting'}</span></div>
      <div className="incident-dashboard-filters"><label>Category<select value={incidentCategory} onChange={event => setIncidentCategory(event.target.value)}><option value="all">All categories</option>{incidentCategories.map(value => <option key={value}>{value}</option>)}</select></label><label>Location<input value={incidentLocation} onChange={event => setIncidentLocation(event.target.value)} placeholder="Search area"/></label><label>Severity<select value={incidentSeverity} onChange={event => setIncidentSeverity(event.target.value)}><option value="all">All severities</option>{['critical','high','medium','low'].map(value => <option key={value}>{value}</option>)}</select></label><label>Priority<select value={incidentPriority} onChange={event => setIncidentPriority(event.target.value)}><option value="all">All priorities</option>{['P1','P2','P3','P4'].map(value => <option key={value}>{value}</option>)}</select></label><label>Status<select value={incidentStatus} onChange={event => setIncidentStatus(event.target.value)}><option value="active">Active</option><option value="resolved">Resolved</option><option value="all">All statuses</option></select></label></div>
      <label className="incident-responder-filter">Responder assignment<select value={incidentResponderFilter} onChange={event => setIncidentResponderFilter(event.target.value)}><option value="all">Any assignment</option><option value="active">Active responder</option><option value="unassigned">Unassigned</option></select></label>
      {visibleIncidents.length ? <div className="incident-live-grid">{visibleIncidents.slice(0, 100).map(incident => <article className="incident-live-card" key={incident._id}><div className="incident-live-title"><div><strong>{incident.title} · {incident.location}</strong><span>{incident.emergencyType} · {incident.category || 'Category unavailable'}</span></div><PriorityBadge priority={incident.priority}/></div><div className="incident-live-stats"><span><b>{incident.totalReports ?? incident.reportCount}</b> complaints</span><span><b>{Number(incident.totalAffectedPeople ?? incident.estimatedAffectedPeople ?? 0).toLocaleString()}</b> estimated people affected</span><span><b>{incident.maximumSeverity || incident.priority?.severity}</b> max severity · average {Number(incident.averageSeverity || 0).toFixed(1)}/4</span><span>{incident.verifiedReportCount || 0} verified · {incident.unverifiedReportCount ?? incident.reportCount} unverified</span><span>{incident.communityConfirmationCount || 0} confirmations · {incident.duplicateReportCount || 0} suspected duplicates</span><span>Age {formatAge(Number(incident.incidentAgeHours || 0))}</span><span>{incident.worsening ? <em className="worsening-state">Situation worsening · {incident.recentReportCount} recent reports</em> : <em>Situation being monitored</em>}</span></div><small>First reported {incident.firstReportedAt ? new Date(incident.firstReportedAt).toLocaleString() : 'unknown'} · Updated {new Date(incident.lastUpdatedAt || incident.lastReportedAt).toLocaleTimeString()} · population uses maximum individual estimate to avoid overlap</small><button type="button" className="incident-detail-link" onClick={() => setOpenIncidentId(String(incident._id))}>Inspect reports and response history</button></article>)}</div> : <div className="dashboard-empty">{loading ? 'Loading incident clusters…' : incidents.length ? 'No incidents match these filters.' : error ? 'Could not load incident clusters. Refresh to retry.' : 'No active incidents yet. New reports will appear here when linked into an incident.'}</div>}
    </section>

    <div className="coordination-dashboard-grid">
      <section className="panel dashboard-request-panel" id="priority-queue">
        <div className="panel-header"><div><div className="section-kicker">HIGHEST PRIORITY SCORE FIRST</div><h2>Emergency complaints <span className="request-total">{rankedRequests.length}</span></h2></div><button className="text-link" onClick={onRefresh}>Refresh</button></div>
        <div className="resolver-filters">
          <label>Severity<select value={priorityFilter} onChange={event => setPriorityFilter(event.target.value)}><option value="all">All levels</option>{['critical','high','medium','low'].map(level => <option key={level} value={level}>{level[0].toUpperCase() + level.slice(1)}</option>)}</select></label>
          <label>Category<select value={categoryFilter} onChange={event => setCategoryFilter(event.target.value)}><option value="all">All categories</option>{categories.map(value => <option key={value}>{value}</option>)}</select></label>
          <label>People affected at least<input type="number" min="0" value={minAffected} onChange={event => setMinAffected(event.target.value)} placeholder="Any"/></label>
          <label className="resolver-check"><input type="checkbox" checked={unassignedOnly} onChange={event => setUnassignedOnly(event.target.checked)}/> Unassigned</label>
          <button className={`button ${nearbyCenter ? 'button-primary' : 'button-secondary'}`} onClick={() => {
            if (nearbyCenter) { setNearbyCenter(null); setNearbyMessage(''); return; }
            if (!navigator.geolocation) { setNearbyMessage('Location is unavailable in this browser.'); return; }
            navigator.geolocation.getCurrentPosition(position => { setNearbyCenter([position.coords.longitude, position.coords.latitude]); setNearbyMessage('Showing complaints within 25 km of your location.'); }, () => setNearbyMessage('Allow location access to filter nearby complaints.'));
          }}><MapPin size={14}/>{nearbyCenter ? 'Nearby on' : 'Nearby'}</button>
          {nearbyMessage && <small role="status">{nearbyMessage}</small>}
        </div>
        {error && <div className="dashboard-error" role="alert">{error} Existing complaint data may be stale.</div>}
        <div className="resolver-complaint-list">
          {rankedRequests.map(({ row, priority }) => {
            const reportedAt = row.reportedAt || row.createdAt;
            const assignment = assignedProvider(row);
            return <article key={row._id} className={`resolver-complaint-card ${String(selectedId) === String(row._id) ? 'selected' : ''}`} onClick={() => onSelectRequest(row._id)}>
              <div className="resolver-card-heading"><div><PriorityBadge priority={priority}/><h3>{row.title}</h3><span>{row.emergencyType || 'Other'} · {row.category} · <MapPin size={12}/>{row.location?.label || 'Location not provided'}</span></div><strong className="resolver-score">{priority?.score ?? '—'}<small>/100</small></strong></div>
              <div className="resolver-card-meta"><span><b>Priority:</b> {priority?.level || 'Pending'} — {priority?.severity || 'Not rated'} · Score {priority?.score ?? '—'}</span><span><b>People affected:</b> {Number(row.affectedPeople || 0).toLocaleString()}</span><span><b>Severity:</b> {priority?.severity || 'Not rated'}</span><span><b>Reported:</b> {reportedAt ? `${formatAge(Math.max(0, (Date.now() - new Date(reportedAt).getTime()) / 3600000))} ago` : 'Time not recorded'}</span><span><b>Verification:</b> {row.verification?.state || 'unverified'}</span><span><b>Resolver status:</b> {String(row.status || 'unknown').replaceAll('_', ' ')}</span><span><b>Assigned:</b> {assignment}</span></div>
              <div className="resolver-explanation"><b>Why this priority</b><ul>{(priority?.reasons || ['Priority calculation is unavailable. Refresh to retry.']).map((reason, index) => <li key={index}>{reason}</li>)}</ul></div>
              <div className="resolver-recommendation"><b>Recommended action:</b> {priority?.recommendedAction || 'Review the reported need and coordinate an appropriate response'} <small>Advisory only; resolver judgment is required.</small></div>
              {role === 'admin' && <details className="priority-override" onClick={event => event.stopPropagation()}><summary>{priority?.manualOverride ? 'Priority adjusted · edit' : 'Adjust priority'}</summary><form onSubmit={async event => { event.preventDefault(); event.stopPropagation(); setPriorityError(''); setPriorityNotice(''); const values = Object.fromEntries(new FormData(event.currentTarget)); setPrioritySaving(true); try { await api.patch(`/requests/${row._id}/priority`, { level: values.level, score: Number(values.score), reason: values.reason }); await onRefresh(); setPriorityNotice('Priority updated and the change was recorded in the audit log.'); } catch (error) { setPriorityError(error.response?.data?.message || 'Could not update priority.'); } finally { setPrioritySaving(false); } }}><label>Level<select name="level" defaultValue={priority?.level || 'P3'}><option>P1</option><option>P2</option><option>P3</option><option>P4</option></select></label><label>Score<input name="score" type="number" min="0" max="100" step="1" defaultValue={priority?.score ?? 50} required/></label><label>Reason<input name="reason" minLength="5" maxLength="500" required placeholder="Why should the score be adjusted?"/></label><button className="button button-primary" disabled={prioritySaving}>{prioritySaving ? 'Saving…' : 'Save adjustment'}</button>{priority?.manualOverride && <button type="button" className="button button-secondary" disabled={prioritySaving} onClick={async event => { event.stopPropagation(); setPrioritySaving(true); setPriorityError(''); setPriorityNotice(''); try { await api.delete(`/requests/${row._id}/priority`); await onRefresh(); setPriorityNotice('Calculated priority restored. The reset was recorded in the audit log.'); } catch (error) { setPriorityError(error.response?.data?.message || 'Could not reset priority.'); } finally { setPrioritySaving(false); } }}>Restore calculated priority</button>}{priorityNotice && <small role="status">{priorityNotice}</small>}{priorityError && <small role="alert">{priorityError}</small>}</form></details>}
              {String(selectedId) === String(row._id) && <button className="text-link resolver-review-link" onClick={event => { event.stopPropagation(); document.querySelector('.dashboard-match-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }}>Review provider matches →</button>}
            </article>;
          })}
          {!rankedRequests.length && <div className="dashboard-empty">{loading ? 'Loading complaints…' : error ? 'Could not load complaints. Use Refresh to try again.' : 'No complaints match these filters.'}</div>}
        </div>
      </section>

      <section className="panel provider-availability-panel">
        <div className="panel-header"><div><div className="section-kicker">PROVIDER-REPORTED STATUS</div><h2>Availability overview</h2><small className="availability-rule">Updates older than 60 minutes need reconfirmation. If matching is unavailable, contact providers through established channels and record the decision.</small></div><span className="request-total">{providers.length}</span></div>
        {Object.entries(groups).map(([label, rows]) => <details className="availability-group" key={label} open={label === 'Available' || label === 'Needs reconfirmation'}><summary><span>{label}</span><b>{rows.length}</b></summary>{rows.length ? rows.slice(0, 8).map(provider => <div className="availability-provider" key={provider._id}><div><strong>{provider.name}</strong><span>{provider.category} · {provider.currentWorkload || 0}/{provider.capacity || 0} active</span></div><small>{provider.lastAvailabilityUpdated ? `Updated ${new Date(provider.lastAvailabilityUpdated).toLocaleString()}` : 'Update time unavailable'}</small></div>) : <p className="availability-empty">No providers in this group.</p>}</details>)}
      </section>
    </div>

    <section className="panel dashboard-inventory-panel" id="resource-management"><div className="panel-header"><div><div className="section-kicker">VERIFIED ACCOUNTS · PROVIDER-REPORTED INVENTORY</div><h2>Available resource quantities</h2></div><span className="request-total">{availableResources.length} types</span></div><div className="dashboard-inventory-grid">{availableResources.map(item => <div className="dashboard-inventory-item" key={`${item.resource}-${item.unit}`}><strong>{item.resource}</strong><span>Provider reports {item.quantity} {item.unit} unreserved</span><small>{item.lastUpdatedAt ? `Inventory updated ${new Date(item.lastUpdatedAt).toLocaleString()}` : 'Inventory update time not recorded'}</small></div>)}{!availableResources.length && <div className="dashboard-empty">No available inventory has been reported by verified providers.</div>}</div></section>

    <div id="emergency-map" className="dashboard-map-anchor"><CoordinationMap providers={providers} incidents={incidents} onSelectIncident={setOpenIncidentId}/></div>

    <section className="panel dashboard-match-panel">
      <div className="panel-header"><div><div className="section-kicker">HUMAN-REVIEWED RECOMMENDATIONS</div><h2>{selected ? `${selected.requestId} · ${selected.title}` : 'Select a request to review matches'}</h2></div>{selected && <button className="button button-secondary" disabled={busy === selected._id || !matchable || selected.verification?.state !== 'verified'} onClick={() => onLoadMatches(selected)}>{busy === selected._id ? 'Loading…' : rankedMatches ? 'Refresh recommendations' : matchable ? 'Find providers' : 'Request not matchable'}</button>}</div>
      {selected && <><div className="dashboard-match-context"><span>{selected.category} · {selected.urgency} priority · response required by {selected.responseDeadline ? new Date(selected.responseDeadline).toLocaleString() : 'deadline not recorded'}</span>{matchSummaries[selected._id] && <small>{matchSummaries[selected._id]}</small>}</div>
        {selected.location?.coordinatesAuthorized && knownCoordinates(selected.location.coordinates) && <div className="nearby-discovery"><strong><MapPin size={14}/> Nearby verified provider accounts with provider-reported locations (straight-line distance)</strong>{nearbyProviders.length ? nearbyProviders.map(({ provider, distance }) => <span key={provider._id}>{provider.name} · {distance.toFixed(1)} km · {provider.availability}</span>) : <span>No verified available or limited providers with known locations cover this request area.</span>}</div>}
        {selected.verification?.state !== 'verified' && <div className="dashboard-verification-prompt"><ShieldCheck size={14}/> This request must be verified before matching. <button className="text-link" disabled={busy === selected._id} onClick={() => onVerifyRequest(selected)}>Verify request</button></div>}
        {rankedMatches ? rankedMatches.length ? <div className="dashboard-ranked-list">{rankedMatches.map((match, index) => <article className="dashboard-match-card" key={match.provider.id}><div className="dashboard-match-head"><div><strong>{index + 1}. {match.provider.name}</strong><span>{match.eligibilityStatus} · {match.provider.verificationStatus || 'verification unknown'} · {match.provider.availability || 'availability unknown'}</span></div><b className="dashboard-match-score">{match.score === null ? 'Incomplete' : `${match.score}/100`}</b></div>
          <div className="dashboard-component-scores">{match.scoreComponents.map(component => <span key={component.key}>{component.label}: {component.score === null ? 'unknown' : `${component.score}/100`} <small>({component.appliedWeight}% weight)</small></span>)}</div>
          <div className="dashboard-resource-evidence">{match.evidence.resources.map(resource => <span key={`${resource.resource}-${resource.unit}`}>Provider reports {resource.availableQuantity} {resource.unit} {resource.resource} available / {resource.requestedQuantity} requested{resource.lastUpdatedAt ? ` · updated ${new Date(resource.lastUpdatedAt).toLocaleString()}` : ' · update time unknown'}</span>)}</div>
          <div className="dashboard-match-explanations"><div><b>Reasons</b>{match.explanation.reasons.map((reason, i) => <span key={i}>{reason}</span>)}</div><div><b>Factors lowering score or limiting safety</b>{[...match.explanation.scoreFactors.map(factor => factor.explanation), ...match.explanation.safetyLimitations, ...match.explanation.missingInformation.map(text => `Uncertainty: ${text}`)].length ? [...match.explanation.scoreFactors.map(factor => factor.explanation), ...match.explanation.safetyLimitations, ...match.explanation.missingInformation.map(text => `Uncertainty: ${text}`)].map((text, i) => <span key={i}>{text}</span>) : <span>No identified score reductions or missing information.</span>}</div></div>
          <div className="dashboard-match-history"><span>{match.provider.availabilitySource === 'coordinator_confirmed' ? 'Coordinator-confirmed' : 'Provider-reported'} availability: {match.provider.lastAvailabilityUpdated ? new Date(match.provider.lastAvailabilityUpdated).toLocaleString() : 'Not recorded'}{match.evidence.availability.needsReconfirmation ? ' · needs reconfirmation' : ''}</span><span>Verified completions: {match.evidence.performance.verifiedCompletedAssignments}</span><span>Verified feedback: {match.evidence.feedback.averageRating === null ? 'None recorded' : `${match.evidence.feedback.averageRating}/5 (${match.evidence.feedback.verifiedCount})`}</span><span>Capacity: {match.evidence.capacity.remainingSlots ?? 'Unknown'} / {match.evidence.capacity.totalSlots ?? 'Unknown'} slots</span><span>{match.distanceLabel || 'Distance unavailable'}</span></div>
          {match.eligible && <button className="button button-primary dashboard-assign-button" disabled={busy === selected._id} onClick={() => onAssign(selected, match)}>Offer assignment (provider acceptance required)</button>}
        </article>)}</div> : <div className="dashboard-empty">No provider profiles were returned for this request.</div> : <div className="dashboard-empty">Select “Find providers” to load live recommendations for this request.</div>}
      </>}
    </section>
    {openIncidentId && <IncidentDetails incidentId={openIncidentId} incidents={incidents} role={role} onClose={() => setOpenIncidentId('')} onUpdated={onRefresh}/>}
  </div>;
}
