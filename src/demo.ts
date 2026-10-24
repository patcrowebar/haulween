// Demo mode: the made-up Springwood neighborhood and 1428 Elm St, so the Plan screen works with
// no network at all (in development and for screenshots). Loaded only when the demo is opened.

import { PLACEHOLDER_ADDRESS } from './config';
import type { Tonight } from './data/weather';
import { HOME, SPRINGWOOD } from './route/__fixtures__/springwood';
import { nextHalloween, type PlanForm } from './screens/planning';

export const DEMO = {
  home: HOME,
  data: SPRINGWOOD,
  title: 'Your route from Elm St, Springwood (demo)',
  form: {
    address: PLACEHOLDER_ADDRESS,
    date: nextHalloween(),
    start: '17:00',
    end: '20:00',
    ages: '10, 13',
    stroller: false,
    avoid: '',
    doorSeconds: 60,
  } satisfies PlanForm,
  /** A made-up but typical Halloween night. */
  tonight: {
    date: nextHalloween(),
    sunset: '18:31',
    dark: '19:01',
    hours: [
      { time: '17:00', tempF: 56, feelsF: 55, rainChance: 5 },
      { time: '18:00', tempF: 53, feelsF: 51, rainChance: 10 },
      { time: '19:00', tempF: 49, feelsF: 46, rainChance: 15 },
      { time: '20:00', tempF: 46, feelsF: 43, rainChance: 15 },
    ],
  } satisfies Tonight,
};
