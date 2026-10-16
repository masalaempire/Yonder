import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import QRCode from 'qrcode';
import { SessionClient, invitationCode, normalizeCode } from './session/client';
import { useSensors } from './sensors/useSensors';
import { Guidance } from './components/Guidance';
import Demo from './components/Demo';

function Invite({ code }: { code: string }) {
  const url = window.location.origin + window.location.pathname + '#join=' + code; const [qr, setQr] = useState(''); const [notice, setNotice] = useState('');
  useEffect(() => { let active = true; QRCode.toDataURL(url, { margin: 1, width: 200, color: { dark: '#18241c', light: '#ffffff' } }).then(value => { if (active) setQr(value); }).catch(() => { if (active) setNotice('QR unavailable. Share the code below.'); }); return () => { active = false; }; }, [url]);
  async function copy() { try { await navigator.clipboard.writeText(url); setNotice('Invite link copied.'); } catch { setNotice('Copy unavailable. Select the invite link below.'); } }
  async function share() { try { if (navigator.share) { await navigator.share({ title: 'Find me on Yonder', text: 'Join my temporary Yonder session.', url }); setNotice('Invite shared.'); } else await copy(); } catch (error) { setNotice(error instanceof DOMException && error.name === 'AbortError' ? 'Sharing cancelled.' : 'Sharing unavailable. Copy the link instead.'); } }
  return <section className="invite"><div className="qr">{qr ? <img src={qr} width="164" height="164" alt={'Scan to join session ' + code}/> : <span>Preparing QR…</span>}</div><p className="eyebrow">YOUR INVITE CODE</p><p className="invite-code">{code.slice(0, 4)} {code.slice(4)}</p><p>Your friend can scan, open the link, or enter this code.</p><div className="button-row"><button className="secondary" onClick={share}>Share invite ↗</button><button className="secondary" onClick={copy}>Copy link</button></div><label className="link-label">Invite link<input readOnly value={url} onFocus={e => e.target.select()}/></label><p className="notice" role="status">{notice}</p></section>;
}
function SensorButtons({ sensors }: { sensors: ReturnType<typeof useSensors> }) {
  return <section className="sensor-tools" aria-label="Sensor permissions">
    <button className="secondary" onClick={() => sensors.requestLocation()}>{sensors.locationStatus === 'ready' ? 'Refresh location' : 'Enable location'}</button>
    <button className="secondary" onClick={() => { void sensors.requestCompass(); }}>{sensors.compassStatus === 'ready' ? 'Refresh compass' : 'Enable compass'}</button>
    <p>Location: {sensors.locationStatus}. Compass: {sensors.compassStatus}.</p>
    {(sensors.locationError || sensors.compassError) && <p role="status">{sensors.locationError || sensors.compassError} You can retry here or allow access in browser settings.</p>}
  </section>;
}
function Live({ client, onExit }: { client: SessionClient; onExit: () => void }) {
  const lifecycle = useRef(0); const sensors = useSensors(); const sensorsRef = useRef(sensors); sensorsRef.current = sensors;
  const state = useSyncExternalStore(client.subscribe, client.getSnapshot); const [visible, setVisible] = useState(document.visibilityState !== 'hidden'); const [foregroundAt, setForegroundAt] = useState(0);
  useEffect(() => { const handle = () => { const shown = document.visibilityState !== 'hidden'; setVisible(shown); client.clearPeer(); if (!shown) sensorsRef.current.stop(); if (shown) setForegroundAt(Date.now()); }; document.addEventListener('visibilitychange', handle); return () => document.removeEventListener('visibilitychange', handle); }, [client]);
  useEffect(() => { const generation = ++lifecycle.current; client.setSensorStop(() => sensorsRef.current.stop()); return () => { sensorsRef.current.stop(); queueMicrotask(() => { if (lifecycle.current === generation) client.stop(); }); }; }, [client]);
  useEffect(() => { if (state.session && !state.session.selfConsent) sensorsRef.current.stop(); }, [state.session?.selfConsent]);
  useEffect(() => { const endOnExit = () => { sensorsRef.current.stop(); client.stop(); }; window.addEventListener('pagehide', endOnExit); return () => window.removeEventListener('pagehide', endOnExit); }, [client]);
  useEffect(() => { if (sensors.locationStatus === 'denied' && state.session?.selfConsent) client.stop(); }, [client, sensors.locationStatus, state.session?.selfConsent]);
  useEffect(() => { if (visible && sensors.location && sensors.location.timestamp >= foregroundAt) client.sendFix(sensors.location); }, [client, sensors.location, state.session, state.connection, visible, foregroundAt]);
  const end = (found = false) => { sensors.stop(); client.stop(found ? 'found' : 'stopped'); };
  if (state.connection === 'ended') return <section className="ending"><span className="end-mark">↗</span><p className="eyebrow">SESSION ENDED</p><h1>{state.reason === 'found' ? 'There you are.' : 'Until next time.'}</h1><p>{state.reason === 'expired' ? 'This temporary session expired.' : state.reason === 'found' ? 'You chose to finish. Location sharing has stopped.' : 'Location sharing has stopped.'}</p>{state.error && <p role="alert">{state.error}</p>}<button className="primary" onClick={onExit}>Back to Yonder</button></section>;
  if (state.error && !state.grant) return <section className="ending"><h1>One more step.</h1><p role="alert">{state.error}</p><button className="primary" onClick={onExit}>Back to Yonder</button></section>;
  const session = state.session; const sharing = session?.phase === 'sharing' && session.selfConsent && session.peerConsent;
  const local = sensors.location && sensors.location.timestamp >= foregroundAt ? sensors.location : null; const heading = sensors.heading && sensors.heading.timestamp >= foregroundAt ? sensors.heading : null;
  return <div className={'live-session ' + (sharing ? 'is-finding' : '')}><div className="session-top"><span className={'live-badge ' + (state.connection === 'connected' ? 'is-live' : '')}>{state.connection === 'connected' ? sharing ? 'SHARING LIVE' : 'CONNECTED' : state.connection === 'interrupted' ? 'RECONNECTING' : 'CONNECTING'}</span><span>Temporary · private</span></div>
    {!state.grant ? <section className="intro"><h1>Making room<br/>for two.</h1><p>Creating your private session…</p></section> : !session || session.participants < 2 ? <><section className="intro compact"><h1>A friend.<br/>An invite.</h1><p>Waiting for your friend to join. Your location is not being shared.</p></section><Invite code={state.grant.code}/></> : !session.selfConsent ? <section className="intro consent"><span className="pair-symbol" aria-hidden="true">• &nbsp; •</span><h1>Ready when<br/>you both are.</h1><p>Share your live location with this one person for this temporary session. Both people must agree before any coordinates are sent.</p><button className="primary" disabled={state.connection !== 'connected'} onClick={() => client.consent()}>Share my location</button><p className="fine-print">Pairing alone does not share your location. You can stop at any time.</p></section> : <>
      {!session.peerConsent ? <section className="intro compact"><h1>Your turn.<br/>Their choice.</h1><p>Waiting for your friend to agree. Nothing is sent yet.</p></section> : <Guidance local={local} peer={state.peer} heading={heading} connected={state.connection === 'connected' && !!session.peerConnected} visible={visible} message={sensors.locationStatus === 'requesting' ? 'Acquiring your location' : !local ? 'Enable location to begin' : undefined}/>}
      <SensorButtons sensors={sensors}/>
      {sharing && <p className="fine-print limitation">Straight-line guidance, not a walking route. Stay in the foreground and look around safely.</p>}
    </>}
    <footer className="session-footer">{sharing && <button className="primary" onClick={() => end(true)}>We found each other</button>}<button className="stop-button" onClick={() => end()}>Stop sharing</button><p>Stops sensors immediately. Your friend’s last fix becomes stale within 15 seconds if you’re offline.</p></footer>
  </div>;
}
function SensorCheck({ onExit }: { onExit: () => void }) {
  const sensors = useSensors();
  const back = () => { sensors.stop(); onExit(); };
  return <><button className="back-button" onClick={back}>← Back</button><section className="intro compact"><p className="eyebrow">ON THIS PHONE ONLY</p><h1>A quick<br/>sensor check.</h1><p>Check your browser’s location and true-north compass. These readings stay on this screen and are never transmitted.</p></section><SensorButtons sensors={sensors}/><dl className="diagnostics"><dt>Location accuracy</dt><dd>{sensors.location ? '±' + Math.round(sensors.location.accuracy) + ' m' : 'No reading'}</dd><dt>True-north heading</dt><dd>{sensors.heading ? Math.round(sensors.heading.degrees) + '°' : 'No reading'}</dd><dt>Compass source</dt><dd>{sensors.heading?.source || 'No reading'}</dd></dl><button className="stop-button" onClick={back}>Stop sensors & back</button><p className="fine-print">Some browsers do not expose a usable compass. A secure HTTPS connection is required.</p></>;
}
export default function App() {
  const [screen, setScreen] = useState<'home' | 'join' | 'live' | 'demo' | 'check'>(() => invitationCode(window.location.hash) ? 'join' : 'home'); const [code, setCode] = useState(() => invitationCode(window.location.hash)); const [client] = useState(() => new SessionClient());
  useEffect(() => { const handle = () => { const invite = invitationCode(window.location.hash); if (invite) { setCode(invite); setScreen(current => current === 'home' || current === 'join' ? 'join' : current); } }; window.addEventListener('hashchange', handle); return () => window.removeEventListener('hashchange', handle); }, []);
  const home = () => { client.stop(); window.history.replaceState(null, '', window.location.pathname + window.location.search); setScreen('home'); };
  const start = (join?: string) => { setScreen('live'); void client.start(join); };
  return <div className="site-shell"><aside className="desktop-note"><span>FIND YOUR WAY<br/>TO EACH OTHER.</span><p>A shared moment.<br/>A little direction.</p></aside><main className={'phone-shell screen-' + screen}><header className="app-header"><button className="wordmark" onClick={home} aria-label="Yonder home">Yonder <span aria-hidden="true">↗</span></button><span className="header-note">A little closer.</span></header>
    {screen === 'home' && <><section className="hero"><p className="eyebrow"><span className="tiny-dot"/> JUST YOU TWO</p><h1>A little<br/>closer.</h1><p className="hero-copy">Find a friend in the here and now.<br/>One shared direction. No map needed.</p><div className="home-arrow" aria-hidden="true">↗</div></section><div className="home-actions"><button className="primary" onClick={() => start()}>Create session <span>↗</span></button><button className="secondary" onClick={() => setScreen('join')}>Join session</button><div className="button-row"><button className="text-button" onClick={() => setScreen('demo')}>Try a demo</button><button className="text-button" onClick={() => setScreen('check')}>Sensor check</button></div></div><p className="home-footnote">Temporary sharing, with both people’s permission.<br/>Keep Yonder open. Stop whenever you like.</p></>}
    {screen === 'join' && <><button className="back-button" onClick={home}>← Back</button><section className="intro"><p className="eyebrow">YOUR FRIEND IS YONDER</p><h1>Eight characters.<br/>One friend.</h1><p>Enter your friend’s invite code. Joining won’t turn on sensors or share your location.</p></section><form className="join-form" onSubmit={e => { e.preventDefault(); if (/^[A-HJ-NP-Z2-9]{8}$/.test(code)) start(code); }}><label htmlFor="invite-code">Invite code</label><input id="invite-code" value={code} onChange={e => setCode(normalizeCode(e.target.value))} autoCapitalize="characters" autoComplete="off" spellCheck={false} placeholder="ABCD2345" maxLength={16} aria-describedby="code-hint"/><p id="code-hint">8 characters: A–Z except I/O, and 2–9. Paste the code if you like.</p><button className="primary" disabled={!/^[A-HJ-NP-Z2-9]{8}$/.test(code)}>Join session <span>↗</span></button></form></>}
    {screen === 'live' && <Live client={client} onExit={home}/>}
    {screen === 'demo' && <Demo onExit={home}/>}
    {screen === 'check' && <SensorCheck onExit={home}/>}
  </main><aside className="desktop-caption"><span className="tiny-dot"/><p>Closer, together.<br/><span>A temporary direction to a friend.</span></p></aside></div>;
}
