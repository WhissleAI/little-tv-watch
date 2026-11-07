"""Collect every clip's catalog entry (ocr/catalog/*.json) into the catalog the TV app reads
($TVW_MEDIA/catalog.json, served at /catalog/ next to the clips and posters)."""
import glob, json, os, subprocess
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.environ.get("TVW_MEDIA", "../media")
ORDER = ["nba", "soccer", "nfl", "nhl", "cricket"]
clips = []
for p in sorted(glob.glob(os.path.join(HERE, "catalog", "*.json"))):
    c = json.load(open(p))
    if not os.path.exists(os.path.join(OUT, c["file"])):
        continue   # not downloaded (or not yet)
    c["codec"] = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name", "-of", "csv=p=0",
                                 os.path.join(OUT, c["file"])], capture_output=True, text=True).stdout.strip()   # the TV plays h264
    c["poster"] = c["id"] + ".jpg" if os.path.exists(os.path.join(OUT, c["id"] + ".jpg")) else None
    clips.append({k: c.get(k) for k in ("id", "sport", "title", "subtitle", "file", "poster", "start", "duration", "layout",
                                        "broadcaster", "roster", "teams", "featured", "codec")})
clips.sort(key=lambda c: (not c.get("featured"), ORDER.index(c["sport"]) if c["sport"] in ORDER else 9, not c["id"].endswith("_main"), c["title"]))
json.dump({"clips": clips}, open(os.path.join(OUT, "catalog.json"), "w"), indent=1)
print(len(clips), "clips:", ", ".join(c["id"] for c in clips))
