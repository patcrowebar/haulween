import { useEffect, useState } from 'react';
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

  return night ? <Night onLeave={() => go(false)} /> : <Plan onNight={() => go(true)} />;
}
