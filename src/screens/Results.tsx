// The plan: totals and head-home times, door time, tonight's weather, the map, the schedule.

import { Suspense, lazy, useState } from 'react';
import type { Plan } from '../route/plan';
import { nextStretchLink } from '../route/schedule';
import { flagsFor, updatedText, type Tonight } from '../data/weather';
import { paceChoice } from '../config';
import { ampm, choiceKey, leftOut, patternText, type Estimate, type PlanForm, type PlanOutcome } from './planning';

// MapLibre is most of the app's size; load it once there's a route to draw.
const RouteMap = lazy(() => import('../map/RouteMap'));

type Props = {
  outcome: PlanOutcome;
  plan: Plan;
  form: PlanForm;
  title: string;
  demo: boolean;
  tonight: Tonight | null;
  weatherNote: string | null;
  /** A tap on a door time or a pace. */
  onChoose: (patch: Partial<Pick<PlanForm, 'doorSeconds' | 'pace'>>) => void;
  /** The choice being planned right now (its choiceKey). */
  pending: string | null;
  /** Open Night Mode with this plan; `sound` is whether to beep at turn-around time. */
  onStartNight: (sound: boolean) => void;
};

/** "~152 houses", or why there's no number yet. */
const housesText = (e: Estimate, planning: boolean) =>
  planning ? 'planning…' : e.houses === undefined ? 'tap to see' : e.houses === null ? 'no route fits' : `~${e.houses} houses`;

export default function Results({ outcome, plan, form, title, demo, tonight, weatherNote, onChoose, pending, onStartNight }: Props) {
  const { schedule, estimate, segments } = plan;
  const leg = schedule.lastLeg;
  const link = nextStretchLink(segments, 0);
  const skipped = leftOut(plan.skipped, plan.walked);
  const { avoid } = outcome;
  const [sound, setSound] = useState(false);

  return (
    <section className="results" aria-labelledby="results-title">
      <h2 id="results-title">{title}</h2>

      <div className="stats">
        <div className="stat big">
          <span className="num">~{estimate.houses}</span>
          <span className="label">houses (estimate)</span>
        </div>
        <div className="stat big">
          <span className="num">{ampm(schedule.homeBy24)}</span>
          <span className="label">home by</span>
        </div>
        {leg && (
          <>
            <div className="stat">
              <span className="num">{ampm(leg.start24)}</span>
              <span className="label">start heading home</span>
            </div>
            <div className="stat warn">
              <span className="num">{ampm(leg.latest24)}</span>
              <span className="label">latest safe time to head home</span>
            </div>
          </>
        )}
      </div>

      <fieldset className="panel doors">
        <legend>How long at each door?</legend>
        <p className="muted small">Tap one to see how many houses it fits, and how many streets you'll cross.</p>
        <div className="door-grid">
          {outcome.doors.map((e) => {
            const planning = pending === choiceKey({ ...form, doorSeconds: e.seconds });
            return (
              <label key={e.seconds} className={`door ${form.doorSeconds === e.seconds ? 'on' : ''}`}>
                <input
                  type="radio" name="door" value={e.seconds} checked={form.doorSeconds === e.seconds}
                  onChange={() => onChoose({ doorSeconds: e.seconds })}
                />
                <span className="door-s">{e.seconds} sec</span>
                <span className="door-h">{housesText(e, planning)}</span>
                {typeof e.houses === 'number' && e.crossings !== undefined && !planning && (
                  <span className="door-h">{e.crossings} {e.crossings === 1 ? 'crossing' : 'crossings'}</span>
                )}
              </label>
            );
          })}
        </div>
      </fieldset>

      <fieldset className="panel doors">
        <legend>How fast do you walk?</legend>
        <p className="muted small">Tap one to see how many houses it fits, and when you'd be home.</p>
        <div className="door-grid">
          {outcome.paces.map((e) => {
            const choice = paceChoice(e.pace);
            const planning = pending === choiceKey({ ...form, pace: e.pace });
            return (
              <label key={e.pace} className={`door ${form.pace === e.pace ? 'on' : ''}`}>
                <input
                  type="radio" name="pace" value={e.pace} checked={form.pace === e.pace}
                  onChange={() => onChoose({ pace: e.pace })}
                />
                <span className="door-s">{choice.label}</span>
                <span className="door-d">{choice.description}</span>
                <span className="door-h">{housesText(e, planning)}</span>
                {typeof e.houses === 'number' && e.homeBy24 && !planning && (
                  <span className="door-h">home by {ampm(e.homeBy24)}</span>
                )}
              </label>
            );
          })}
        </div>
      </fieldset>

      <TonightCard tonight={tonight} note={weatherNote} demo={demo} />

      <div className="panel start-night">
        <button type="button" className="primary huge" onClick={() => onStartNight(sound)}>Start the night</button>
        <label className="check">
          <input type="checkbox" checked={sound} onChange={(e) => setSound(e.target.checked)} />
          <span>Play a sound when it's time to turn around</span>
        </label>
        <p className="muted small">
          Saved on this phone. Once Night Mode is open, it keeps working if you lose signal. Open it before you head out.
        </p>
      </div>

      <Suspense fallback={<div className="map-wrap"><div className="map" aria-busy="true" /></div>}>
        <RouteMap segments={segments} lines={plan.pocket} demo={demo} />
      </Suspense>

      <h3>Street by street</h3>
      <ol className="schedule">
        {schedule.rows.map((r, i) => (
          <li key={i} className={r.houses ? '' : 'pass'}>
            <span className="pin" aria-hidden="true">{i + 1}</span>
            <div className="row-main">
              <span className="row-name">{r.street}</span>
              <span className="row-how">{patternText(r.pattern)}</span>
            </div>
            <div className="row-side">
              <span className="row-time">{ampm(r.t24)}</span>
              <span className="row-meta">{r.houses ? `~${r.houses} ${r.houses === 1 ? 'house' : 'houses'} · ` : ''}{r.minutes} min</span>
            </div>
          </li>
        ))}
      </ol>

      <div className="panel totals">
        <div><span className="num">{schedule.totals.distanceMiles}</span> miles</div>
        <div><span className="num">{schedule.totals.walkingMinutes}</span> min walking</div>
        <div><span className="num">{schedule.totals.doorMinutes}</span> min at doors</div>
        <div><span className="num">{schedule.totals.streetCrossings}</span> street crossings</div>
        <p className="muted small">
          {paceChoice(form.pace).label} pace, {schedule.pace.doorSeconds} sec a door, {schedule.minutesSpare} min to spare.
        </p>
      </div>

      {(skipped.length > 0 || avoid.exclude.length > 0 || avoid.notFound.length > 0 || avoid.alreadyOff.length > 0) && (
        <div className="panel notes">
          {skipped.length > 0 && (
            <p>Left out to fit the time: {skipped.map((s) => `${s.text} (~${s.houses})`).join(', ')}.</p>
          )}
          {avoid.exclude.length > 0 && <p>Skipping, as you asked: {avoid.exclude.join(', ')}.</p>}
          {avoid.alreadyOff.length > 0 && <p>{avoid.alreadyOff.join(', ')}: busy, so it's off the route already.</p>}
          {avoid.notFound.length > 0 && <p>We didn't find {avoid.notFound.join(', ')} near home.</p>}
        </div>
      )}

      {link && (
        <p className="handoff small">
          <a href={link} target="_blank" rel="noopener noreferrer">Open the next stretch in Google Maps</a>
          <span className="muted"> · street points only, never your address</span>
        </p>
      )}

      <p className="muted small footnote">
        House counts are estimates from the length of each street, minus parks, schools and corners.
        Haulween can't tell which houses give out candy. Look for porch lights.
      </p>
    </section>
  );
}

function TonightCard({ tonight, note, demo }: { tonight: Tonight | null; note: string | null; demo: boolean }) {
  if (!tonight) return note ? <p className="panel muted small">{note}</p> : null;
  const f = flagsFor(tonight);
  const temps = tonight.hours.map((h) => h.tempF);
  return (
    <div className="panel tonight">
      <h3>Forecast</h3>
      <div className="tonight-grid">
        <div><span className="label">Sunset</span><span className="num">{ampm(tonight.sunset)}</span></div>
        <div><span className="label">Dark by</span><span className="num">{ampm(tonight.dark)}</span></div>
        {temps.length > 0 && (
          <div>
            <span className="label">Temp</span>
            <span className="num">{Math.max(...temps)}° → {Math.min(...temps)}°F</span>
          </div>
        )}
      </div>
      <ul className="flags">
        <li>Bring flashlights or glow sticks once it's dark.</li>
        {f.cold && <li>Feels like {f.lowF}°F by the end. Layers under costumes.</li>}
        {f.rain ? <li>{f.maxRain}% chance of rain. Pack ponchos.</li> : <li>Rain unlikely ({f.maxRain}% at most).</li>}
      </ul>
      <p className="muted small">
        {demo ? 'Demo weather, made up.' : 'Weather by Open-Meteo.'}
        {!demo && tonight.fetchedAt !== undefined && <><br />{updatedText(tonight.fetchedAt, Date.now())}</>}
      </p>
    </div>
  );
}
