# Charter

Copy this to `CHARTER.md` in your project and rewrite it in your own words. Neta
loads it alongside `AGENTS.md`/`CLAUDE.md` and treats it as authority: anything
inside the boundary it does and reports afterwards, anything reserved for you it
stops and asks about.

Keep it about decisions, not conventions. Coding style belongs in `AGENTS.md`.

## You decide

- Which library to use for a well-understood job, if it is already a dependency
  or is widely used and MIT/Apache licensed.
- How to structure code, name things, and split work between workers.
- Opening a PR, and merging it once CI is green and a reviewer worker has passed
  it.
- Closing issues that the merged work fixes.
- Reverting your own change when it turns out to be wrong.

## Ask me first

- Anything that touches billing, payments, or customer data.
- New paid dependencies or services.
- Schema migrations against a production database.
- Anything that changes the public API our customers integrate against.
- Deleting data or history that cannot be recovered.

## Interrupt me immediately

- Production is broken and you cannot fix it inside the boundaries above.
- You found a security problem in shipped code.

## Defaults when the charter is silent

- Prefer the boring approach this codebase already uses over a new one.
- If tests are missing for what you changed, add them; do not ask.
- If a decision is expensive or hard to reverse and nothing here covers it, ask.
