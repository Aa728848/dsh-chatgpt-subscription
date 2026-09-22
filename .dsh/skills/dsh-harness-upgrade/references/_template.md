# Harness <version>

Copy this file to `references/<version>.md` and fill it in while the evidence is
still in front of you. Keep it factual: paths, tags, numbers, and what is *not*
verified. The next upgrade starts by reading this.

Previous plugin baseline: **<old version>** (`<which dist-tag>`).
Target: **<new version>** (`<which dist-tag>`; npm dist-tags at the time: latest
`<…>`, next `<…>`, alpha `<…>`).
Harness checkout and tag every claim was read from: `git show dsh-v<version>:<path>`.

## 1. <Breaking change name> (<type-only | behavioural | fatal at boot>)

- What changed, where the evidence is: `<harness path>` at `dsh-v<version>`.
- Which commit or release introduced it, and whether older generations have it
  (`git tag --contains <sha>`).
- What breaks in this plugin if it is not bridged (name the failure mode: a type
  error, a wrong wire shape, or a boot failure).

**Bridge**: `<plugin file>` — the boundary it normalizes at, what stayed untouched,
and the test that pins both generations.

## 2. <…>

## 3. Smaller deltas

- Renames, vendor bumps (cordis / schemastery / loader) and anything whose blast
  radius turned out to be nil — say so explicitly, it saves the next round.

## 4. Verification of this round

- New baseline: typecheck, build, test counts, `npm pack --dry-run`, CI result.
- Old generation (clean-room with a complete closure): `tsc -b` result, test
  counts, and every test file that could not load, with the reason.
- Any dry run against real user data.

## 5. Left unverified

- What could not be exercised here, why, and the exact first check to run on a real
  machine (the log line to look for).
