import { PLACEHOLDER_ADDRESS } from './config';

export default function App() {
  return (
    <main className="app">
      <h1>Haulween</h1>
      <p className="muted">Plan your epic candy haul and be home on time.</p>
      <label className="field">
        <span>Home address</span>
        <input type="text" placeholder={PLACEHOLDER_ADDRESS} autoComplete="street-address" />
      </label>
      <button className="primary" type="button" disabled>
        Plan my route
      </button>
    </main>
  );
}
