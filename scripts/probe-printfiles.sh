#!/usr/bin/env bash
#
# Probe for issue #11: what the authenticated printfiles endpoint actually
# returns, so print area geometry can be modelled against real field names
# rather than guessed ones.
#
# Printful publishes no schema for this endpoint — their OpenAPI download
# returns 404 and the docs pages omit the field lists — so the response itself
# is the only specification available.
#
# Reads PRINTFUL_API_TOKEN from the environment. The token is never echoed and
# never written to the output files.
#
#   PRINTFUL_API_TOKEN=... ./scripts/probe-printfiles.sh
#
# Writes one JSON file per product under .probe/ (gitignored), then prints a
# summary. Share the summary; the raw files stay local.

set -euo pipefail

if [ -z "${PRINTFUL_API_TOKEN:-}" ]; then
  echo "PRINTFUL_API_TOKEN is not set." >&2
  echo "Get one at https://developers.printful.com/tokens/ (scope: read)." >&2
  exit 1
fi

OUT=".probe"
mkdir -p "$OUT"

# One per product class. A cap is embroidery and a poster is print media, so
# their print areas are likely shaped differently from a tee's — probing only
# a tee would generalise from the easiest case.
probe() {
  local id="$1"
  local label="$2"
  local path="$3"
  # Split across lines on purpose: under `set -u`, a name declared on the same
  # `local` line is not yet in scope for the ones after it.
  local file="$OUT/${label}-${id}-$(basename "$path").json"

  local code
  code=$(curl -s -o "$file" -w "%{http_code}" \
    -H "Authorization: Bearer $PRINTFUL_API_TOKEN" \
    "https://api.printful.com/$path/$id")

  echo "=== $label ($id) via $path → HTTP $code ==="
  if [ "$code" != "200" ]; then
    # Error bodies carry no token and are safe to show; they say whether the
    # endpoint is gone, the scope is wrong, or the id does not exist.
    head -c 400 "$file"
    echo
    return
  fi

  # Field names, not values: the question is what the schema is.
  python3 - "$file" <<'PY'
import json, sys

with open(sys.argv[1]) as fh:
    body = json.load(fh)

result = body.get("result", body)

def shape(node, path="", depth=0):
    """Print the key structure, with one sample scalar per leaf."""
    if depth > 3:
        return
    if isinstance(node, dict):
        for key, value in node.items():
            if isinstance(value, (dict, list)):
                print(f"  {path}{key}: {type(value).__name__}")
                shape(value, f"{path}{key}.", depth + 1)
            else:
                print(f"  {path}{key} = {value!r}")
    elif isinstance(node, list) and node:
        print(f"  {path}[{len(node)} items], first:")
        shape(node[0], f"{path}0.", depth + 1)

shape(result)
PY
  echo
}

# The three product classes the plugin already distinguishes.
probe 71 tee mockup-generator/printfiles
probe 206 cap mockup-generator/printfiles
probe 1 poster mockup-generator/printfiles

echo "Raw responses are in $OUT/ (gitignored)."
