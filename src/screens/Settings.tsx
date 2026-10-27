// Settings: the visitor's own Claude API key for Jack, the optional AI guide. Everything else in
// Haulween works without it. The key is never shown again once saved.

import { useState, type FormEvent } from 'react';
import { forgetKey, loadKey, saveKey } from '../ai/key';

export default function Settings({ onBack }: { onBack: () => void }) {
  const [saved, setSaved] = useState(() => loadKey() !== null);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);

  function save(e: FormEvent) {
    e.preventDefault();
    const problem = saveKey(draft);
    setError(problem);
    if (problem) return;
    setDraft('');
    setSaved(true);
  }

  function forget() {
    forgetKey();
    setSaved(false);
  }

  return (
    <main className="app">
      <header className="masthead">
        <h1>Settings</h1>
      </header>

      <section className="panel settings" aria-labelledby="jack-heading">
        <h2 id="jack-heading">Jack, the AI guide <span className="muted">(optional)</span></h2>
        <p>
          In Night Mode, Jack can suggest a change when you're running late or someone's tired. You
          choose whether to use it. Haulween works fully without him.
        </p>

        {saved ? (
          <>
            <p className="key-saved">Your Claude API key is saved on this phone.</p>
            <button type="button" className="secondary" onClick={forget}>Forget my key</button>
          </>
        ) : (
          <form onSubmit={save}>
            <label className="field">
              <span>Your Claude API key</span>
              <input
                type="password" value={draft} autoComplete="off" autoCapitalize="off" spellCheck={false}
                placeholder="sk-ant-…" onChange={(e) => setDraft(e.target.value)}
              />
            </label>
            {error && <p className="error" role="alert">{error}</p>}
            <button type="submit" className="primary" disabled={!draft.trim()}>Save key</button>
          </form>
        )}

        <ul className="small settings-notes">
          <li>The key is kept only in this browser (localStorage) and sent only to Claude's API.</li>
          <li>
            Set a monthly spending limit on the key in the Claude Console. Each question costs well
            under a cent.
          </li>
          <li>
            Jack sees your remaining street names, house counts, times and what you type. Never your
            address, your location or your own street.
          </li>
        </ul>
      </section>

      <button type="button" className="secondary" onClick={onBack}>Back</button>
    </main>
  );
}
