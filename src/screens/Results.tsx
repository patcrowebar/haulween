// The plan: totals and head-home times, door time, tonight's weather, the map, the schedule.

import { Suspense, lazy } from 'react';
import { routeLine } from '../map/pins';
import type { Plan } from '../route/plan';
import { mapsLinks } from '../route/schedule';
import { flagsFor, type Tonight } from '../data/weather';
import { ampm, type PlanForm, type PlanOutcome } from './planning';

// MapLibre is most of the app's size; load it once there's a route to draw.
const RouteMap = lazy(() => import('../map/RouteMap'));

type Props = {
  outcome: PlanOutcome;
  plan: Plan;
  form: PlanForm;
  label: string;
  demo: boolean;
  tonight: Tonight | null;
  weatherNote: string | null;
  onDoor: (seconds: number) => void;
};

const PATTERN_TEXT: Record<string, string> = {
  zigzag: 'Zigzag: both sides as you go',
  'walk through, skip the houses': 'Walk through, skip the houses',
};
const patternText = (p: string) => PATTERN_TEXT[p] ?? p.charAt(0).toUpperCase() + p.slice(1);

export default function Results({ outcome, plan, form, label, demo, tonight, weatherNote, onDoor }: Props) {
  const { schedule, estimate, segments } = plan;
  const leg = schedule.lastLeg;
  const links = mapsLinks(routeLine(segments)[0], segments);
  const skipped = Object.entries(plan.skipped).sort((a, b) => b[1] - a[1]);
  const { avoid } = outcome;

  return (
    <section className="results" aria-labelledby="results-title">
      <h2 id="results-title">Your route from {label}</h2>

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

      {outcome.estimates && (
        <fieldset className="panel doors">
          <legend>How long at each door?</legend>
          <p className="muted small">Older kids are quicker. Pick what fits your crew.</p>
          <div className="door-grid">
            {outcome.estimates.map((e) => (
              <label key={e.seconds} className={`door ${form.doorSeconds === e.seconds ? 'on' : ''}`}>
                <input
                  type="radio" name="door" value={e.seconds} checked={form.doorSeconds === e.seconds}
                  onChange={() => onDoor(e.seconds)}
                />
                <span className="door-s">{e.seconds} sec</span>
                <span className="door-h">
                  {e.houses === undefined ? 'estimating…' : e.houses === null ? 'no route fits' : `~${e.houses} houses`}
                </span>
              </label>
            ))}
          </div>
        </fieldset>
      )}

      <TonightCard tonight={tonight} note={weatherNote} demo={demo} />

      <Suspense fallback={<div className="map-wrap"><div className="map" aria-busy="true" /></div>}>
        <RouteMap plan={plan} demo={demo} />
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
          Pace {schedule.pace.mph} mph for a {outcome.youngest}-year-old{form.stroller ? ' with a stroller' : ''},
          {' '}{schedule.pace.doorSeconds} sec a door, {schedule.minutesSpare} min to spare.
        </p>
      </div>

      {(skipped.length > 0 || avoid.exclude.length > 0 || avoid.notFound.length > 0 || avoid.alreadyOff.length > 0) && (
        <div className="panel notes">
          {skipped.length > 0 && (
            <p>Left out to fit the time: {skipped.map(([n, h]) => `${n} (~${h})`).join(', ')}.</p>
          )}
          {avoid.exclude.length > 0 && <p>Skipping, as you asked: {avoid.exclude.join(', ')}.</p>}
          {avoid.alreadyOff.length > 0 && <p>{avoid.alreadyOff.join(', ')}: busy, so it's off the route already.</p>}
          {avoid.notFound.length > 0 && <p>We didn't find {avoid.notFound.join(', ')} near home.</p>}
        </div>
      )}

      <div className="handoff">
        {links.map((href, i) => (
          <a key={href} className="primary button" href={href} target="_blank" rel="noopener noreferrer">
            Open in Google Maps{links.length > 1 ? `, part ${i + 1} of ${links.length}` : ''}
          </a>
        ))}
        <p className="muted small">Google Maps gets the street points of the route, not your address.</p>
      </div>

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
      <h3>Tonight</h3>
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
      <p className="muted small">{demo ? 'Demo weather, made up.' : 'Weather by Open-Meteo.'}</p>
    </div>
  );
}
