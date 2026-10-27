// "Ask Jack" in Night Mode. Shown only when this phone has a Claude key. Jack answers in a line or
// two and may suggest one change; the app tries it with its own replan and route check, and the
// parent decides. Nothing changes until they tap "Use this".

import { useState, type FormEvent } from 'react';
import { MAX_MESSAGE, type JackAnswer, type Suggestion } from '../ai/jack';
import { paceChoice } from '../config';
import { clock12 } from '../route/status';

/** A change tried out, ready for the parent to take or leave. */
export type Preview =
  | { ok: true; housesToGo: number; homeBy: number; use: () => string | null }
  | { ok: false; message: string };

type State =
  | { at: 'idle' }
  | { at: 'asking' }
  | { at: 'trying'; s: Suggestion }
  | { at: 'answered'; s: Suggestion; preview: Preview | null }
  | { at: 'failed'; message: string };

/** The change in the app's own words, whatever Jack's reply says. */
function changeText(s: Suggestion): string {
  switch (s.kind) {
    case 'skip': return `Skip ${s.streets.join(', ')}`;
    case 'home_by': return `Be home by ${clock12(s.at)}`;
    case 'pace': return `Walk at a ${paceChoice(s.pace).label} pace`;
    case 'none': return '';
  }
}

export default function AskJack({ ask, tryIt, housesToGo }: {
  ask: (message: string) => Promise<JackAnswer>;
  tryIt: (s: Suggestion) => Promise<Preview>;
  /** Houses left on the route as it is, to compare with. */
  housesToGo: number;
}) {
  const [message, setMessage] = useState('');
  const [state, setState] = useState<State>({ at: 'idle' });
  const busy = state.at === 'asking' || state.at === 'trying';

  async function onAsk(e: FormEvent) {
    e.preventDefault();
    if (!message.trim() || busy) return;
    setState({ at: 'asking' });
    const a = await ask(message);
    if (!a.ok) { setState({ at: 'failed', message: a.message }); return; }
    if (a.suggestion.kind === 'none') { setState({ at: 'answered', s: a.suggestion, preview: null }); return; }
    setState({ at: 'trying', s: a.suggestion });
    setState({ at: 'answered', s: a.suggestion, preview: await tryIt(a.suggestion) });
  }

  function use(p: Preview & { ok: true }) {
    const problem = p.use();
    // On success the new route replaces this screen.
    if (problem) setState({ at: 'failed', message: problem });
  }

  const done = () => { setState({ at: 'idle' }); setMessage(''); };

  return (
    <section className="panel jack" aria-labelledby="jack-title">
      <h3 id="jack-title">Ask Jack</h3>
      <form onSubmit={onAsk} className="jack-ask">
        <input
          type="text" value={message} maxLength={MAX_MESSAGE} enterKeyHint="send" aria-label="Your question for Jack"
          placeholder="we're 15 minutes behind" onChange={(e) => setMessage(e.target.value)} disabled={busy}
        />
        <button type="submit" className="primary" disabled={busy || !message.trim()}>
          {state.at === 'asking' ? 'Asking…' : 'Ask'}
        </button>
      </form>
      <p className="muted small">Jack sees your streets and times, never your address. No need to type it.</p>

      <div aria-live="polite">
        {state.at === 'failed' && (
          <p className="jack-note">
            {state.message}{' '}
            <button type="button" className="link" onClick={() => setState({ at: 'idle' })}>OK</button>
          </p>
        )}

        {(state.at === 'trying' || state.at === 'answered') && (
          <div className="jack-answer">
            <p className="jack-reply">{state.s.reply}</p>
            {state.s.kind !== 'none' && <p className="jack-change">Jack suggests: {changeText(state.s)}.</p>}
            {state.at === 'trying' && <p className="muted small">Checking the route…</p>}

            {state.at === 'answered' && state.preview === null && (
              <button type="button" className="secondary" onClick={done}>Got it</button>
            )}
            {state.at === 'answered' && state.preview?.ok === false && (
              <>
                <p className="jack-note">{state.preview.message}</p>
                <button type="button" className="secondary" onClick={done}>OK</button>
              </>
            )}
            {state.at === 'answered' && state.preview?.ok && (
              <>
                <p className="small">
                  New route: about {state.preview.housesToGo} houses to go (now {housesToGo}), home by{' '}
                  {clock12(state.preview.homeBy)}.
                </p>
                <div className="jack-choice">
                  <button type="button" className="primary" onClick={() => use(state.preview as Preview & { ok: true })}>Use this</button>
                  <button type="button" className="secondary" onClick={done}>No thanks</button>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
