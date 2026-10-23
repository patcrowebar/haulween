// The Plan screen: where you live, when you're going, who's walking. Then the route.

import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { DOOR_SECONDS_CHOICES, PLACEHOLDER_ADDRESS } from '../config';
import { ServiceError } from '../data/cache';
import { FallbackGeocoder, type Place } from '../data/geocoder';
import { OverpassClient } from '../data/overpass';
import { WeatherClient, type Tonight } from '../data/weather';
import type { OsmData, Pt } from '../route/types';
import Results from './Results';
import { Planner } from './planner';
import {
  DEFAULT_FORM, asksDoorTime, doorSecondsFor, youngestAge, type PlanForm, type PlanOnce, type PlanOutcome,
} from './planning';

const FORM_KEY = 'haulween.form';
const geocoder = new FallbackGeocoder();
const overpass = new OverpassClient();
const weather = new WeatherClient();
const planner = new Planner();

type Status = 'idle' | 'working' | 'done';
type Found = { home: Pt; label: string; data: OsmData; demo: boolean };

function loadForm(): PlanForm {
  try {
    const saved = localStorage.getItem(FORM_KEY);
    if (saved) return { ...DEFAULT_FORM, ...(JSON.parse(saved) as Partial<PlanForm>) };
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
const housesOf = (p: PlanOnce) => (p.result.ok ? p.result.plan.estimate.houses : null);
const NO_ROUTE = "We couldn't make a safe walk from here with these streets. Try a longer window or fewer roads to avoid.";

export default function Plan() {
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
        ? DOOR_SECONDS_CHOICES.map((s) => ({ seconds: s, houses: s === door ? housesOf(main) : undefined }))
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
        next = { home: DEMO.home, label: DEMO.label, data: DEMO.data, demo: true };
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
        setStep('Getting the streets around you…');
        const wx = weather.tonight(place.lat, place.lng, f.date, hourOf(f.start), hourOf(f.end));
        const data = await overpass.streetsNear(place.lat, place.lng);
        next = { home, label: place.label || 'Home', data, demo: false };
        wx.then((t) => { setTonight(t); setWeatherNote(null); }).catch(() => {
          setTonight(null);
          setWeatherNote('No forecast for that night yet. Open-Meteo forecasts about two weeks ahead.');
        });
      }
      setStep('Planning the walk… (a few seconds)');
      await show(next, f);
      setStatus('done');
      requestAnimationFrame(() => resultsRef.current?.scrollIntoView({ block: 'start' }));
    } catch (e) {
      if (e instanceof Error && e.message === 'cancelled') return;
      setError(e instanceof ServiceError || e instanceof Error ? e.message : 'Something went wrong. Try again.');
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
      p = (await planner.run(found.data, found.home, f, seconds).catch(() => null)) ?? undefined;
      if (tap === lastTap.current) setPendingDoor(null);
      if (!p || gen !== generation.current) return;
      byDoor.current.set(seconds, p);
    }
    const done = p;
    setOutcome((o) => {
      if (!o) return o;
      const estimates = o.estimates?.map((e) => (e.seconds === seconds ? { ...e, houses: housesOf(done) } : e)) ?? null;
      return tap === lastTap.current ? { ...done, estimates } : { ...o, estimates };
    });
    if (tap === lastTap.current) setError(done.result.ok ? null : NO_ROUTE);
  }

  useEffect(() => {
    if (wantsDemo) startDemo();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
          {status === 'working' ? step || 'Planning…' : outcome ? 'Plan again' : 'Plan my route'}
        </button>
        {!demo && (
          <button type="button" className="secondary" onClick={startDemo} disabled={status === 'working'}>
            Try the demo: 1428 Elm St
          </button>
        )}
      </form>

      <div ref={resultsRef}>
        {found && outcome?.result.ok && (
          <Results
            outcome={outcome} plan={outcome.result.plan} form={form} label={found.label}
            demo={found.demo} tonight={tonight} weatherNote={weatherNote} onDoor={chooseDoor} pendingDoor={pendingDoor}
          />
        )}
      </div>
    </main>
  );
}
