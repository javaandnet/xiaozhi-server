#!/usr/bin/env python3
"""Generate new MasterPi action groups (.d6a, SQLite) composed ONLY from servo
values already used by the vendor action groups -> mechanically safe.

Run ON the Pi:  python3 generate_action_groups.py [--force]
Output dir:     ~/MasterPi/action_groups/

New groups:
  bow.d6a         deep bow (vendor lowest head-down value, s3=500)
  raise_right.d6a raise right arm high + hold (Hiwonder frames)
  dance.d6a       short dance remix (vendor choreography frames)
Idempotent: existing files are skipped unless --force. Writes via tmp+rename.
"""
import os
import sqlite3
import sys

DIR = os.path.expanduser("~/MasterPi/action_groups")

# (s1, s3, s4, s5, s6) tuples taken verbatim from vendor groups (verified dump)
STAND = (1500, 695, 2415, 780, 1500)      # stand.d6a
NEUTRAL = (1500, 590, 2500, 700, 1500)    # 1.d6a / Hiwonder* start pose
DEEP_HEAD_DOWN = (1500, 500, 2415, 780, 1500)  # s3=500 from 1.d6a + stand arms
RAISE_MID = (1500, 590, 2023, 2091, 1500)  # Hiwonder.d6a
RAISE_FULL = (1932, 750, 2023, 2364, 1500)  # Hiwonder.d6a (right arm high)
DANCE_A = (1455, 750, 2023, 1841, 2500)     # Hiwonder.d6a
DANCE_B = (2023, 750, 2023, 2250, 2500)     # Hiwonder.d6a
SHAKE_L = (1500, 590, 2500, 700, 550)       # shake_head.d6a
SHAKE_R = (1500, 590, 2500, 700, 2230)      # shake_head.d6a

GROUPS = {
    # Time semantics: ms to reach/hold this frame (vendor: 200=beat, 1500=settle)
    "bow": [
        (700, DEEP_HEAD_DOWN),
        (900, DEEP_HEAD_DOWN),
        (800, STAND),
        (400, STAND),
    ],
    "raise_right": [
        (500, RAISE_MID),
        (500, RAISE_FULL),
        (1200, RAISE_FULL),
        (500, RAISE_MID),
        (500, STAND),
        (400, STAND),
    ],
    "dance": [
        (400, NEUTRAL),
        (400, RAISE_MID),
        (400, RAISE_FULL),
        (400, DANCE_A),
        (400, DANCE_B),
        (300, SHAKE_L),
        (300, SHAKE_R),
        (400, DANCE_A),
        (400, RAISE_FULL),
        (500, STAND),
        (400, STAND),
    ],
}


def write_group(name, frames, force=False):
    path = os.path.join(DIR, "%s.d6a" % name)
    if os.path.exists(path) and not force:
        print("[gen] %s.d6a exists, skip (use --force to rewrite)" % name)
        return
    tmp = path + ".tmp"
    if os.path.exists(tmp):
        os.remove(tmp)
    con = sqlite3.connect(tmp)
    con.execute(
        "CREATE TABLE ActionGroup([Index] INTEGER PRIMARY KEY AUTOINCREMENT "
        "NOT NULL ON CONFLICT FAIL, Time INT, Servo1 INT, Servo3 INT, "
        "Servo4 INT, Servo5 INT, Servo6 INT)"
    )
    for t, pose in frames:
        con.execute(
            "INSERT INTO ActionGroup(Time,Servo1,Servo3,Servo4,Servo5,Servo6) "
            "VALUES(?,?,?,?,?,?)",
            [t, pose[0], pose[1], pose[2], pose[3], pose[4]],
        )
    con.commit()
    con.close()
    os.replace(tmp, path)
    total = sum(f[0] for f in frames)
    print("[gen] wrote %s.d6a frames=%d duration=%dms" % (name, len(frames), total))


def main():
    force = "--force" in sys.argv
    os.makedirs(DIR, exist_ok=True)
    for name, frames in GROUPS.items():
        write_group(name, frames, force=force)
    print("[gen] done")


if __name__ == "__main__":
    main()
