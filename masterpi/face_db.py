"""
人脸库:存储 SFace 128 维人脸嵌入并做身份匹配(识别环节,检测仍归 vision)。

职责划分:
- vision.py 负责"像素 -> 嵌入"(YuNet 检脸 + SFace 对齐取特征);
- 本文件只管"嵌入 -> 身份"与人脸库持久化,不触碰相机/舵机。

存储:与本文件同目录的 faces.json(schema v2,派上即 ~/masterpi_client/faces.json):
  {"version": 2,
   "persons": {id: {"id": id, "name": 称呼, "embeddings": [[128 floats], ...],
                    "created_at": ms, "updated_at": ms}},
   "current_login": {"id": id, "ts": ms} | null}
- id: 登记时自动生成的稳定主键(p_xxxxxx),可经 rename 修改;增删改/识别定位一律按 id。
- name(称呼): 展示/播报用,可随时改;id 与 name 全局唯一(大小写不敏感查重)。
- v1(以 name 为键)旧库在 load 时自动迁移为 v2 并落盘。
阈值:config.json 的 robot.vision.recogThreshold(SFace 官方余弦距离阈值 0.363)。
损坏兜底:faces.json 解析失败时先备份为 faces.json.bad-<ts> 再从空库开始。

CLI(供 studio 经 SSH 轻量调用):
  python3 face_db.py list
  python3 face_db.py delete <id或称呼>
  python3 face_db.py rename <id或称呼> [--id 新ID] [--name 新称呼]   # 查重
  python3 face_db.py login <id或称呼> [/ logout / 空=登出]
  python3 face_db.py facelogin [on|off]   # 读 / 写"人脸登录"功能开关(默认 off)
  python3 face_db.py threshold [value]   # 读 / 写识别判定阈值
  python3 face_db.py clear
"""

import json
import logging
import os
import re
import secrets
import time

log = logging.getLogger("masterpi.face_db")

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, "faces.json")
CONFIG_PATH = os.path.join(BASE_DIR, "config.json")

DEFAULT_THRESHOLD = 0.363   # SFace cosine distance (official benchmark)
MAX_EMBEDS_PER_PERSON = 5   # keep multi-pose samples, replace oldest beyond that
DUPLICATE_DIST = 0.05       # near-identical samples within one person are merged
EMBED_DIM = 128
ID_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"  # no i/l/o/0/1 (hand-typed friendly)
ID_LEN = 6
ID_RE = re.compile(r"p_[%s]{4,16}" % ID_ALPHABET)  # user-supplied ids must look like ids


def _now_ms():
    return int(time.time() * 1000)


def gen_id():
    """Random p_xxxxxx id; caller loops on collision against existing db."""
    return "p_" + "".join(secrets.choice(ID_ALPHABET) for _ in range(ID_LEN))


def _validate_id(pid):
    if pid and not ID_RE.fullmatch(pid):
        raise ValueError("bad id format (want p_[a-z2-9]{4,16}, no i/l/o/0/1): %s" % pid)
    return pid


# ---- persistence ----
def _migrate_v1(db):
    """v1 {name: rec} -> v2 {id: rec+id+name}; returns True if changed."""
    persons = db.get("persons") or {}
    changed = False
    new_persons = {}
    for key, rec in persons.items():
        if not isinstance(rec, dict):
            changed = True
            continue
        if "id" in rec and "name" in rec:
            new_persons[key] = rec
            continue
        # v1 record: key is the name, no id yet
        pid = rec.get("id") or gen_id()
        while pid in new_persons:
            pid = gen_id()
        new_rec = dict(rec)
        new_rec["id"] = pid
        new_rec["name"] = rec.get("name") or str(key)
        new_persons[pid] = new_rec
        changed = True
    if changed:
        db["persons"] = new_persons
        db["version"] = 2
        db.setdefault("current_login", None)
    return changed


def load_db():
    """Read faces.json (auto-migrate v1->v2, persisting). On corrupt file,
    back it up and start from an empty db."""
    if not os.path.exists(DB_PATH):
        return {"version": 2, "persons": {}, "current_login": None}
    try:
        with open(DB_PATH, "r", encoding="utf-8") as f:
            db = json.load(f)
        if not isinstance(db, dict) or not isinstance(db.get("persons"), dict):
            raise ValueError("unexpected schema")
        if _migrate_v1(db):
            log.info("faces.json migrated to schema v2")
            save_db(db)
        db.setdefault("current_login", None)
        return db
    except Exception as e:
        bak = DB_PATH + ".bad-%d" % _now_ms()
        log.warning("faces.json unreadable (%r), backup to %s, start empty", e, bak)
        try:
            os.replace(DB_PATH, bak)
        except Exception:
            pass
        return {"version": 2, "persons": {}, "current_login": None}


def save_db(db):
    """Atomic write: tmp file + os.replace, so concurrent readers never see half JSON."""
    tmp = DB_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(db, f, ensure_ascii=False)
    os.replace(tmp, DB_PATH)


# ---- lookup / uniqueness ----
def _check_unique(persons, pid, name, exclude_id=None):
    """id/name both globally unique (case-insensitive); raise ValueError on dup."""
    for other_id, rec in persons.items():
        if other_id == exclude_id:
            continue
        other_name = str(rec.get("name", ""))
        if pid and pid.lower() == str(other_id).lower():
            raise ValueError("duplicate id: %s" % other_id)
        if name and name.lower() == other_name.lower():
            raise ValueError("duplicate name(称呼已存在): %s" % other_name)


def find_person(db, key):
    """Resolve a person by id first, then by name (both case-insensitive).
    Returns (id, rec) or (None, None)."""
    persons = db["persons"]
    key = str(key or "").strip()
    if not key:
        return None, None
    rec = persons.get(key)
    if rec is not None:
        return key, rec
    kl = key.lower()
    for pid, rec in persons.items():
        if pid.lower() == kl or str(rec.get("name", "")).lower() == kl:
            return pid, rec
    return None, None


# ---- threshold config ----
def get_threshold():
    """Read robot.vision.recogThreshold from config.json; default 0.363 on any failure."""
    try:
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            cfg = json.load(f)
        vision = (cfg.get("robot", {}) or {}).get("vision", {}) or {}
        val = vision.get("recogThreshold")
        if isinstance(val, (int, float)) and 0.0 < val < 1.0:
            return float(val)
    except Exception as e:
        log.warning("read recogThreshold failed (%r), use default", e)
    return DEFAULT_THRESHOLD


def set_threshold(value):
    """Write robot.vision.recogThreshold (backup config first, atomic replace)."""
    value = float(value)
    if not 0.05 <= value <= 0.95:
        raise ValueError("threshold out of sane range 0.05~0.95: %s" % value)
    cfg = {}
    if os.path.exists(CONFIG_PATH):
        bak = CONFIG_PATH + ".bak"
        try:
            with open(CONFIG_PATH, "r", encoding="utf-8") as f:
                cfg = json.load(f)
            with open(bak, "w", encoding="utf-8") as f:
                json.dump(cfg, f, ensure_ascii=False, indent=2)
        except Exception as e:
            raise RuntimeError("config.json unreadable, refuse to rewrite: %r" % e)
    robot = cfg.setdefault("robot", {})
    vision = robot.setdefault("vision", {})
    vision["recogThreshold"] = value
    tmp = CONFIG_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)
    os.replace(tmp, CONFIG_PATH)
    return value


# ---- face login feature switch (default OFF) ----
def get_face_login_enabled():
    """Read robot.vision.faceLoginEnabled from config.json; default False (disabled)."""
    try:
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            cfg = json.load(f)
        vision = (cfg.get("robot", {}) or {}).get("vision", {}) or {}
        return bool(vision.get("faceLoginEnabled", False))
    except Exception as e:
        log.warning("read faceLoginEnabled failed (%r), use default (disabled)", e)
        return False


def set_face_login_enabled(value):
    """Write robot.vision.faceLoginEnabled (backup config first, atomic replace)."""
    value = bool(value)
    cfg = {}
    if os.path.exists(CONFIG_PATH):
        bak = CONFIG_PATH + ".bak"
        try:
            with open(CONFIG_PATH, "r", encoding="utf-8") as f:
                cfg = json.load(f)
            with open(bak, "w", encoding="utf-8") as f:
                json.dump(cfg, f, ensure_ascii=False, indent=2)
        except Exception as e:
            raise RuntimeError("config.json unreadable, refuse to rewrite: %r" % e)
    robot = cfg.setdefault("robot", {})
    vision = robot.setdefault("vision", {})
    vision["faceLoginEnabled"] = value
    tmp = CONFIG_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)
    os.replace(tmp, CONFIG_PATH)
    return value


# ---- math (embeddings are L2-normalized by vision.embed_face) ----
def normalize(embed):
    import math
    norm = math.sqrt(sum(v * v for v in embed))
    if norm <= 1e-9:
        raise ValueError("degenerate embedding (all zeros)")
    return [v / norm for v in embed]


def cos_distance(a, b):
    """Cosine distance for L2-normalized vectors: 1 - dot(a, b)."""
    return 1.0 - sum(x * y for x, y in zip(a, b))


# ---- library operations ----
def enroll(name, embeds, pid=None):
    """Add/merge normalized embeddings. New person gets an auto (or given) id;
    re-enrolling an existing name merges samples (legacy compatible).
    Raises ValueError on id/name duplication (when both given) or invalid input."""
    name = str(name or "").strip()
    pid = _validate_id(str(pid or "").strip())
    if not name and not pid:
        raise ValueError("empty name")
    if "/" in name:
        raise ValueError("name must not contain '/': %s" % name)
    clean = []
    for e in embeds or []:
        if not isinstance(e, (list, tuple)) or len(e) != EMBED_DIM:
            continue
        try:
            clean.append(normalize([float(v) for v in e]))
        except ValueError:
            continue
    if not clean:
        raise ValueError("no valid %d-dim embedding provided" % EMBED_DIM)

    db = load_db()
    persons = db["persons"]
    rec = None
    if pid:
        _, rec = find_person(db, pid)  # enroll into an existing id = update it
        _check_unique(persons, pid, None, exclude_id=rec and pid)
        if name:
            _check_unique(persons, None, name, exclude_id=rec and pid)
    elif name:
        _, rec = find_person(db, name)  # same-name enroll merges (legacy behavior)
    if rec is None:
        while not pid or any(str(p.get("id", "")).lower() == pid.lower() for p in persons.values()):
            pid = gen_id()
        rec = {"id": pid, "name": name, "embeddings": [], "created_at": _now_ms()}
        persons[pid] = rec
    else:
        cur = str(rec.get("name", ""))
        if name and name.lower() != cur.lower():
            rec["name"] = name  # case-insensitive same-name merge keeps the stored form
    existing = rec["embeddings"]
    for e in clean:
        # skip near-duplicates of what we already stored (multi-frame burst overlap)
        if any(cos_distance(e, x) < DUPLICATE_DIST for x in existing):
            continue
        existing.append(e)
    if len(existing) > MAX_EMBEDS_PER_PERSON:
        del existing[:len(existing) - MAX_EMBEDS_PER_PERSON]
    rec["updated_at"] = _now_ms()
    save_db(db)
    log.info("enrolled id=%s name=%s samples=%d", rec["id"], rec["name"], len(existing))
    return {"id": rec["id"], "name": rec["name"],
            "samples": len(existing), "added": len(clean)}


def rename(key, new_id=None, new_name=None):
    """Change id and/or name of a person (located by id-or-name). Both targets
    are re-checked for global uniqueness (case-insensitive)."""
    new_id = _validate_id(str(new_id or "").strip())
    new_name = str(new_name or "").strip()
    if not new_id and not new_name:
        raise ValueError("nothing to rename (give --id and/or --name)")
    if "/" in new_name:
        raise ValueError("name must not contain '/'")
    db = load_db()
    persons = db["persons"]
    pid, rec = find_person(db, key)
    if rec is None:
        raise ValueError("person not found: %s" % key)
    _check_unique(persons, new_id or None, new_name or None, exclude_id=pid)
    out = {"id": pid, "name": rec.get("name")}
    if new_name:
        rec["name"] = new_name
    if new_id and new_id != pid:
        rec["id"] = new_id
        persons.pop(pid)
        persons[new_id] = rec
        login = db.get("current_login")
        if login and login.get("id") == pid:
            login["id"] = new_id
        pid = new_id
    rec["updated_at"] = _now_ms()
    save_db(db)
    log.info("renamed %s -> id=%s name=%s", out["id"], pid, rec.get("name"))
    return {"renamed": True, "old_id": out["id"], "old_name": out["name"],
            "id": pid, "name": rec.get("name")}


def match(embed, threshold=None):
    """Nearest person for one embedding. name=None when beyond threshold (unknown face)."""
    thr = get_threshold() if threshold is None else float(threshold)
    e = normalize([float(v) for v in embed])
    best_id, best_name, best_dist = None, None, 2.0
    second_dist = 2.0
    for pid, rec in load_db()["persons"].items():
        for stored in rec.get("embeddings", []):
            d = cos_distance(e, stored)
            if d < best_dist:
                second_dist = best_dist
                best_id, best_name, best_dist = pid, rec.get("name"), d
            elif d < second_dist:
                second_dist = d
    hit = best_dist <= thr
    return {"name": best_name if hit else None,
            "id": best_id if hit else None,
            "nearest": best_name, "nearest_id": best_id,
            "distance": round(best_dist, 4),
            "second_distance": round(second_dist, 4), "threshold": thr}


def identify(embeds, threshold=None):
    """Vote over per-frame matches: majority name wins, tie broken by min distance."""
    if not embeds:
        return {"person": None, "person_id": None, "reason": "no face sample", "samples": 0}
    thr = get_threshold() if threshold is None else float(threshold)
    stats = {}
    for e in embeds:
        m = match(e, thr)
        if m["name"]:
            s = stats.setdefault(m["id"], {"name": m["name"], "votes": 0, "min_distance": 2.0})
            s["votes"] += 1
            s["min_distance"] = min(s["min_distance"], m["distance"])
    if not stats:
        return {"person": None, "person_id": None, "reason": "no registered face matched",
                "samples": len(embeds), "threshold": thr}
    winner_id, w = max(stats.items(), key=lambda kv: (kv[1]["votes"], -kv[1]["min_distance"]))
    return {"person": w["name"], "person_id": winner_id,
            "distance": round(w["min_distance"], 4),
            "votes": w["votes"], "samples": len(embeds), "threshold": thr,
            "ballot": {k: v["votes"] for k, v in stats.items()}}


def list_persons():
    out = []
    for pid, rec in load_db()["persons"].items():
        out.append({"id": pid, "name": rec.get("name"),
                    "samples": len(rec.get("embeddings", [])),
                    "created_at": rec.get("created_at"), "updated_at": rec.get("updated_at")})
    out.sort(key=lambda p: p.get("created_at") or 0)
    return out


def delete_person(key):
    """Delete by id first, then by name."""
    db = load_db()
    pid, rec = find_person(db, key)
    existed = rec is not None
    if existed:
        del db["persons"][pid]
        login = db.get("current_login")
        if login and login.get("id") == pid:
            db["current_login"] = None
        save_db(db)
        log.info("deleted person id=%s name=%s", pid, rec.get("name"))
    return {"deleted": existed, "id": pid, "name": rec.get("name") if rec else str(key).strip()}


# ---- login state (identity recorded after a face-based login) ----
def login(key=None, distance=None):
    """Set current_login by id-or-name; key=None means logout."""
    db = load_db()
    if key is None or str(key).strip() == "":
        db["current_login"] = None
        save_db(db)
        log.info("logged out")
        return {"logged_in": False}
    pid, rec = find_person(db, key)
    if rec is None:
        raise ValueError("person not found: %s" % key)
    db["current_login"] = {"id": pid, "ts": _now_ms(),
                           "distance": round(float(distance), 4) if distance is not None else None}
    save_db(db)
    log.info("login id=%s name=%s", pid, rec.get("name"))
    return {"logged_in": True, "id": pid, "name": rec.get("name"),
            "ts": db["current_login"]["ts"]}


def get_login():
    """Current login with name resolved (None if logged-out person was deleted)."""
    db = load_db()
    login_rec = db.get("current_login")
    if not login_rec or not login_rec.get("id"):
        return None
    rec = db["persons"].get(login_rec["id"])
    if rec is None:
        return None
    return {"id": login_rec["id"], "name": rec.get("name"),
            "ts": login_rec.get("ts"), "distance": login_rec.get("distance")}


def clear():
    save_db({"version": 2, "persons": {}, "current_login": None})
    log.info("face db cleared")
    return {"cleared": True}


# ---- CLI (studio talks to it over SSH) ----
def _main():
    import argparse
    logging.basicConfig(level=logging.WARNING)
    ap = argparse.ArgumentParser(prog="face_db")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("list")
    p_del = sub.add_parser("delete")
    p_del.add_argument("key")
    p_ren = sub.add_parser("rename")
    p_ren.add_argument("key")
    p_ren.add_argument("--id", dest="new_id")
    p_ren.add_argument("--name", dest="new_name")
    p_log = sub.add_parser("login")
    p_log.add_argument("key", nargs="?")
    p_flg = sub.add_parser("facelogin")
    p_flg.add_argument("state", nargs="?", choices=["on", "off"])
    p_thr = sub.add_parser("threshold")
    p_thr.add_argument("value", nargs="?", type=float)
    sub.add_parser("clear")
    args = ap.parse_args()

    if args.cmd == "list":
        print(json.dumps({"persons": list_persons(),
                          "threshold": get_threshold(),
                          "face_login_enabled": get_face_login_enabled(),
                          "current_login": get_login()}, ensure_ascii=False))
    elif args.cmd == "delete":
        print(json.dumps(delete_person(args.key), ensure_ascii=False))
    elif args.cmd == "rename":
        print(json.dumps(rename(args.key, args.new_id, args.new_name), ensure_ascii=False))
    elif args.cmd == "login":
        print(json.dumps(login(args.key), ensure_ascii=False))
    elif args.cmd == "facelogin":
        if args.state is None:
            val = get_face_login_enabled()
        else:
            val = set_face_login_enabled(args.state == "on")
        print(json.dumps({"face_login_enabled": val}, ensure_ascii=False))
    elif args.cmd == "threshold":
        val = set_threshold(args.value) if args.value is not None else get_threshold()
        print(json.dumps({"threshold": val}, ensure_ascii=False))
    elif args.cmd == "clear":
        print(json.dumps(clear(), ensure_ascii=False))


if __name__ == "__main__":
    _main()
