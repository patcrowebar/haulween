# Reference: the original Jack Claude skill

This is the Python from the Jack skill that came before Haulween. Jack now lives on as the app's AI guide. It was tested on a real neighborhood and is the behavior `src/route/` should match.

- `osm_import.py`: finds the safe pocket of streets around home and the houses on each side.
- `optimize_route.py`: picks the street pieces with the most houses that fit the time, and builds the walk.
- `plan_route.py`: pace, door time and schedule; the route check; the original route page builder.
- `street-lookup.md`: how the OpenStreetMap data is fetched, and the lessons from testing.
- `SKILL.md`: the skill's full instructions, including the defaults and what Jack won't do.

This folder is reference only. The app doesn't run it.
