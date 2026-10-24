// Night Mode: the walk itself. Where you are, which street you're on, on track or behind, when to
// head home, and the turn-around alert. Everything here works from the plan saved on this phone:
// no network, no AI. Location stays on the phone.

import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { nextStretchLink } from '../route/schedule';
import { clock12, countdownText, minutesText, nightStatus, timeline, turnAroundDue } from '../route/status';
import { checkOff, onReading, pointAlong, startTrack, uncheck, type Reading } from '../route/track';
import type { Pt } from '../route/types';
import {
  forgetNight, freshProgress, loadNight, loadNightData, loadProgress, minutesOn, saveNight, saveProgress,
  type NightPlan, type NightProgress,
} from './nightStore';
import { Planner } from './planner';
import { patternText } from './planning';

const RouteMap = lazy(() => import('../map/RouteMap'));

/** The demo walk runs at 10x: ten seconds of the night for every second at the desk. */
const DEMO_SPEED = 10;
const TICK_MS = 250;

type Loc = 'off' | 'asking' | 'on' | 'denied' | 'unavailable';
type Wake = 'on' | 'refused' | 'unsupported' | 'pending';

const planner = new Planner();

/** Three short beeps. Only if the parent turned sound on. */
function beep(ctx: AudioContext) {
  for (let i = 0; i < 3; i++) {
    const t = ctx.currentTime + i * 0.35;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.4, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.25);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.3);
  }
}

export default function Night({ onLeave }: { onLeave: () => void }) {
  const [plan, setPlan] = useState<NightPlan | null>(loadNight);
  if (!plan) {
    return (
      <main className="app">
        <p>No plan is saved on this phone yet.</p>
        <button type="button" className="primary" onClick={onLeave}>Plan a route</button>
      </main>
    );
  }
  return <NightWalk key={plan.start} plan={plan} onPlan={setPlan} onLeave={onLeave} />;
}

function NightWalk({ plan, onPlan, onLeave }: { plan: NightPlan; onPlan: (p: NightPlan) => void; onLeave: () => void }) {
  const { segments, schedule } = plan;
  const n = segments.length;
  const tl = useMemo(() => timeline(schedule, plan.start), [schedule, plan.start]);

  const [progress, setProgressState] = useState<NightProgress>(() => loadProgress(n) ?? freshProgress(plan, false));
  const progressRef = useRef(progress);
  const setProgress = useCallback((p: NightProgress) => {
    progressRef.current = p;
    setProgressState(p);
    saveProgress(p);
  }, []);

  const [now, setNow] = useState(() => progress.demoClock ?? minutesOn(plan.date));
  const [fraction, setFraction] = useState<number | null>(null);
  const [you, setYou] = useState<Pt | null>(null);
  const [rough, setRough] = useState<number | null>(null);
  const [loc, setLoc] = useState<Loc>('off');
  const [wake, setWake] = useState<Wake>('pending');
  const [simulating, setSimulating] = useState(false);
  const [replanning, setReplanning] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const audio = useRef<AudioContext | null>(null);
  const watchId = useRef<number | null>(null);
  const sim = useRef({ row: 0, into: 0 });

  const { track } = progress;
  const status = nightStatus(tl, track.current, fraction, now);
  const countdown = countdownText(status);
  const link = nextStretchLink(segments, track.current);
  const doneHouses = progress.earlier.houses + schedule.rows.reduce((t, r, i) => t + (track.done[i] ? r.houses : 0), 0);
  const leftHouses = schedule.rows.reduce((t, r, i) => t + (track.done[i] ? 0 : r.houses), 0);
  const row = track.current < n ? schedule.rows[track.current] : null;
  const headingHome = status.headingHome;

  /** One GPS reading (real or the demo's): may move on one row, at the end of the current one. */
  const take = useCallback((r: Reading) => {
    const p = progressRef.current;
    const res = onReading(p.track, segments, r);
    if (!res.used) {
      setRough(Math.round(r.accuracy));
      return;
    }
    setRough(null);
    setYou([r.lat, r.lng]);
    setFraction(res.track.current === p.track.current ? res.fraction : null);
    if (res.track !== p.track) setProgress({ ...p, track: res.track });
  }, [segments, setProgress]);

  // The clock: this phone's, or the demo's own (10x while the demo walk runs).
  useEffect(() => {
    const id = setInterval(() => {
      const p = progressRef.current;
      if (p.demoClock === null) {
        setNow(minutesOn(plan.date));
        return;
      }
      const step = ((simulating ? DEMO_SPEED : 1) * TICK_MS) / 60000;
      const clock = p.demoClock + step;
      progressRef.current = { ...p, demoClock: clock };
      setNow(clock);
      if (!simulating) return;
      // Walk the demo dot along the route at the planned pace.
      const s = sim.current;
      if (p.track.current > s.row) Object.assign(s, { row: p.track.current, into: 0 });
      s.into += step;
      let dur = Math.max(0.05, tl.rows[s.row].end - tl.rows[s.row].start);
      while (s.into >= dur && s.row < n - 1) {
        s.into -= dur;
        s.row++;
        dur = Math.max(0.05, tl.rows[s.row].end - tl.rows[s.row].start);
      }
      const [lat, lng] = pointAlong(segments[s.row].points, Math.min(1, s.into / dur));
      take({ lat, lng, accuracy: 5 });
      if (progressRef.current.track.current >= n) setSimulating(false);
    }, TICK_MS);
    // Keep the demo clock across reloads, now and then.
    const save = setInterval(() => saveProgress(progressRef.current), 5000);
    return () => { clearInterval(id); clearInterval(save); saveProgress(progressRef.current); };
  }, [plan.date, simulating, segments, tl, n, take]);

  // The turn-around alert: once, at the latest safe time.
  useEffect(() => {
    if (!turnAroundDue(tl, track.current, now, progress.alerted)) return;
    setProgress({ ...progressRef.current, alerted: true });
    setDismissed(false);
    navigator.vibrate?.([400, 200, 400, 200, 800]);
    if (progress.sound && audio.current) beep(audio.current);
  }, [tl, track.current, now, progress.alerted, progress.sound, setProgress]);

  // Keep the screen awake while Night Mode is open. Phones may refuse; then say so once.
  useEffect(() => {
    let lock: WakeLockSentinel | null = null;
    let gone = false;
    const ask = async () => {
      if (!('wakeLock' in navigator)) { setWake('unsupported'); return; }
      try {
        lock = await navigator.wakeLock.request('screen');
        if (gone) { lock.release(); return; }
        setWake('on');
        lock.addEventListener('release', () => { if (!gone) setWake('refused'); });
      } catch {
        setWake('refused');
      }
    };
    const onVisible = () => { if (document.visibilityState === 'visible') ask(); };
    ask();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      gone = true;
      document.removeEventListener('visibilitychange', onVisible);
      lock?.release().catch(() => {});
    };
  }, []);

  // Sound can only start after a tap, so get it ready on the first one.
  useEffect(() => {
    if (!progress.sound) return;
    const unlock = () => {
      if (audio.current) return;
      try {
        audio.current = new AudioContext();
      } catch {
        // no sound on this phone; vibration and the banner still work
      }
    };
    window.addEventListener('pointerdown', unlock, { once: true });
    return () => window.removeEventListener('pointerdown', unlock);
  }, [progress.sound]);

  const startLocation = useCallback(() => {
    if (!('geolocation' in navigator)) { setLoc('unavailable'); return; }
    if (watchId.current !== null) return;
    setLoc('asking');
    watchId.current = navigator.geolocation.watchPosition(
      (pos) => {
        setLoc('on');
        take({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy });
      },
      (err) => {
        if (err.code === err.PERMISSION_DENIED) {
          setLoc('denied');
          if (watchId.current !== null) navigator.geolocation.clearWatch(watchId.current);
          watchId.current = null;
        } else setLoc((l) => (l === 'on' ? l : 'unavailable'));
      },
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 },
    );
  }, [take]);

  // If location was allowed before (say, before a reload), pick it up again without asking.
  useEffect(() => {
    if (plan.demo) return;
    navigator.permissions?.query({ name: 'geolocation' }).then((p) => {
      if (p.state === 'granted') startLocation();
    }).catch(() => {});
    return () => {
      if (watchId.current !== null) navigator.geolocation.clearWatch(watchId.current);
      watchId.current = null;
    };
  }, [plan.demo, startLocation]);

  function tapRow(i: number) {
    const p = progressRef.current;
    const t = p.track.done[i] ? uncheck(p.track, i) : checkOff(p.track, i);
    setFraction(null);
    setProgress({ ...p, track: t });
  }

  function toggleSim() {
    if (simulating) { setSimulating(false); return; }
    const p = progressRef.current;
    if (p.track.current >= n) return;
    sim.current = { row: p.track.current, into: 0 };
    // Start the demo clock at the planned time for this street, so the walk starts on track.
    const clock = Math.max(p.demoClock ?? 0, tl.rows[p.track.current].start);
    setProgress({ ...p, demoClock: clock });
    setNow(clock);
    setSimulating(true);
  }

  async function replan() {
    const data = loadNightData();
    if (!data) {
      setNote("The street data didn't fit on this phone, so replanning isn't possible. Use the check-offs and head home on time.");
      return;
    }
    const p = progressRef.current;
    const i = p.track.current;
    setReplanning(true);
    setNote(null);
    setSimulating(false);
    try {
      const visited = segments.flatMap((s, k) => (p.track.done[k] ? [{ points: s.points, pattern: s.pattern }] : []));
      const at = fraction !== null ? you : null;
      const res = await planner.replan(data, plan.home, { ...plan.options, now }, { row: segments[i], at }, visited);
      if (!res.ok) {
        setNote("We couldn't make a safe new route from here. Keep going and head home by the time on the bar.");
        return;
      }
      const next: NightPlan = { ...plan, start: now, segments: res.plan.segments, schedule: res.plan.schedule };
      const fresh: NightProgress = {
        track: startTrack(next.segments.length), alerted: false, sound: p.sound,
        earlier: { houses: doneHouses, streets: p.earlier.streets + p.track.done.filter(Boolean).length },
        demoClock: p.demoClock,
      };
      if (!saveNight(next, null, fresh)) {
        setNote("This phone wouldn't save the new plan. Keep going and head home by the time on the bar.");
        return;
      }
      progressRef.current = fresh;
      onPlan(next);
    } catch (e) {
      setNote(e instanceof Error && e.message !== 'cancelled' ? e.message : 'Replanning stopped. Try again.');
    } finally {
      setReplanning(false);
    }
  }

  function endNight() {
    if (!confirmEnd) { setConfirmEnd(true); return; }
    forgetNight();
    onLeave();
  }

  const turnAround = status.kind === 'turn_around';
  const kindClass = status.kind === 'before' || status.kind === 'done' ? 'on_track' : status.kind;

  return (
    <main className="night">
      <div className={`status-bar ${kindClass}`} role="status" aria-live="polite">
        <span className="status-main">{status.text}</span>
        <span className="status-sub">
          {countdown && <span>{countdown}</span>}
          <span className="status-clock">{clock12(now)}</span>
        </span>
      </div>

      {turnAround && !dismissed && (
        <div className="turn-banner" role="alert">
          <strong>Turn around now.</strong>
          <span>Head home to be back by {clock12(tl.windowEnd)}.</span>
          <button type="button" className="link" onClick={() => setDismissed(true)}>Got it</button>
        </div>
      )}

      <div className="app night-body">
        {plan.demo && (
          <div className="banner" role="status">
            <span>Demo night on made-up streets. Nothing is sent anywhere.</span>
          </div>
        )}

        <section className="panel now-card" aria-label="The street you're on">
          {row ? (
            <>
              <p className="now-label">
                {headingHome ? 'Last stretch' : `Now: street ${track.current + 1} of ${n}`}
                {' · '}{clock12(tl.rows[track.current].start)}
              </p>
              <h2 className="now-name">{row.street}</h2>
              <p className="now-how">{patternText(row.pattern)}{row.houses ? ` · ~${row.houses} houses` : ''}</p>
              <button type="button" className="primary huge" onClick={() => tapRow(track.current)}>
                {headingHome ? "We're home" : 'Done with this street'}
              </button>
            </>
          ) : (
            <>
              <h2 className="now-name">Home! Nice haul.</h2>
              <p className="now-how">About {doneHouses} houses tonight (an estimate).</p>
            </>
          )}
        </section>

        <Suspense fallback={<div className="map-wrap"><div className="map tall" aria-busy="true" /></div>}>
          <RouteMap segments={segments} lines={plan.lines} demo={plan.demo} you={you} done={track.done} current={track.current} tall />
        </Suspense>

        <div className="panel where">
          {plan.demo ? (
            <>
              <button type="button" className="secondary" onClick={toggleSim} disabled={track.current >= n}>
                {simulating ? 'Pause the walk' : 'Simulate the walk'}
              </button>
              <p className="muted small">Moves the dot along the Springwood route at 10x speed, with the clock.</p>
            </>
          ) : loc === 'on' ? (
            <p className="small">
              {rough !== null
                ? `Location is rough here (about ${rough} m), so it's not used. Check off streets as you go.`
                : 'Following you on the map. Your location stays on this phone.'}
            </p>
          ) : loc === 'denied' ? (
            <p className="small">Location is off, so check off each street as you finish it.</p>
          ) : (
            <>
              <p className="small">Haulween uses your location only on this phone. It's never sent anywhere.</p>
              {loc === 'unavailable' && <p className="small muted">Can't find your location right now. Check off streets as you go.</p>}
              <button type="button" className="secondary" onClick={startLocation} disabled={loc === 'asking'}>
                {loc === 'asking' ? 'Finding you…' : 'Show where I am'}
              </button>
            </>
          )}
        </div>

        {row && !headingHome && (
          <div className="replan">
            <button type="button" className="secondary" onClick={replan} disabled={replanning}>
              {replanning ? 'Replanning…' : 'Running late? Replan from here'}
            </button>
            <p className="muted small">
              Drops the streets with the fewest houses so you're home by {clock12(tl.windowEnd)}.
            </p>
          </div>
        )}
        {note && <p className="error" role="alert">{note}</p>}

        {link && (
          <p className="handoff small">
            <a href={link} target="_blank" rel="noopener noreferrer">Open the next stretch in Google Maps</a>
            <span className="muted"> · street points only</span>
          </p>
        )}

        <h3>Street by street</h3>
        <ol className="schedule night-rows">
          {schedule.rows.map((r, i) => (
            <li key={i} className={`${r.houses ? '' : 'pass'} ${track.done[i] ? 'done' : ''} ${i === track.current ? 'now' : ''}`}>
              <span className="pin" aria-hidden="true">{i + 1}</span>
              <div className="row-main">
                <span className="row-name">{r.street}</span>
                <span className="row-how">
                  {clock12(tl.rows[i].start)}{r.houses ? ` · ~${r.houses} ${r.houses === 1 ? 'house' : 'houses'}` : ''}
                </span>
              </div>
              <button
                type="button" className={`tick ${track.done[i] ? 'on' : ''}`} aria-pressed={track.done[i]}
                aria-label={`${r.street}: ${track.done[i] ? 'done. Tap to undo' : 'check off'}`} onClick={() => tapRow(i)}
              >
                {track.done[i] ? '✓' : ''}
              </button>
            </li>
          ))}
        </ol>

        <div className="panel totals">
          <div><span className="num">~{doneHouses}</span> houses so far</div>
          <div><span className="num">~{leftHouses}</span> to go</div>
          <div><span className="num">{clock12(tl.homeBy)}</span> home by plan</div>
          <div><span className="num">{status.headHomeIn !== null && status.headHomeIn > 0 ? minutesText(status.headHomeIn) : 'now'}</span> to head home</div>
        </div>

        {wake === 'refused' || wake === 'unsupported' ? (
          <p className="muted small">This phone won't keep the screen on for Haulween. Tap it now and then so it doesn't lock.</p>
        ) : wake === 'on' ? (
          <p className="muted small">The screen stays on while Night Mode is open.</p>
        ) : null}

        <div className="night-foot">
          <button type="button" className="secondary" onClick={onLeave}>Back to the plan</button>
          <button type="button" className="secondary" onClick={endNight}>
            {confirmEnd ? 'Tap again to end the night' : 'End the night'}
          </button>
        </div>
        <p className="muted small footnote">
          House counts are estimates. Haulween can't tell which houses give out candy. Look for porch lights.
        </p>
      </div>
    </main>
  );
}
