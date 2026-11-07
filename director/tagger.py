"""Arc Tagger (C server, localhost:8090) over every Arc final of a clip -> ds/<clip>.tag.jsonl (time = Arc's emit time)."""
import json, os, sys, urllib.request
for clip in sys.argv[1:]:
    out = open(f"ds/{clip}.tag.jsonl", "w")
    src = f"ds/{clip}.arc.jsonl" if os.path.exists(f"ds/{clip}.arc.jsonl") else f"ds/{clip}.arc.jsonl.part"
    for l in open(src):
        try: r = json.loads(l)
        except ValueError: continue
        if r["k"] != "final" or not r["text"].strip():
            continue
        req = urllib.request.Request("http://127.0.0.1:8090/tag", data=json.dumps({"text": r["text"], "domain": "sports"}).encode())
        d = json.load(urllib.request.urlopen(req, timeout=30))
        ev = {}
        for e in d.get("events", []):
            k = e.get("type") or e.get("tag")
            ev[k] = max(ev.get(k, 0), e.get("score", e.get("p", 0)))
        spans = [s["type"] for s in d.get("spans", [])]
        utt = d.get("utterances", [])
        out.write(json.dumps({"t": r["t"], "start": r["start"], "end": r["end"], "events": ev,
                              "score_span": spans.count("entity.number.score"), "person": spans.count("entity.mention.person"),
                              "intent": sum((u.get("intent") or [] for u in utt), []), "state": [u.get("state") for u in utt]}) + "\n")
    print(clip, "tagged", flush=True)
