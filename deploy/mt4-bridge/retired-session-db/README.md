# Retired: the session database

These scripts are kept for reference only. **They are not part of the runbook
and should not be run.**

They set up and protect a MongoDB container that sat next to the broker
bridges and stored broker passwords in clear text on disk. Its only benefit was
that sessions survived a restart — but the application already signs accounts in
again by itself, within about four minutes in the background or immediately
when the next trade arrives.

On 2026-09-29 the decision was taken to remove it rather than encrypt it. That
means broker passwords now exist only in the application's own encrypted
records; the copy on the VPS is gone instead of being locked behind a
passphrase. See `10-remove-session-db.sh` in the parent directory.

| Script | What it did |
|---|---|
| `02-check-db.sh` | checked the database container, password and network |
| `03-mt5-bridge.sh` | put the existing MT5 bridge onto the database |
| `06-inspect-db.sh` | listed which fields the database stored |
| `mongo-admin.sh` | shared database query helper |
| `07-luks-setup.sh` | moved the database onto an encrypted disk area |
| `08-luks-unlock.sh` | unlocked that area after a reboot |
| `09-tls-setup.sh` | encrypted the traffic between the bridges and the database |

They were written, tested and reviewed before the decision changed. If the
session-resume behaviour is ever wanted back, this is the starting point — but
the underlying problem (a broker password written in clear text) would need
solving properly, not wrapping.
