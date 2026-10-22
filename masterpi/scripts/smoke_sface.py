#!/usr/bin/env python3
"""SFace smoke test: recognizer load + camera frame detect/embed/self-match + db ops.

Not part of the runtime; run manually on the Pi:
  cd ~/masterpi_client && python3 smoke_sface.py
"""

import json
import logging
import sys

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s %(message)s")

import face_db  # noqa: E402
import vision  # noqa: E402


def main():
    out = {}
    recog = vision.make_face_recognizer()
    out["recognizer_created"] = recog is not None
    if recog is None:
        print(json.dumps(out))
        return 1

    # db roundtrip (add a synthetic person then remove it)
    fake = [0.0] * 128
    fake[0] = 1.0
    face_db.enroll("__smoke__", [fake])
    persons = [p["name"] for p in face_db.list_persons()]
    m = face_db.match(fake)
    face_db.delete_person("__smoke__")
    out["db_roundtrip"] = {"enrolled_seen": "__smoke__" in persons,
                           "match": m, "gone_after_delete":
                           "__smoke__" not in [p["name"] for p in face_db.list_persons()]}

    # real camera embed (best effort: no face in view is also a valid result)
    src = vision.LocalSource("auto")
    if not src.ok:
        out["camera"] = "unavailable (busy?)"
    else:
        try:
            pairs = src.embed_frames(6)
            embeds = [e for (_b, e) in pairs if e]
            dims = {len(e) for e in embeds}
            selfdist = None
            if embeds:
                selfdist = round(face_db.cos_distance(embeds[0], embeds[0]), 6)
            out["camera"] = {"frames_with_face": len(pairs), "embeds": len(embeds),
                             "dims": sorted(dims), "self_distance": selfdist,
                             "match_first": face_db.match(embeds[0]) if embeds else None}
        finally:
            src.close()

    print(json.dumps(out, ensure_ascii=False))
    ok = out["recognizer_created"] and out["db_roundtrip"]["enrolled_seen"] \
        and out["db_roundtrip"]["gone_after_delete"]
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
