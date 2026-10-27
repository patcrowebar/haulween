// Night Mode: the walk itself. Where you are, which street you're on, on track or behind, when to
// head home, and the turn-around alert. Everything here works from the plan saved on this phone:
// no network, no AI. Location stays on the phone.

import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { askJack, makeQuestion, tryChange, type Suggestion } from '../ai/jack';
import { loadKey } from '../ai/key';
import { DEFAULT_PACE, paceChoice } from '../config';
import type { Plan, PlanOptions } from '../route/plan';
import { nextStretchLink } from '../route/schedule';
import {
  canStartEarly, clock12, countdownText, hasStarted, minutesText, nightStatus, replanTime, setsOffEarly, timeline, turnAroundDue,
} from '../route/status';
import { checkOff, onReading, pointAlong, startTrack, uncheck, type Reading } from '../route/track';
import type { OsmData, Pt } from '../route/types';
import AskJack, { type Preview } from './AskJack';
import {
  forgetNight, freshProgress, loadNight, loadNightData, loadProgress, minutesOn, saveNight, saveProgress,
  type NightPlan, type NightProgress,
} from './nightStore';
import { Planner, isCancelled, plainMessage } from './planner';
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

export default function Night({ onLeave, onSettings }: { onLeave: () => void; onSettings: () => void }) {
  const [plan, setPlan] = useState<NightPlan | null>(loadNight);
  // Each new plan (a replan, or Jack's change) starts the walk screen afresh.
  const [gen, setGen] = useState(0);
  if (!plan) {
    return (
      <main className="app">
        <p>No plan is saved on this phone yet.</p>
        <button type="button" className="primary" onClick={onLeave}>Plan a route</button>
      </main>
    );
  }
  const onPlan = (p: NightPlan) => { setPlan(p); setGen((g) => g + 1); };
  return <NightWalk key={gen} plan={plan} onPlan={onPlan} onLeave={onLeave} onSettings={onSettings} />;
}

function NightWalk({ plan, onPlan, onLeave, onSettings }: {
  plan: NightPlan; onPlan: (p: NightPlan) => void; onLeave: () => void; onSettings: () => void;
}) {
  const { segments, schedule } = plan;
  const n = segments.length;
  const tl = useMemo(() => timeline(schedule, plan.start, plan.date), [schedule, plan.start, plan.date]);

  const [progress, setProgressState] = useState<NightProgress>(() => loadProgress(plan) ?? freshProgress(plan, false));
  const progressRef = useRef(progress);
  const setProgress = useCallback((p: NightProgress) => {
    progressRef.current = p;
    setProgressState(p);
    saveProgress(p);
  }, []);

  const [now, setNowState] = useState(() => progress.demoClock ?? minutesOn(plan.date));
  const nowRef = useRef(now);
  const setNow = useCallback((t: number) => { nowRef.current = t; setNowState(t); }, []);
  const [fraction, setFraction] = useState<number | null>(null);
  const [you, setYou] = useState<Pt | null>(null);
  const [rough, setRough] = useState<number | null>(null);
  const [loc, setLoc] = useState<Loc>('off');
  const [wake, setWake] = useState<Wake>('pending');
  const [simulating, setSimulating] = useState(false);
  const [replanning, setReplanning] = useState(false);
  const [jackOn] = useState(() => loadKey() !== null);
  const [note, setNote] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const audio = useRef<AudioContext | null>(null);
  const watchId = useRef<number | null>(null);
  const sim = useRef({ row: 0, into: 0 });

  const { track } = progress;
  const started = hasStarted(tl, now, progress.startedEarly);
  const status = nightStatus(tl, track.current, fraction, now, started);
  const countdown = countdownText(status);
  const link = nextStretchLink(segments, track.current);
  const doneHouses = progress.earlier.houses + schedule.rows.reduce((t, r, i) => t + (track.done[i] ? r.houses : 0), 0);
  const leftHouses = schedule.rows.reduce((t, r, i) => t + (track.done[i] ? 0 : r.houses), 0);
  const row = track.current < n ? schedule.rows[track.current] : null;
  const headingHome = status.headingHome;

  /** One GPS reading (real or the demo's): may move on one row, at the end of the current one. */
  const take = useCallback((r: Reading) => {
    const p = progressRef.current;
    const t = nowRef.current;
    const res = onReading(p.track, segments, r);
    if (!res.used) {
      setRough(Math.round(r.accuracy));
      return;
    }
    setRough(null);
    setYou([r.lat, r.lng]);
    if (!hasStarted(tl, t, p.startedEarly)) {
      // Before the start, the dot moves but nothing is tracked, unless they've set off along
      // the route within a couple of hours of the start: then the night starts early.
      if (!setsOffEarly(tl, t, p.track, res.track)) return;
      setFraction(res.track.current === p.track.current ? res.fraction : null);
      setProgress({ ...p, track: res.track, startedEarly: true });
      return;
    }
    setFraction(res.track.current === p.track.current ? res.fraction : null);
    if (res.track !== p.track) setProgress({ ...p, track: res.track });
  }, [segments, setProgress, tl]);

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
  }, [plan.date, simulating, segments, tl, n, take, setNow]);

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
    // A tap always counts. Close to the start, it also starts the night early.
    const startedEarly = p.startedEarly || (!p.track.done[i] && canStartEarly(tl, nowRef.current));
    setProgress({ ...p, track: t, startedEarly });
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

  /**
   * The app's own replan from where the family is, with these options: the same for "Replan from
   * here" and for Jack's changes. Before the night starts, it plans from the planned start.
   */
  async function runReplan(options: PlanOptions, data: OsmData) {
    const p = progressRef.current;
    const i = p.track.current;
    const visited = segments.flatMap((s, k) => (p.track.done[k] ? [{ points: s.points, pattern: s.pattern }] : []));
    const at = fraction !== null ? you : null;
    const from = replanTime(tl, nowRef.current, started);
    const res = await planner.replan(data, plan.home, { ...options, now: from }, { row: segments[i], at }, visited);
    return { res, from };
  }

  /** Switch to a new route (already checked). Returns a message if this phone couldn't keep it. */
  function adopt(next: Pick<Plan, 'segments' | 'schedule'>, options: PlanOptions, from: number): string | null {
    const p = progressRef.current;
    const nextPlan: NightPlan = { ...plan, options, start: from, segments: next.segments, schedule: next.schedule };
    const fresh: NightProgress = {
      track: startTrack(nextPlan.segments.length), alerted: false, sound: p.sound,
      earlier: { houses: doneHouses, streets: p.earlier.streets + p.track.done.filter(Boolean).length },
      demoClock: p.demoClock, startedEarly: p.startedEarly || started,
    };
    if (!saveNight(nextPlan, null, fresh)) return "This phone wouldn't save the new plan. Keep going and head home by the time on the bar.";
    progressRef.current = fresh;
    onPlan(nextPlan);
    return null;
  }

  async function replan() {
    const data = loadNightData(plan);
    if (!data) {
      setNote("The street data didn't fit on this phone, so replanning isn't possible. Use the check-offs and head home on time.");
      return;
    }
    setReplanning(true);
    setNote(null);
    setSimulating(false);
    try {
      const { res, from } = await runReplan(plan.options, data);
      if (!res.ok) {
        setNote("We couldn't make a safe new route from here. Keep going and head home by the time on the bar.");
        return;
      }
      const problem = adopt(res.plan, plan.options, from);
      if (problem) setNote(problem);
    } catch (e) {
      setNote(isCancelled(e) ? 'Replanning stopped. Try again.' : plainMessage(e));
    } finally {
      setReplanning(false);
    }
  }

  /** Ask Jack, with only what he needs (see src/ai/jack.ts). */
  function ask(message: string) {
    const p = progressRef.current;
    return askJack(loadKey(), makeQuestion({
      title: plan.title, home: plan.home, lines: plan.lines, segments, schedule, tl,
      done: p.track.done, current: p.track.current, now: nowRef.current, minutesBehind: status.behindMin,
      paceMph: plan.options.paceMph ?? paceChoice(DEFAULT_PACE).mph, message,
    }));
  }

  /** Try Jack's change with the app's own replan and route check. Nothing changes until "Use this". */
  async function tryJack(s: Suggestion): Promise<Preview> {
    const data = loadNightData(plan);
    if (!data) return { ok: false, message: "The street data didn't fit on this phone, so Jack's ideas can't be tried. Your route still works." };
    setSimulating(false);
    const p = progressRef.current;
    const stamp = `${p.track.current}|${p.track.done.join()}`;
    let from = nowRef.current;
    try {
      const t = await tryChange(s, { options: plan.options, data, home: plan.home, lines: plan.lines }, async (options) => {
        const r = await runReplan(options, data);
        from = r.from;
        return r.res;
      });
      if (!t.ok) return t;
      return {
        ok: true, housesToGo: t.plan.estimate.houses, homeBy: timeline(t.plan.schedule, from).homeBy,
        use: () => {
          const q = progressRef.current.track;
          if (`${q.current}|${q.done.join()}` !== stamp) return "You've moved on since Jack suggested that. Ask him again.";
          return adopt(t.plan, t.options, from);
        },
      };
    } catch (e) {
      return { ok: false, message: isCancelled(e) ? "Trying Jack's idea stopped partway. Try again." : plainMessage(e) };
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
            <span>Demo night on made-up streets. Nothing is sent anywhere{jackOn ? ' unless you ask Jack' : ''}.</span>
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
              {!started && (
                <p className="now-how muted">
                  Night Mode starts following you at {clock12(tl.start)}, or as soon as you set off.
                </p>
              )}
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
        {jackOn && row && !headingHome && <AskJack ask={ask} tryIt={tryJack} housesToGo={leftHouses} />}

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
        <footer className="app-foot">
          <button type="button" className="link" onClick={onSettings}>Settings</button>
        </footer>
        <p className="muted small footnote">
          House counts are estimates. Haulween can't tell which houses give out candy. Look for porch lights.
        </p>
      </div>
    </main>
  );
}
