#!/bin/sh
# Everything that has to hold before a commit. Run it directly, or let the
# pre-commit hook run it: `git config core.hooksPath tests/hooks`.
#
# Two things are checked, in this order, because the second is meaningless
# without the first: the tests lift their functions out of the built script, so
# a build that does not match src/ tests the previous version of the code.
set -e

cd "$(dirname "$0")/.."

echo "== build =="
python build.py --check
node --check gemini-imgen-enhancer.user.js
echo "the built script matches src/ and parses"

echo "== tests =="
status=0
for t in tests/*.test.js; do
  # Per CLAUDE.md: no test waits indefinitely. Ten seconds is well above the
  # measured runtime of any of these, all of which are pure computation.
  if timeout 10 node "$t"; then
    :
  else
    echo "FAILED: $t"
    status=1
  fi
done

exit $status
