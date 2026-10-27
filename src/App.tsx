import { Component, useEffect, useRef, useState, type ReactNode } from 'react';
import Night from './screens/Night';
import Plan from './screens/Plan';
import Settings from './screens/Settings';
import { loadNight } from './screens/nightStore';

// Three screens. "#night" opens Night Mode from the plan saved on this phone, so a reload mid-walk
// comes straight back to it. "#settings" holds the optional Claude key for Jack.
type Screen = 'plan' | 'night' | 'settings';

const screenOf = (): Screen => {
  const h = window.location.hash;
  if (h === '#settings') return 'settings';
  return h === '#night' && loadNight() !== null ? 'night' : 'plan';
};

export default function App() {
  const [screen, setScreen] = useState(screenOf);
  // Where Settings goes back to.
  const back = useRef<Screen>('plan');

  useEffect(() => {
    const onHash = () => setScreen(screenOf());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const go = (to: Screen) => {
    if (to === 'settings' && screen !== 'settings') back.current = screen;
    const url = window.location.pathname + window.location.search + (to === 'plan' ? '' : `#${to}`);
    window.history.pushState(null, '', url);
    setScreen(to === 'night' && loadNight() === null ? 'plan' : to);
    window.scrollTo(0, 0);
  };
  const settings = () => go('settings');

  return (
    <Plain>
      {screen === 'night' ? <Night onLeave={() => go('plan')} onSettings={settings} />
        : screen === 'settings' ? <Settings onBack={() => go(back.current)} />
          : <Plan onNight={() => go('night')} onSettings={settings} />}
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
