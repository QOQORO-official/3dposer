#!/usr/bin/env python3
"""
Builds public/models/human.bin + human.json from MakeHuman's base mesh and targets.

MakeHuman's base mesh and targets are CC0 (relicensed in 2020; see
https://static.makehumancommunity.org/oldsite/faq/what_changed_regarding_the_license_in_2020.html).
The source files come from the `makehuman-data` npm package, which carries the older license
labels in its metadata. Only geometry and target data are used; no MakeHuman code.

Usage:
    npm pack makehuman-data@0.0.2 && tar xzf makehuman-data-0.0.2.tgz
    python3 scripts/build-human.py path/to/package public/models

Output (little endian), described by human.json:
    positions  float32 [n*3]   meters, feet on y=0, facing +z, A-pose
    indices    uint16  [t*3]
    skinIndex  uint8   [n*4]   indices into json.joints
    skinWeight uint8   [n*4]   /255
    per target: vertex uint16 [k], delta int16 [k*3] (units of 1e-4 m)
"""
import json
import os
import struct
import sys

import numpy as np

SRC = sys.argv[1] if len(sys.argv) > 1 else "package"
OUT = sys.argv[2] if len(sys.argv) > 2 else "public/models"

KEEP_MATERIALS = {"body", "helper-l-eye", "helper-r-eye"}
DM_TO_M = 0.1

# Our rig's joints (must match src/figure/rig.ts) and the MakeHuman joint whose head they sit on.
JOINTS = {
    "pelvis": "spine05",
    "spine": "spine03",
    "chest": "spine01",
    "neck": "neck01",
    "head": "head",
}
for s, S in (("l", "L"), ("r", "R")):
    JOINTS.update({
        f"clavicle_{s}": f"clavicle.{S}",
        f"upperarm_{s}": f"upperarm01.{S}",
        f"forearm_{s}": f"lowerarm01.{S}",
        f"hand_{s}": f"wrist.{S}",
        f"thigh_{s}": f"upperleg01.{S}",
        f"shin_{s}": f"lowerleg01.{S}",
        f"foot_{s}": f"foot.{S}",
    })
    for f, n in (("thumb", 1), ("index", 2), ("middle", 3), ("ring", 4), ("pinky", 5)):
        for i in (1, 2, 3):
            JOINTS[f"{f}{i}_{s}"] = f"finger{n}-{i}.{S}"

# Extra points used to orient end segments.
TIPS = {"head_top": "head____tail"}
for s, S in (("l", "L"), ("r", "R")):
    TIPS[f"toe_{s}"] = f"toe2-3.{S}____tail"
    TIPS[f"hand_mid_{s}"] = f"finger3-1.{S}____head"
    for f, n in (("thumb", 1), ("index", 2), ("middle", 3), ("ring", 4), ("pinky", 5)):
        TIPS[f"{f}_tip_{s}"] = f"finger{n}-3.{S}____tail"


def joint_for_bone(mh: str) -> str:
    """Which of our joints a MakeHuman bone's skin weights go to."""
    base = mh.split("____")[0]
    side = "l" if base.endswith(".L") else "r" if base.endswith(".R") else None
    name = base[:-2] if side else base
    if name in ("root", "spine05", "pelvis", "spine04"):
        return "pelvis"
    if name == "spine03" or name == "spine02":
        return "spine"
    if name in ("spine01", "breast"):
        return "chest"
    if name.startswith("neck"):
        return "neck"
    if side:
        if name in ("clavicle", "shoulder01"):
            return f"clavicle_{side}"
        if name.startswith("upperarm"):
            return f"upperarm_{side}"
        if name.startswith("lowerarm"):
            return f"forearm_{side}"
        if name == "wrist" or name.startswith("metacarpal"):
            return f"hand_{side}"
        if name.startswith("finger"):
            n, i = name[len("finger"):].split("-")
            f = ["thumb", "index", "middle", "ring", "pinky"][int(n) - 1]
            return f"{f}{i}_{side}"
        if name.startswith("upperleg"):
            return f"thigh_{side}"
        if name.startswith("lowerleg"):
            return f"shin_{side}"
        if name == "foot" or name.startswith("toe"):
            return f"foot_{side}"
    return "head"  # head, jaw, eyes, tongue and all facial bones


# Targets exposed by the app. Keys are the names the app uses.
TARGETS = {}
for g in ("female", "male"):
    for m in ("minmuscle", "averagemuscle", "maxmuscle"):
        for w in ("minweight", "averageweight", "maxweight"):
            TARGETS[f"universal-{g}-{m}-{w}"] = f"macrodetails/universal-{g}-young-{m}-{w}.target"
    for r in ("african", "asian", "caucasian"):
        TARGETS[f"race-{r}-{g}"] = f"macrodetails/{r}-{g}-young.target"
    TARGETS[f"proportions-{g}"] = f"macrodetails/proportions/{g}-young-averagemuscle-averageweight-idealproportions.target"
for cup in ("mincup", "maxcup"):
    TARGETS[f"breast-{cup}"] = f"breast/female-young-averagemuscle-averageweight-{cup}-averagefirmness.target"
for s in ("l", "r"):
    for part in ("upperarm", "lowerarm", "upperleg", "lowerleg"):
        for d in ("incr", "decr"):
            TARGETS[f"{s}-{part}-muscle-{d}"] = f"armslegs/{s}-{part}-muscle-{d}.target"
    for d in ("incr", "decr"):
        TARGETS[f"{s}-upperarm-shoulder-muscle-{d}"] = f"armslegs/{s}-upperarm-shoulder-muscle-{d}.target"
for d in ("incr", "decr"):
    TARGETS[f"torso-pectoral-{d}"] = f"torso/torso-muscle-pectoral-{d}.target"
    TARGETS[f"torso-dorsi-{d}"] = f"torso/torso-muscle-dorsi-{d}.target"
    TARGETS[f"torso-horiz-{d}"] = f"torso/torso-scale-horiz-{d}.target"
    TARGETS[f"stomach-tone-{d}"] = f"stomach/stomach-tone-{d}.target"
    TARGETS[f"stomach-pregnant-{d}"] = f"stomach/stomach-pregnant-{d}.target"
    TARGETS[f"buttocks-{d}"] = f"buttocks/buttocks-volume-{d}.target"
    TARGETS[f"hip-horiz-{d}"] = f"hip/hip-scale-horiz-{d}.target"
for a, b in (("less", "less"), ("more", "more")):
    TARGETS[f"torso-vshape-{a}"] = f"torso/torso-vshape-{b}.target"
    TARGETS[f"neck-horiz-{a}"] = f"neck/neck-scale-horiz-{b}.target"
for d in ("decrease", "increase"):
    TARGETS[f"shoulder-{d}"] = f"measure/measure-shoulder-{d}.target"


def parse_faces(faces, n_mats):
    out = []
    i = 0
    while i < len(faces):
        t = faces[i]
        i += 1
        n = 4 if t & 1 else 3
        verts = faces[i : i + n]
        i += n
        mat = None
        if t & 2:
            mat = faces[i]
            i += 1
        if t & 4:
            i += 1
        if t & 8:
            i += n
        if t & 16:
            i += 1
        if t & 32:
            i += n
        if t & 64:
            i += 1
        if t & 128:
            i += n
        out.append((verts, mat))
    return out


def main():
    model = json.load(open(os.path.join(SRC, "public/data/models/human_full_size.json")))
    meta = model["metadata"]
    mats = [m.get("DbgName") for m in model["materials"]]
    V = np.array(model["vertices"], dtype=np.float64).reshape(-1, 3)
    joints_idx = meta["joint_pos_idxs"]

    faces = parse_faces(model["faces"], len(mats))
    kept = [(v, m) for v, m in faces if mats[m] in KEEP_MATERIALS]
    used = sorted({i for v, _ in kept for i in v})

    def joint_pos(key):
        ids = joints_idx[key]
        return V[ids].mean(axis=0)

    # Joint groups reference helper-cube vertices; keep those too (not rendered).
    joint_keys = {j: f"{mh}____head" for j, mh in JOINTS.items()}
    helper_ids = sorted({i for k in list(joint_keys.values()) + list(TIPS.values()) for i in joints_idx[k]} - set(used))
    order = used + helper_ids
    remap = {old: new for new, old in enumerate(order)}
    n_render = len(used)
    n = len(order)
    assert n < 65536

    floor = V[used][:, 1].min()
    pos = (V[order] - np.array([0, floor, 0])) * DM_TO_M

    tris = []
    for v, _ in kept:
        r = [remap[i] for i in v]
        if len(r) == 4:
            tris += [r[0], r[1], r[2], r[0], r[2], r[3]]
        else:
            tris += r

    # Skin weights -> our joints, top 4.
    names = [b["name"] for b in model["bones"]]
    joint_names = list(JOINTS.keys())
    jindex = {j: i for i, j in enumerate(joint_names)}
    per = model["influencesPerVertex"]
    si = np.array(model["skinIndices"]).reshape(-1, per)
    sw = np.array(model["skinWeights"], dtype=np.float64).reshape(-1, per)
    skin_i = np.zeros((n, 4), dtype=np.uint8)
    skin_w = np.zeros((n, 4), dtype=np.uint8)
    for new, old in enumerate(order):
        acc = {}
        for b, w in zip(si[old], sw[old]):
            if w <= 0:
                continue
            j = jindex[joint_for_bone(names[b])]
            acc[j] = acc.get(j, 0.0) + w
        if not acc:
            acc = {jindex["head"] if pos[new][1] > 1.4 else jindex["pelvis"]: 1.0}
        top = sorted(acc.items(), key=lambda kv: -kv[1])[:4]
        total = sum(w for _, w in top)
        q = [int(round(255 * w / total)) for _, w in top]
        q[0] += 255 - sum(q)
        for k, ((j, _), w) in enumerate(zip(top, q)):
            skin_i[new, k] = j
            skin_w[new, k] = w

    groups = {j: [remap[i] for i in joints_idx[k]] for j, k in joint_keys.items()}
    groups.update({t: [remap[i] for i in joints_idx[k]] for t, k in TIPS.items()})

    # Targets: dense int16 rows in sorted path order, units 1e-3 dm = 1e-4 m.
    tlist = sorted(json.load(open(os.path.join(SRC, "src/json/targets/target-list.json")))["targets"].keys())
    row_of = {p.replace("data/targets/", ""): i for i, p in enumerate(tlist)}
    row_len = V.shape[0] * 3
    bin_path = os.path.join(SRC, "public/data/targets/targets.bin")
    assert os.path.getsize(bin_path) == len(tlist) * row_len * 2

    order_arr = np.array(order)
    chunks = []
    target_meta = []
    with open(bin_path, "rb") as fh:
        for name, path in TARGETS.items():
            fh.seek(row_of[path] * row_len * 2)
            row = np.frombuffer(fh.read(row_len * 2), dtype="<i2").reshape(-1, 3)[order_arr]
            nz = np.nonzero(np.abs(row).max(axis=1) > 1)[0]
            target_meta.append({"name": name, "count": int(len(nz))})
            chunks.append(nz.astype("<u2").tobytes() + row[nz].astype("<i2").tobytes())

    os.makedirs(OUT, exist_ok=True)
    blobs = [
        ("positions", pos.astype("<f4").tobytes()),
        ("indices", np.array(tris, dtype="<u2").tobytes()),
        ("skinIndex", skin_i.tobytes()),
        ("skinWeight", skin_w.tobytes()),
    ]
    offset = 0
    layout = {}
    with open(os.path.join(OUT, "human.bin"), "wb") as fo:
        for key, b in blobs:
            pad = (-offset) % 4
            fo.write(b"\0" * pad)
            offset += pad
            layout[key] = {"offset": offset, "bytes": len(b)}
            fo.write(b)
            offset += len(b)
        for t, b in zip(target_meta, chunks):
            pad = (-offset) % 4
            fo.write(b"\0" * pad)
            offset += pad
            t["offset"] = offset
            fo.write(b)
            offset += len(b)

    out = {
        "source": "MakeHuman 1.1 base mesh and targets (CC0 1.0)",
        "vertexCount": n,
        "renderVertexCount": n_render,
        "triangleCount": len(tris) // 3,
        "layout": layout,
        "joints": joint_names,
        "groups": groups,
        "targets": target_meta,
        "deltaScale": 1e-4,
    }
    json.dump(out, open(os.path.join(OUT, "human.json"), "w"), separators=(",", ":"))
    print(f"{n} verts ({n_render} rendered), {len(tris)//3} tris, {len(target_meta)} targets, {offset/1e6:.2f} MB")


if __name__ == "__main__":
    main()
