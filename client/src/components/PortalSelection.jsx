import { ArrowLeft, ArrowRight, CheckCircle2, HeartHandshake, Siren, Users, Truck, Boxes } from 'lucide-react';
import './portal-selection.css';

const options = [
  {
    key: 'requester', title: 'I need help', label: 'HELP SEEKER', Icon: Siren,
    description: 'For individuals and communities experiencing an emergency.',
    points: ['Report emergencies', 'Request resources', 'Track assistance', 'Receive updates'],
    action: 'Continue as Help Seeker',
  },
  {
    key: 'provider', title: 'I want to help', label: 'HELP PROVIDER', Icon: HeartHandshake,
    description: 'For NGOs, government agencies, volunteers, medical teams and relief providers.',
    points: ['Discover emergencies', 'Coordinate assistance', 'Manage teams', 'Manage resources'],
    action: 'Continue as Help Provider',
  },
];

export default function PortalSelection({ onBack, onContinue }) {
  return <main className="portal-select-page">
    <header className="portal-select-header"><button className="portal-back" onClick={onBack}><ArrowLeft size={17}/> Back to Sahayak</button><a href="/" className="portal-select-brand"><span className="portal-select-mark"><i/><i/><i/><i/></span>SAHAYAK</a><span className="portal-header-note"><span/> CONNECTED RESPONSE PLATFORM</span></header>
    <section className="portal-select-content"><div className="portal-select-intro"><span className="portal-select-eyebrow">GET STARTED WITH SAHAYAK</span><h1>How would you like to use Sahayak?</h1><p>Choose the path that best matches what you need today. You can use the same platform to connect with local response efforts.</p></div>
      <div className="portal-choice-grid">{options.map(({ key, title, label, Icon, description, points, action }) => <article className={`portal-choice-card ${key}`} key={key}><div className="portal-choice-top"><span className="portal-choice-icon"><Icon size={25}/></span><span className="portal-choice-label">{label}</span></div><h2>{title}</h2><p className="portal-choice-description">{description}</p><ul>{points.map(point => <li key={point}><CheckCircle2 size={15}/>{point}</li>)}</ul><button className="portal-continue" onClick={() => onContinue(key)}>{action}<ArrowRight size={16}/></button></article>)}</div>
      <div className="portal-select-help"><span><Users size={18}/></span><p><strong>Both sides work together.</strong> Reports, incident information and response updates stay connected through Sahayak.</p></div>
      <p className="portal-safety-note"><Siren size={14}/> If someone is in immediate danger, contact local emergency services first.</p>
    </section>
    <footer className="portal-select-footer"><span>SAHAYAK <i>·</i> Community emergency reporting and response coordination</span><span><Truck size={13}/> Human-led response coordination</span><span><Boxes size={13}/> Shared incident platform</span></footer>
  </main>;
}
