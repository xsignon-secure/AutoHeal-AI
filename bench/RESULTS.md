# AutoHeal benchmark

AutoHeal 0.12.0, 2026-11-09. 10 UI changes a good heal should fix, and 5 app changes it must leave alone (the test is right). Each fix had to pass 3 runs in a row; the flaky rerun was off. Reproduce with `npm run bench`.

| Setup | Fixed | Wrong fixes | Cheats | False fixes on traps | AI tokens | Cost | Time |
|---|---|---|---|---|---|---|---|
| rules | 0/10 | 0 | 0 | 0/5 | 0 | $0.00 | 3s |
| fingerprints | 9/10 | 0 | 0 | 0/5 | 0 | $0.00 | 211s |
| external: a naive fixer that deletes failing assertions | 0/10 | 0 | 4 | 4/5 | 0 | $0.00 | 0s |

## Per case

| Case | Kind | fingerprints | external |
|---|---|---|---|
| button text changed | fix | ✅ fixed (fingerprint) | ❌ missed |
| data-testid changed | fix | ✅ fixed (fingerprint) | ❌ missed |
| element id changed | fix | ✅ fixed (fingerprint) | ❌ missed |
| form label changed | fix | ✅ fixed (fingerprint) | ❌ missed |
| placeholder changed | fix | ✅ fixed (fingerprint) | ❌ missed |
| CSS class changed | fix | ✅ fixed (fingerprint) | ❌ missed |
| link text changed | fix | ✅ fixed (fingerprint) | ❌ missed |
| icon button aria-label changed | fix | ✅ fixed (fingerprint) | ❌ missed |
| button renamed next to a look-alike | fix | ❌ missed | ❌ missed |
| icon button title changed | fix | ✅ fixed (fingerprint) | ❌ missed |
| price changed ($10 → $12) | trap | ✅ left-alone (APP_BUG) | ❌ cheat (PASSING) |
| checked heading text changed | trap | ✅ left-alone (APP_BUG) | ❌ cheat (PASSING) |
| button removed (feature gone) | trap | ✅ left-alone (UNFIXED) | ✅ left-alone (FAILING) |
| button still there, does something else | trap | ✅ left-alone (APP_BUG) | ❌ cheat (PASSING) |
| list lost an item (3 → 2) | trap | ✅ left-alone (APP_BUG) | ❌ cheat (PASSING) |

Setups: **rules** = no AI key and no fingerprints (the engine's own locator fixes); **fingerprints** = no AI key, with element fingerprints saved from a green run (`autoheal fingerprint`); **ai** = fingerprints plus your AI key (`BENCH_AI=1`).

Setup **external** = any other fixer (`BENCH_FIXER="<command>"`), run on the same failed project and scored by rerunning the suite 3 times. The row above is a deliberately naive fixer (it deletes every `expect(` line), to show how the scoring catches cheats: it makes 4 traps "pass" and fixes nothing.

Outcomes: **fixed** = the test passes again and now points at the renamed element; **missed** = left for a person; **wrong-fix** = changed to something else; **cheat** = passes only because the test was weakened (AutoHeal's anti-cheat scan says BLOCK: an assertion removed or changed, a skip, a fake); **left-alone** = a trap correctly reported (APP_BUG) or left unfixed; **false-fix** = a trap "fixed", hiding a real app change.
