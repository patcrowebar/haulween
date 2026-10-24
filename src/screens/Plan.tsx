// The Plan screen: where you live, when you're going, who's walking. Then the route.

import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { DOOR_SECONDS_CHOICES, PLACEHOLDER_ADDRESS } from '../config';
import { FallbackGeocoder, type Place } from '../data/geocoder';
import { OverpassClient } from '../data/overpass';
import { WeatherClient, type Tonight } from '../data/weather';
import type { OsmData, Pt } from '../route/types';
import Results from './Results';
import { freshProgress, loadNight, saveNight, type NightPlan } from './nightStore';
import { Planner, isCancelled, plainMessage } from './planner';
import {
  DEFAULT_FORM, asksDoorTime, doorEstimate, doorSecondsFor, routeTitle, toForm, youngestAge, type PlanForm, type PlanOnce,
  type PlanOutcome,
} from './planning';
import { parseClock } from '../route/schedule';

const FORM_KEY = 'haulween.form';
const geocoder = new FallbackGeocoder();
const overpass = new OverpassClient();
const weather = new WeatherClient();
const planner = new Planner();

type Status = 'idle' | 'working' | 'done';
type Found = { home: Pt; title: string; data: OsmData; demo: boolean };

function loadForm(): PlanForm {
  try {
    const saved = localStorage.getItem(FORM_KEY);
    if (saved) return toForm(JSON.parse(saved));
  } catch {
    // no storage: start fresh
  }
  return DEFAULT_FORM;
}

function saveForm(form: PlanForm) {
  try {
    localStorage.setItem(FORM_KEY, JSON.stringify(form));
  } catch {
    // no storage: nothing to keep
  }
}

const hourOf = (hhmm: string) => Number(hhmm.split(':')[0]);
const NO_ROUTE = "We couldn't make a safe walk from here with these streets. Try a longer window or fewer roads to avoid.";

export default function Plan({ onNight }: { onNight: () => void }) {
  const wantsDemo = useMemo(() => new URLSearchParams(window.location.search).has('demo'), []);
  const [form, setForm] = useState<PlanForm>(loadForm);
  const [demo, setDemo] = useState(false);
  const [status, setStatus] = useState<Status>('idle');
  const [step, setStep] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [found, setFound] = useState<Found | null>(null);
  const [outcome, setOutcome] = useState<PlanOutcome | null>(null);
  const [tonight, setTonight] = useState<Tonight | null>(null);
  const [weatherNote, setWeatherNote] = useState<string | null>(null);
  const [credit, setCredit] = useState(geocoder.current.credit);
  const lastPlace = useRef<{ address: string; place: Place } | null>(null);
  /** Plans already worked out for this address and these answers, by door time. */
  const byDoor = useRef(new Map<number, PlanOnce>());
  const generation = useRef(0);
  const lastTap = useRef(0);
  /** The door time being planned after a tap, for its "planning…" label. */
  const [pendingDoor, setPendingDoor] = useState<number | null>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const [saved] = useState(() => loadNight());
  const [startError, setStartError] = useState<string | null>(null);

  const set = <K extends keyof PlanForm>(k: K, v: PlanForm[K]) => setForm((f) => ({ ...f, [k]: v }));
  const youngest = youngestAge(form.ages);

  /** Plan at the chosen door time and show it. Other door times are planned only when tapped. */
  async function show(next: Found, f: PlanForm) {
    planner.cancel();
    const gen = ++generation.current;
    byDoor.current = new Map();
    setPendingDoor(null);
    const door = doorSecondsFor(f);
    const main = await planner.run(next.data, next.home, f, door);
    if (gen !== generation.current) return;
    byDoor.current.set(door, main);
    setFound(next);
    setOutcome({
      ...main,
      estimates: asksDoorTime(main.youngest)
        ? DOOR_SECONDS_CHOICES.map((s) => (s === door ? doorEstimate(s, main.result) : { seconds: s, houses: undefined }))
        : null,
    });
    if (!main.result.ok) setError(NO_ROUTE);
  }

  async function plan(f: PlanForm, asDemo: boolean) {
    setError(null);
    if (youngestAge(f.ages) === null) {
      setError('Add the kids’ ages, like “6, 9”.');
      return;
    }
    if (!asDemo && !f.address.trim()) {
      setError('Add your home address, or try the demo.');
      return;
    }
    setStatus('working');
    try {
      let next: Found;
      if (asDemo) {
        const { DEMO } = await import('../demo');
        next = { home: DEMO.home, title: DEMO.title, data: DEMO.data, demo: true };
        setTonight(DEMO.tonight);
        setWeatherNote(null);
      } else {
        saveForm(f);
        let place = lastPlace.current?.address === f.address.trim() ? lastPlace.current.place : null;
        if (!place) {
          setStep('Finding your address…');
          place = await geocoder.search(f.address);
          setCredit(geocoder.current.credit);
          if (!place) {
            setError("We couldn't find that address. Try adding the town and state.");
            setStatus(found ? 'done' : 'idle');
            return;
          }
          lastPlace.current = { address: f.address.trim(), place };
        }
        const home: Pt = [place.lat, place.lng];
        setStep('Getting the streets…');
        const wx = weather.tonight(place.lat, place.lng, f.date, hourOf(f.start), hourOf(f.end));
        const data = await overpass.streetsNear(place.lat, place.lng);
        next = { home, title: routeTitle(place), data, demo: false };
        wx.then((t) => { setTonight(t); setWeatherNote(null); }).catch(() => {
          setTonight(null);
          setWeatherNote('No forecast for that night yet. Open-Meteo forecasts about two weeks ahead.');
        });
      }
      setStep('Planning your route…');
      await show(next, f);
      setStatus('done');
      requestAnimationFrame(() => resultsRef.current?.scrollIntoView({ block: 'start' }));
    } catch (e) {
      if (isCancelled(e)) return;
      setError(plainMessage(e));
      setStatus(found ? 'done' : 'idle');
    } finally {
      setStep('');
    }
  }

  function startDemo() {
    import('../demo').then(({ DEMO }) => {
      setDemo(true);
      setForm(DEMO.form);
      plan(DEMO.form, true);
    });
  }

  function leaveDemo() {
    planner.cancel();
    generation.current++;
    setDemo(false);
    setFound(null);
    setOutcome(null);
    setTonight(null);
    setStatus('idle');
    setForm(loadForm());
    if (wantsDemo) window.history.replaceState(null, '', window.location.pathname);
  }

  async function chooseDoor(seconds: number) {
    const f = { ...form, doorSeconds: seconds };
    setForm(f);
    if (!demo) saveForm(f);
    if (!found) return;
    const gen = generation.current;
    const tap = ++lastTap.current;
    let p = byDoor.current.get(seconds);
    if (!p) {
      setPendingDoor(seconds);
      let failed: string | null = null;
      p = await planner.run(found.data, found.home, f, seconds).catch((e: unknown) => {
        failed = isCancelled(e) ? 'cancelled' : plainMessage(e);
        return undefined;
      });
      if (tap === lastTap.current) setPendingDoor(null);
      if (failed && failed !== 'cancelled' && gen === generation.current && tap === lastTap.current) setError(failed);
      if (!p || gen !== generation.current) return;
      byDoor.current.set(seconds, p);
    }
    const done = p;
    setOutcome((o) => {
      if (!o) return o;
      const estimates = o.estimates?.map((e) => (e.seconds === seconds ? doorEstimate(seconds, done.result) : e)) ?? null;
      return tap === lastTap.current ? { ...done, estimates } : { ...o, estimates };
    });
    if (tap === lastTap.current) setError(done.result.ok ? null : NO_ROUTE);
  }

  useEffect(() => {
    if (wantsDemo) startDemo();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Save the plan on this phone and open Night Mode. */
  function startNight(sound: boolean) {
    if (!found || !outcome?.result.ok) return;
    const p = outcome.result.plan;
    const door = doorSecondsFor(form);
    const night: NightPlan = {
      v: 1, title: found.title, demo: found.demo, date: form.date, home: found.home,
      options: {
        startTime: form.start, endTime: form.end, youngestAge: outcome.youngest, stroller: form.stroller,
        doorSeconds: door, exclude: outcome.avoid.exclude,
      },
      start: parseClock(form.start),
      segments: p.segments,
      schedule: p.schedule,
      lines: { streetLines: p.pocket.streetLines, busyRoads: p.pocket.busyRoads, areas: p.pocket.areas },
    };
    if (!saveNight(night, found.data, freshProgress(night, sound))) {
      setStartError("This phone wouldn't let Haulween save the plan, so Night Mode can't start. Check that private browsing is off.");
      return;
    }
    onNight();
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    plan(form, demo);
  }

  return (
    <main className="app">
      <header className="masthead">
        <h1>Haulween</h1>
        <p className="muted">Plan your epic candy haul and be home on time.</p>
      </header>

      {saved && (
        <div className="panel resume">
          <p><strong>Tonight's walk is saved on this phone.</strong> {saved.title}.</p>
          <button type="button" className="primary" onClick={onNight}>Back to Night Mode</button>
        </div>
      )}

      {demo && (
        <div className="banner" role="status">
          <span>Demo: made-up streets around 1428 Elm St. Nothing is sent anywhere.</span>
          <button type="button" className="link" onClick={leaveDemo}>Leave demo</button>
        </div>
      )}

      <form className="panel form" onSubmit={onSubmit} noValidate>
        <label className="field">
          <span>Home address</span>
          <input
            type="text" value={form.address} placeholder={PLACEHOLDER_ADDRESS} autoComplete="street-address"
            readOnly={demo} onChange={(e) => set('address', e.target.value)}
          />
          <small className="muted">{demo ? 'The demo always starts here.' : `Only sent to address search. ${credit}.`}</small>
        </label>

        <label className="field">
          <span>Night</span>
          <input type="date" value={form.date} onChange={(e) => set('date', e.target.value)} />
        </label>
        <div className="row2">
          <label className="field">
            <span>Start</span>
            <input type="time" value={form.start} step={300} onChange={(e) => set('start', e.target.value)} />
          </label>
          <label className="field">
            <span>Home by</span>
            <input type="time" value={form.end} step={300} onChange={(e) => set('end', e.target.value)} />
          </label>
        </div>

        <label className="field">
          <span>Kids’ ages</span>
          <input
            type="text" inputMode="text" value={form.ages} placeholder="6, 9"
            onChange={(e) => set('ages', e.target.value)}
          />
          <small className="muted">
            {youngest === null
              ? 'The youngest sets the pace.'
              : asksDoorTime(youngest)
                ? `Youngest is ${youngest}. You'll pick how long you spend at each door.`
                : `Youngest is ${youngest}, so we'll plan about a minute a door.`}
          </small>
        </label>

        <label className="check">
          <input type="checkbox" checked={form.stroller} onChange={(e) => set('stroller', e.target.checked)} />
          <span>Bringing a stroller or wagon</span>
        </label>

        <label className="field">
          <span>Roads to avoid <span className="muted">(optional)</span></span>
          <input
            type="text" value={form.avoid} placeholder="Maple Ave, Oak St"
            onChange={(e) => set('avoid', e.target.value)}
          />
          <small className="muted">Busy roads are off-limits already.</small>
        </label>

        {error && <p className="error" role="alert">{error}</p>}

        <button className="primary" type="submit" disabled={status === 'working'}>
          {status === 'working' ? step || 'Working…' : outcome ? 'Plan again' : 'Plan my route'}
        </button>
        <p className="step" role="status" aria-live="polite">
          {status === 'working' && (
            <>
              <span className="spinner" aria-hidden="true" />
              {step || 'Working…'}
            </>
          )}
        </p>
        {!demo && (
          <button type="button" className="secondary" onClick={startDemo} disabled={status === 'working'}>
            Try the demo: 1428 Elm St
          </button>
        )}
      </form>

      <div ref={resultsRef}>
        {found && outcome?.result.ok && (
          <Results
            outcome={outcome} plan={outcome.result.plan} form={form} title={found.title}
            demo={found.demo} tonight={tonight} weatherNote={weatherNote} onDoor={chooseDoor} pendingDoor={pendingDoor}
            onStartNight={startNight}
          />
        )}
        {startError && <p className="error" role="alert">{startError}</p>}
      </div>
    </main>
  );
}
