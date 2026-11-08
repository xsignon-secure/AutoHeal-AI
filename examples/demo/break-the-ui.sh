#!/usr/bin/env bash
# Makes three UI changes in one commit, the kind that break e2e tests every week:
#   1. the "Log in" button is renamed to "Sign in"      -> test bug: AutoHeal fixes the test
#   2. the cart button's test id changes                -> test bug: AutoHeal fixes the test
#   3. the Pro plan now shows $12 instead of $10        -> app change: AutoHeal opens an issue
#                                                          and leaves the test alone
# Then push, and watch the Actions tab.
set -euo pipefail
cd "$(dirname "$0")"
sed -i.bak \
  -e 's/<button type="submit">Log in<\/button>/<button type="submit">Sign in<\/button>/' \
  -e 's/data-testid="add-mug"/data-testid="add-to-cart-mug"/' \
  -e 's/\$10 a month/$12 a month/' \
  app/server.mjs
rm -f app/server.mjs.bak
git add app/server.mjs
git commit -m "Shop: new button labels, cart test ids and Pro price"
echo "Now run: git push"
