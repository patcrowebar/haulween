# Jack, the optional AI guide

Jack runs on the visitor's own Claude API key and lives only in Night Mode for now ("Ask Jack").
The app works fully without him: no key, no Jack, and nothing here runs.

- `key.ts` keeps the key in this browser only (`localStorage`). It's saved, loaded and forgotten here and nowhere else.
- `jack.ts` builds the question, makes the one call to Claude, checks the answer, and tries the change.
- `screens/AskJack.tsx` is the box in Night Mode, and `screens/Settings.tsx` is where the key is added.

## One question, start to finish

1. **The question** (`makeQuestion`). It's built on the phone from the Night Mode plan. Claude gets
   only `JackContext`:

   ```json
   {
     "now": "6:01 pm",
     "headHome": "7:31 pm",
     "homeBy": "8:00 pm",
     "minutesBehind": 15,
     "pace": "Steady",
     "streets": [
       { "name": "Maple Ave to Birch St", "houses": 32, "planned": "5:46 pm", "current": true },
       { "name": "Birch St to your street", "houses": 20, "planned": "6:45 pm" },
       { "name": "Willow Ct to the dead end", "houses": 6, "planned": "7:18 pm" },
       { "name": "the walk home", "houses": 11, "planned": "7:31 pm" }
     ],
     "canSkip": ["Birch St", "Willow Ct"],
     "slowerPaces": ["Slow"],
     "message": "we're 15 minutes behind"
   }
   ```

   Never the address, coordinates or the plan's title. The home street is worked out on the phone,
   from the title and from the street line nearest home. Wherever a row names it, it's sent as
   "your street", and the last row is "the walk home". Jack can't skip the street they're on, the
   walk home or the home street, and only streets with houses are offered.

2. **The call** (`askJack`). A `POST` to `https://api.anthropic.com/v1/messages` with `fetch`
   (no SDK). The key goes only in the `x-api-key` header, with
   `anthropic-dangerous-direct-browser-access: true`. The request has `CLAUDE_MODEL`
   (`claude-haiku-5-5`), `max_tokens` 400, effort `low`, thinking off, a fixed system prompt, and one
   user message (the JSON above). There's no history, no retry, a 15 s limit, and only standard
   (non-beta) features. It never throws: every failure comes back as one plain line.

3. **The answer** (`readAnswer`). Structured output (`output_config.format`, a JSON schema):

   ```json
   { "reply": "You could skip Willow Ct and still be home on time.", "change": "skip",
     "skip": ["Willow Ct"], "homeBy": null, "pace": null }
   ```

   `change` is `none`, `skip`, `home_by` (an earlier time, like "7:30 pm") or `pace` (a slower one).
   The whole answer is refused if any of these hold: it isn't JSON, a street wasn't offered, the
   time isn't between now and the current home-by, the pace isn't slower, the reply is empty or
   too long, or it was cut off or declined.

4. **Trying it** (`tryChange`). The change becomes plan options (skipped streets go into `exclude`,
   an earlier `endTime`, a slower `paceMph`). The app's own replan runs with them, and the result goes
   through `checkRoute` again against the plan's street lines. A route that fails is refused:
   "That change wouldn't make a safe route, so your route stays as it is."

5. **The parent decides.** Night Mode shows Jack's line, the change in the app's own words, and
   the houses to go and home-by time. The route changes only on "Use this".

## Tests

`jack.test.ts` and `key.test.ts` mock Claude throughout: no real key and no network. They use the
Springwood fixture only.
