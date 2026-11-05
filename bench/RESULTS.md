# AutoHeal benchmark

AutoHeal 0.10.0, 2026-11-05. 9 UI changes a good heal should fix, and 4 app changes it must leave alone (the test is right). Each fix had to pass 3 runs in a row; the flaky rerun was off. Reproduce with `npm run bench`.

| Setup | Fixed | Wrong fixes | False fixes on traps | AI tokens | Cost | Time |
|---|---|---|---|---|---|---|
| rules | 0/9 | 0 | 0/4 | 0 | $0.00 | 3s |
| fingerprints | 8/9 | 0 | 0/4 | 0 | $0.00 | 198s |

## Per case

| Case | Kind | rules | fingerprints |
|---|---|---|---|
| button text changed | fix | ❌ missed | ✅ fixed (fingerprint) |
| data-testid changed | fix | ❌ missed | ✅ fixed (fingerprint) |
| element id changed | fix | ❌ missed | ✅ fixed (fingerprint) |
| form label changed | fix | ❌ missed | ✅ fixed (fingerprint) |
| placeholder changed | fix | ❌ missed | ✅ fixed (fingerprint) |
| CSS class changed | fix | ❌ missed | ✅ fixed (fingerprint) |
| link text changed | fix | ❌ missed | ✅ fixed (fingerprint) |
| icon button aria-label changed | fix | ❌ missed | ✅ fixed (fingerprint) |
| button renamed next to a look-alike | fix | ❌ missed | ❌ missed |
| price changed ($10 → $12) | trap | ✅ left-alone (APP_BUG) | ✅ left-alone (APP_BUG) |
| checked heading text changed | trap | ✅ left-alone (APP_BUG) | ✅ left-alone (APP_BUG) |
| button removed (feature gone) | trap | ✅ left-alone (UNFIXED) | ✅ left-alone (UNFIXED) |
| button still there, does something else | trap | ✅ left-alone (APP_BUG) | ✅ left-alone (APP_BUG) |

Setups: **rules** = no AI key and no fingerprints (the engine's own locator fixes); **fingerprints** = no AI key, with element fingerprints saved from a green run (`autoheal fingerprint`); **ai** = fingerprints plus your AI key (`BENCH_AI=1`).

Outcomes: **fixed** = the test passes again and now points at the renamed element; **missed** = left for a person; **wrong-fix** = changed to something else; **left-alone** = a trap correctly reported (APP_BUG) or left unfixed; **false-fix** = a trap "fixed", hiding a real app change.
