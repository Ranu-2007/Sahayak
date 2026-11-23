import { useEffect, useState } from 'react';
import { Image, MapPin, ShieldCheck, Users } from 'lucide-react';
import api from '../api.js';
import PriorityBadge from './PriorityBadge.jsx';
import './community-verification.css';
import './incident-board.css';
import './evidence-uploader.css';

const statusText = value => value || 'unverified';

export function EvidenceGallery({ complaint }) {
  const evidence = complaint.evidence || [];
  const [images, setImages] = useState([]);
  useEffect(() => {
    let active = true;
    const urls = [];
    Promise.all(evidence.map(async file => {
      try {
        const { data } = await api.get(`/requests/${complaint._id}/evidence/${file._id}`, { responseType: 'blob' });
        const url = URL.createObjectURL(data);
        urls.push(url);
        return { ...file, url };
      } catch { return null; }
    })).then(results => { if (active) setImages(results.filter(Boolean)); });
    return () => { active = false; urls.forEach(url => URL.revokeObjectURL(url)); };
  }, [complaint._id, evidence.map(file => file._id).join(',')]);

  if (!evidence.length) return null;
  return <div className="evidence-gallery"><strong><Image size={14}/> Photo and video evidence ({evidence.length})</strong><div>{images.map(item => <a key={item._id} href={item.url} target="_blank" rel="noreferrer" aria-label={`View ${item.originalName}`}>{item.mediaType.startsWith('video/') ? <video src={item.url} controls preload="metadata" aria-label="Complaint video evidence"/> : <img src={item.url} alt="Complaint photo evidence"/>}</a>)}</div></div>;
}

export function CommunityVerification({ complaint, onUpdated }) {
  const [count, setCount] = useState(complaint.confirmationCount || complaint.communityConfirmations?.length || 0);
  const [feedback, setFeedback] = useState(complaint.communityFeedback || { confirm_issue: 0, also_affected: 0, issue_not_found: 0, problem_resolved: 0 });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [submittedAction, setSubmittedAction] = useState(complaint.viewerCommunityAction || null);
  const status = statusText(complaint.verificationStatus);
  useEffect(() => {
    setCount(complaint.confirmationCount || complaint.communityConfirmations?.length || 0);
    setFeedback(complaint.communityFeedback || { confirm_issue: 0, also_affected: 0, issue_not_found: 0, problem_resolved: 0 });
    setSubmittedAction(complaint.viewerCommunityAction || null);
  }, [complaint.confirmationCount, complaint.communityConfirmations?.length, complaint.communityFeedback, complaint.viewerCommunityAction]);

  const respond = action => {
    setMessage('');
    if (submittedAction) { setMessage('You have already submitted one response for this complaint.'); return; }
    if (!complaint.location?.coordinatesAuthorized) {
      setMessage('Nearby confirmations need shared report coordinates.');
      return;
    }
    if (!navigator.geolocation) {
      setMessage('This browser cannot provide a location for nearby confirmation.');
      return;
    }
    setBusy(true);
    navigator.geolocation.getCurrentPosition(async position => {
      try {
        const { data } = await api.post(`/requests/${complaint._id}/confirmations`, { latitude: position.coords.latitude, longitude: position.coords.longitude, action });
        setCount(data.confirmationCount);
        setFeedback(data.communityFeedback);
        setSubmittedAction(action);
        setMessage(data.message);
        onUpdated?.();
      } catch (error) { setMessage(error.response?.data?.message || 'Could not record your confirmation.'); }
      finally { setBusy(false); }
    }, error => {
      setBusy(false);
      setMessage(error.code === error.PERMISSION_DENIED ? 'Allow location access to confirm a nearby complaint.' : 'Could not determine your location.');
    }, { enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 });
  };

  return <section className="community-verification" aria-label="Community verification">
    <div className="community-status"><span className={`status-pill ${status === 'officially verified' ? 'provider-assigned' : status === 'community supported' ? 'community-supported' : ''}`}><ShieldCheck size={12}/>{status}</span><span><Users size={13}/>{count} nearby response{count === 1 ? '' : 's'}</span></div>
    <div className="community-actions">{[['confirm_issue', 'Confirm issue'], ['also_affected', 'I am also affected'], ['issue_not_found', 'Issue not found'], ['problem_resolved', 'Problem resolved']].map(([action, label]) => <button key={action} className={`button ${submittedAction === action ? 'button-primary' : 'button-secondary'}`} onClick={() => respond(action)} disabled={busy || Boolean(submittedAction)} title="Available to signed-in users within 2 km">{label} <b>{feedback[action] || 0}</b></button>)}</div>
    {message && <small role="status">{message}</small>}
    <small>One response per signed-in account. Location is browser-reported. Community feedback is not proof and does not change official complaint status.</small>
  </section>;
}

export function ComplaintDetails({ complaint }) {
  const [details, setDetails] = useState(null), [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  const toggle = async () => {
    if (details) { setDetails(null); return; }
    setBusy(true); setMessage('');
    try { const { data } = await api.get(`/requests/${complaint._id}`); setDetails(data.request); }
    catch (error) { setMessage(error.response?.data?.message || 'Details are not available to this account.'); }
    finally { setBusy(false); }
  };
  const reload = async () => { const { data } = await api.get(`/requests/${complaint._id}`); setDetails(data.request); };
  return <div className="complaint-detail-toggle"><button className="text-link" onClick={toggle}>{busy ? 'Loading details…' : details ? 'Hide complaint details' : 'Complaint details'}</button>{message && <small role="status">{message}</small>}{details && <div className="complaint-detail-content"><h3>{details.title}</h3><p>{details.description}</p><div><b>Required service:</b> {details.requiredService}</div><div><b>Reported:</b> {new Date(details.reportedAt || details.createdAt).toLocaleString()}</div><EvidenceGallery complaint={details}/>{details.canManageEvidence && <EvidenceUploader complaint={details} onUploaded={reload}/>}</div>}</div>;
}

function EvidenceUploader({ complaint, onUploaded }) {
  const [files, setFiles] = useState([]), [error, setError] = useState(''), [busy, setBusy] = useState(false), [previews, setPreviews] = useState([]);
  useEffect(() => {
    const urls = files.map(file => URL.createObjectURL(file)); setPreviews(urls);
    return () => urls.forEach(URL.revokeObjectURL);
  }, [files]);
  const select = event => {
    const chosen = [...event.target.files];
    const existing = complaint.evidence || [];
    const total = existing.reduce((sum, item) => sum + item.size, 0) + chosen.reduce((sum, item) => sum + item.size, 0);
    const invalid = chosen.find(file => !['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/webm'].includes(file.type) || file.size > (file.type.startsWith('video/') ? 10 : 5) * 1024 * 1024);
    if (existing.length + chosen.length > 5) setError('A complaint can have at most 5 evidence files.');
    else if (total > 25 * 1024 * 1024) setError('Evidence files must total 25 MB or less.');
    else if (invalid) setError('Photos must be JPEG/PNG/WebP (5 MB max); videos must be MP4/WebM (10 MB max).');
    else { setError(''); setFiles(chosen); return; }
    setFiles([]); event.target.value = '';
  };
  const upload = async () => {
    if (!files.length || busy) return;
    setBusy(true); setError('');
    const form = new FormData(); files.forEach(file => form.append('photos', file));
    try { await api.post(`/requests/${complaint._id}/evidence`, form); setFiles([]); onUploaded?.(); }
    catch (failure) { setError(failure.response?.data?.message || 'Evidence could not be uploaded.'); }
    finally { setBusy(false); }
  };
  return <div className="evidence-uploader"><label>Attach more evidence<input type="file" accept="image/jpeg,image/png,image/webp,video/mp4,video/webm" multiple onChange={select}/></label>{previews.length > 0 && <div className="photo-previews">{previews.map((url, index) => files[index].type.startsWith('video/') ? <video key={url} src={url} controls preload="metadata"/> : <img key={url} src={url} alt="Evidence preview"/>)}</div>}{error && <small role="alert">{error}</small>}{files.length > 0 && <button className="button button-secondary" onClick={upload} disabled={busy}>{busy ? 'Uploading…' : `Upload ${files.length} file${files.length === 1 ? '' : 's'}`}</button>}</div>;
}

export function ComplaintGroups({ toast }) {
  const [groups, setGroups] = useState([]), [loading, setLoading] = useState(true);
  const load = async () => {
    setLoading(true);
    try { const { data } = await api.get('/requests/groups'); setGroups(data.groups); }
    catch (error) { toast(error.response?.data?.message || 'Could not load grouped complaints.'); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);
  return <div className="page-content"><section className="page-heading"><div><div className="eyebrow">COMMUNITY SIGNALS · LIVE INCIDENTS</div><h1>Community complaints<span className="heading-period">.</span></h1><p className="heading-sub">Incident clusters bring related reports together. Community feedback supports review, but never replaces official verification.</p></div><button className="button button-secondary" onClick={load}>Refresh incidents</button></section><IncidentClusterBoard toast={toast}/>
    {loading ? <div className="panel empty-state">Loading grouped complaints…</div> : groups.length ? groups.map((group, index) => <section className="panel community-group" key={`${group.category}-${index}`}><header><div><div className="section-kicker">{group.category}</div><h2>{group.count} related report{group.count === 1 ? '' : 's'} {group.duplicateCandidate && <span className="duplicate-candidate">Possible duplicate cluster</span>}</h2></div><small>{group.duplicateCandidate ? 'Same category · reports within 500 m' : 'No nearby same-category report detected'}</small></header>
      {group.complaints.map(complaint => <article className="community-complaint" key={complaint._id}><div className="assignment-card-head"><div><strong>{complaint.requestId}</strong><span>{complaint.urgency} priority · reported {new Date(complaint.createdAt).toLocaleString()}</span></div><span className="status-pill">{complaint.verificationStatus}</span></div><ComplaintDetails complaint={complaint}/><CommunityVerification complaint={complaint} onUpdated={load}/></article>)}
    </section>) : <div className="panel empty-state">No complaints are available for grouping.</div>}
  </div>;
}

function IncidentClusterBoard({ toast }) {
  const [incidents, setIncidents] = useState([]), [loading, setLoading] = useState(true), [error, setError] = useState('');
  const load = async () => {
    setLoading(true);
    try { const { data } = await api.get('/requests/incidents'); setIncidents(data.incidents); setError(''); }
    catch (failure) { setError(failure.response?.data?.message || 'Could not load live incidents.'); toast(failure.response?.data?.message || 'Could not load live incidents.'); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); const timer = window.setInterval(load, 15000); return () => window.clearInterval(timer); }, []);
  return <section className="incident-board"><div className="incident-board-heading"><div><div className="section-kicker">SAHAYAK LIVE · INCIDENT AGGREGATION</div><h2>Current incident clusters <span className="request-total">{incidents.length}</span></h2></div><span className="live-connection connected"><i/>Updates every 15 seconds</span></div>
    {error && <div className="dashboard-error" role="alert">{error} Existing incident data may be stale.</div>}
    {loading && !incidents.length ? <div className="panel empty-state">Loading incident updates…</div> : incidents.length ? incidents.map(incident => <article className="panel incident-board-card" key={incident._id}>
      <header><div><div className="section-kicker">{incident.incidentId} · {incident.emergencyType}</div><h2>{incident.title}</h2><span>{incident.location}</span></div><PriorityBadge priority={incident.priority}/></header>
      <div className="incident-board-signals"><div><strong>{incident.reportCount}</strong><span>Reports received</span></div><div><strong>{Number(incident.estimatedAffectedPeople || 0).toLocaleString()}</strong><span>Estimated affected people*</span></div><div><strong>{incident.worsening ? 'Worsening' : 'Monitoring'}</strong><span>{incident.worsening ? `${incident.recentReportCount} reports in the last hour` : 'No rapid increase detected'}</span></div><div><strong>Live</strong><span>Last update {new Date(incident.lastReportedAt).toLocaleTimeString()}</span></div></div>
      <p className={incident.worsening ? 'incident-worsening-note' : 'incident-estimate-note'}>{incident.worsening ? 'Situation may be worsening based on new reports or a higher reported affected count. Resolver assessment is advised.' : 'Situation updates as new reports arrive. Recommendations and priority remain advisory.'} *Estimate uses the highest single report because reports may describe overlapping people.</p>
      <div className="incident-report-list"><strong>Reports in this incident</strong>{incident.reports.map(report => <div className="incident-report-row" key={report._id}><div><b>{report.requestId} · {report.title}</b><span>{report.emergencyType} · {report.category} · {Number(report.affectedPeople || 0).toLocaleString()} people reported</span></div><span>{report.verification} · {report.status.replaceAll('_', ' ')}</span></div>)}</div>
    </article>) : <div className="panel empty-state">No active incident clusters yet. New reports create or join an incident.</div>}
  </section>;
}
