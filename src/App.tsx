import { Component, useEffect, useState, type ReactNode } from 'react';
import Night from './screens/Night';
import Plan from './screens/Plan';
import { loadNight } from './screens/nightStore';

// Two screens. "#night" opens Night Mode from the plan saved on this phone, so a reload mid-walk
// comes straight back to it.
const wantsNight = () => window.location.hash === '#night' && loadNight() !== null;

export default function App() {
  const [night, setNight] = useState(wantsNight);

  useEffect(() => {
    const onHash = () => setNight(wantsNight());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const go = (toNight: boolean) => {
    const url = window.location.pathname + window.location.search + (toNight ? '#night' : '');
    window.history.pushState(null, '', url);
    setNight(toNight && loadNight() !== null);
    window.scrollTo(0, 0);
  };

  return (
    <Plain>
      {night ? <Night onLeave={() => go(false)} /> : <Plan onNight={() => go(true)} />}
    </Plain>
  );
}

/** If a screen ever fails to draw, say so in plain words instead of showing a blank page. */
class Plain extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="app">
        <h1 className="masthead">Haulween</h1>
        <p role="alert">Something went wrong showing that. Reload the page to try again. A saved Night Mode plan is still on this phone.</p>
        <button type="button" className="primary" onClick={() => window.location.reload()}>Reload</button>
      </main>
    );
  }
}
