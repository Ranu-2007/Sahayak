import { useEffect, useMemo, useState } from 'react';
import { CircleMarker, MapContainer, Popup, TileLayer, Tooltip, useMap, useMapEvents } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
import './coordination-dashboard.css';

const validCoordinates = value => Array.isArray(value) && value.length === 2 && value.every(Number.isFinite) && !(value[0] === 0 && value[1] === 0);
const incidentColor = level => ({ P1: '#b33c34', P2: '#c66b3c', P3: '#b58c3d', P4: '#648b73' })[level] || '#648b73';

function MapViewport({ points }) {
  const map = useMap();
  const signature = points.map(point => point.join(',')).join('|');
  useEffect(() => {
    if (!points.length) return;
    if (points.length === 1) map.setView(points[0], 11);
    else map.fitBounds(points, { padding: [24, 24], maxZoom: 12 });
  }, [map, signature]);
  return null;
}

function ClusteredPoints({ points, onSelectIncident }) {
  const map = useMap();
  const [zoom, setZoom] = useState(map.getZoom());
  useMapEvents({ zoomend: () => setZoom(map.getZoom()) });
  const groups = useMemo(() => {
    const cell = 360 / (2 ** zoom * 16), grouped = new Map();
    for (const point of points) {
      const key = `${Math.floor(point.position[0] / cell)}:${Math.floor(point.position[1] / cell)}`;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(point);
    }
    return [...grouped.values()].map(items => ({ items, position: [items.reduce((sum, point) => sum + point.position[0], 0) / items.length, items.reduce((sum, point) => sum + point.position[1], 0) / items.length] }));
  }, [points, zoom]);
  return groups.map((group, index) => {
    const clustered = group.items.length > 1, item = group.items[0], color = clustered ? '#7568a3' : item.color;
    return <CircleMarker key={`${index}-${group.items.map(point => point.id).join('-')}`} center={group.position} radius={clustered ? Math.min(21, 11 + group.items.length) : 9} pathOptions={{ color, fillColor: color, fillOpacity: .86, weight: 2 }} eventHandlers={clustered ? { click: () => map.setView(group.position, Math.min(18, zoom + 2)) } : undefined}>
      {clustered && <Tooltip permanent direction="center" className="map-cluster-count">{group.items.filter(point => point.kind === 'incident').length || group.items.length}</Tooltip>}{!clustered && item.kind === 'incident' && <Tooltip permanent direction="center" className="map-cluster-count">{item.reportCount}</Tooltip>}
      <Popup minWidth={220}><div className="map-popup">{clustered ? <><strong>{group.items.length} nearby records</strong>{group.items.slice(0, 10).map(point => point.kind === 'incident' ? <button className="map-popup-action" key={point.id} onClick={() => onSelectIncident(point.id)}>{point.reportCount} reports · {point.title}</button> : <span key={point.id}>Provider: {point.name} · {point.availability} · {point.verificationStatus}</span>)}</> : item.kind === 'incident' ? <><strong>{item.title}</strong><span>{item.category} · {item.location}</span><span>{item.reportCount} complaints · {item.severity} severity · {item.priority}</span><button className="map-popup-action" onClick={() => onSelectIncident(item.id)}>Inspect incident</button></> : <><strong>{item.name}</strong><span>{item.category} · {item.verificationStatus}</span><span>Availability: {item.availability} · {item.lastAvailabilityUpdated ? new Date(item.lastAvailabilityUpdated).toLocaleString() : 'Not recorded'}</span><span>{item.inventory.length ? item.inventory.map(stock => `${stock.availableQuantity ?? stock.quantity ?? 0} ${stock.unit} ${stock.resource}`).join(' · ') : 'No inventory listed'}</span></>}</div></Popup>
    </CircleMarker>;
  });
}

export default function CoordinationMap({ providers, incidents = [], onSelectIncident }) {
  const categories = [...new Set([...incidents.map(row => row.category), ...providers.flatMap(row => [row.category, ...(row.serviceCategories || [])])].filter(Boolean))].sort();
  const [category, setCategory] = useState('all'), [priority, setPriority] = useState('all');
  const points = useMemo(() => {
    const incidentPoints = incidents.filter(row => row.status === 'active' && validCoordinates(row.locationCoordinates) && (category === 'all' || row.category === category) && (priority === 'all' || row.priority?.severity?.toLowerCase() === priority)).map(row => ({ id: String(row._id), kind: 'incident', position: [row.locationCoordinates[1], row.locationCoordinates[0]], title: row.title, category: row.category, location: row.location, reportCount: row.reportCount, severity: row.maximumSeverity || row.priority?.severity, priority: row.priority?.level, color: incidentColor(row.priority?.level) }));
    const providerPoints = providers.filter(row => row.verificationStatus !== 'suspended' && validCoordinates(row.location?.coordinates) && (category === 'all' || row.category === category || (row.serviceCategories || []).includes(category))).map(row => ({ id: String(row._id), kind: 'provider', position: [row.location.coordinates[1], row.location.coordinates[0]], name: row.name, category: row.category, verificationStatus: row.verificationStatus, availability: row.availability, lastAvailabilityUpdated: row.lastAvailabilityUpdated, inventory: row.inventory || [], color: '#4e9165' }));
    return [...incidentPoints, ...providerPoints];
  }, [incidents, providers, category, priority]);
  const bounds = useMemo(() => points.map(point => point.position), [points]);
  return <section className="panel coordination-map-panel">
    <div className="panel-header"><div><div className="section-kicker">AUTHORIZED LOCATIONS ONLY</div><h2>Incident & resource map</h2><small className="availability-rule">Incident markers summarize reports; individual report locations are shown in incident details.</small></div><span className="map-record-count">{points.filter(point => point.kind === 'incident').length} incidents · {points.filter(point => point.kind === 'provider').length} providers</span></div>
    <div className="map-filters"><label>Category<select value={category} onChange={event => setCategory(event.target.value)}><option value="all">All categories</option>{categories.map(value => <option key={value}>{value}</option>)}</select></label><label>Incident severity<select value={priority} onChange={event => setPriority(event.target.value)}><option value="all">All severities</option>{['critical', 'high', 'medium', 'low'].map(value => <option key={value}>{value}</option>)}</select></label><span className="map-legend"><i className="incident-dot"/> Incidents <i className="provider-dot"/> Providers</span></div>
    <MapContainer className="coordination-map" center={[0, 0]} zoom={2} scrollWheelZoom><TileLayer attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"/><MapViewport points={bounds}/><ClusteredPoints points={points} onSelectIncident={onSelectIncident}/></MapContainer>
    {!points.length && <div className="map-empty">No authorized incident or provider coordinates are available for these filters. Location labels remain in the incident list.</div>}
  </section>;
}
