#!/usr/bin/env bash
# Stage 6 — run ON THE SERVER as root.
# Shows what the session database stores, printing FIELD NAMES ONLY.
# No values, no passwords, no tokens are ever printed.
set -uo pipefail

ADMIN="${ADMIN:-$(dirname "$0")/mongo-admin.sh}"
if [ ! -f "$ADMIN" ]; then
  echo "FAIL  mongo-admin.sh is missing next to this script"
  exit 1
fi

# The query is kept in a variable rather than written to a predictable file in
# /tmp — a root process writing a fixed name there can be redirected by anyone
# who plants a symlink, and there is no reason to take that risk.
JS="$(cat <<'EOF'
var found = 0;
db.adminCommand({ listDatabases: 1 }).databases.forEach(function (d) {
  if (["admin", "local", "config"].indexOf(d.name) >= 0) return;
  var top = db.getSiblingDB(d.name);
  top.getCollectionNames().forEach(function (n) {
    var col = top.getCollection(n);
    var doc = col.findOne();
    var keys = doc ? Object.keys(doc).join(", ") : "(no documents)";
    var count = col.countDocuments();
    print("  " + d.name + "." + n + "  [" + count + " docs]");
    print("      fields: " + keys);
    found++;
  });
});
if (found === 0) print("  (no user data stored yet)");
EOF
)"

echo "Session database contents — field names only"
echo "--------------------------------------------"
bash "$ADMIN" --quiet --eval "$JS"
STATUS=$?

if [ "$STATUS" -ne 0 ]; then
  echo
  echo "FAIL  could not read the database"
  exit 1
fi

echo
echo "Anything named password, pwd, secret or token in the field list above"
echo "means credentials are being stored without encryption."
