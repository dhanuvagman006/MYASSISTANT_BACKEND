#!/bin/sh
# NIGHTLY BACKUP — SQLite DB (safe online snapshot via VACUUM INTO) plus
# the users' saved document files. Run from cron:
#   0 3 * * * DATA_DIR=/data BACKUP_DIR=/backups /app/scripts/backup.sh
# Ship $BACKUP_DIR to object storage (S3/GCS ap-south-1) with your tool
# of choice (rclone/aws cli). Retention: last 14 archives kept locally.
set -eu
DATA_DIR="${DATA_DIR:-./data}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
STAMP="$(date +%Y%m%d-%H%M%S)"
mkdir -p "$BACKUP_DIR/$STAMP"

# WAL-safe snapshot — never copy a live .db file directly.
sqlite3 "$DATA_DIR/myassistant.db" "VACUUM INTO '$BACKUP_DIR/$STAMP/myassistant.db'"

# Users' document files (hospital reports, receipts…)
if [ -d "$DATA_DIR/files" ]; then
  tar -czf "$BACKUP_DIR/$STAMP/files.tar.gz" -C "$DATA_DIR" files
fi

# Retention: keep the newest 14
ls -1dt "$BACKUP_DIR"/*/ 2>/dev/null | tail -n +15 | xargs -r rm -rf
echo "backup complete: $BACKUP_DIR/$STAMP"
