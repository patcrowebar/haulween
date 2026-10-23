Saved Overpass responses used by the route tests.

Only commit data for a neighborhood that is nobody's real home. Never commit a
street-data sample taken around a real home address.

- `springwood.overpass.json`: a made-up neighborhood in the exact shape of an
  Overpass response, placed over open water in Lake Erie so it matches no real
  block. Built by `make-springwood.mjs`, which lists what each street is there
  to test (busy roads of each kind, a park, a school, a dead end, a no-house
  connector, and a street that comes back in two pieces with a yard between).
- `springwood.ts`: the parsed data and the placeholder home, 1428 Elm St.

The expected numbers in the tests come from running the Python in `reference/`
on this fixture (`reference/run_fixture.py`).
