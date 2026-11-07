#!/usr/bin/env python3
"""Run before every deploy: replays a real Pi recording of Arc's records (eval/partials_w7.json, the NBA demo clip)
through tvwatch.py's whole record path (stitching, early alerts, rules, memory, recap) and checks the outcome."""
import json, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.argv = ["x"]
sys.path.insert(0, HERE)
import tvwatch as t


class A:
    domain, dry_run, ntfy, no_early, memory_min, llm_model = "nba", True, None, False, 30, "x"


t.ARGS = A
t.TELE["f"] = open(os.devnull, "w")   # tests don't write session files
_rules = t.load_rules
t.load_rules = lambda: _rules() + [{"id": "curry", "type": "name", "name": "Stephen Curry", "cooldown_s": 120}]
t.roster_forms = lambda: set()   # the clip is Warriors-Lakers, not tonight's Knicks-Spurs roster
updates = []
_pub = t.publish
t.publish = lambda kind, data: (updates.append(data) if kind == "alert_update" else None, _pub(kind, data))
arc = object()
t.CUR["arc"] = arc
t.MEMORY["ctx_written"] = 1e18   # don't write context.txt from a test
longest = 0
for rec in json.load(open(os.path.join(HERE, "eval", "partials_w7.json"))):
    t.handle(arc, rec)
    longest = max(longest, len(t.STATE["partial"].split()))
titles = [a["title"] for a in t.STATE["alerts"]]
checks = {
    "3 sentences": len(t.STATE["lines"]) == 3,
    "score 102-100": tuple(t.STATE["score"] or ()) == (102, 100),
    "clock 1:45": t.STATE["clock"] == 105,
    "Curry alert": any("Stephen Curry" in x for x in titles),
    "timeout alert": any("time out" in x.lower() for x in titles),
    "score alert": any(x.startswith("Score 102 – 98") for x in titles),
    "recap": t.catchup()["sentences"] == 3,
    "live line grows past one window": longest > 25,
    "early alerts cleaned by their final": len(updates) >= 2 and "DeV" not in json.dumps(updates),
}
bad = [k for k, ok in checks.items() if not ok]
print("replay:", "ok" if not bad else "FAILED " + ", ".join(bad), f"({len(titles)} alerts)")
if bad:
    sys.exit(1)


# a commercial break: the game, 80 s of ads, then the game again -> one "game is back" alert, and none before
fired = []
t.fire = lambda r, title, body, early=False: fired.append(r.get("id"))
clock = [1e9]
t.time.time = lambda: clock[0]
t.STATE.update(score=None, clock=None, last_game=clock[0])
t.roster_forms = lambda: set()   # the script is Warriors-Lakers, not tonight's roster: test the break logic alone
script = [("Stephen Curry hits the three, Warriors lead 88 to 85.", 0), ("Fifty percent off at Mattress Mart.", 40),
          ("Ask your doctor if it is right for you.", 40), ("And we're back. LeBron James brings it up.", 40),
          ("LeBron James with the layup.", 10)]
for text, dt in script:
    clock[0] += dt
    t.check_rules({"text": text, "tags": []})
ok = fired.count("back") == 1
print("break:", "ok" if ok else f"FAILED {fired}")

# a watchlist star who isn't in tonight's game must not pull Arc's decoder
t.roster_forms = lambda: {"jalen brunson", "brunson", "new york knicks", "knicks"}
bias = t.bias_phrases([{"type": "name", "name": "Stephen Curry"}, {"type": "name", "name": "Brunson"}],
                      [("Stephen Curry", ["Stephen Curry", "Curry"]), ("Jalen Brunson", ["Jalen Brunson", "Brunson"])])
roster_ok = "Curry" not in bias and "Stephen Curry" not in bias and "Brunson" in bias
print("roster:", "ok" if roster_ok else f"FAILED {bias}")
ok = ok and roster_ok

# the scoreboard on screen: the first reading sets the board, a jump of 3 is a three, credited to the player just heard
fired.clear()
t.fire = lambda r, title, body, early=False: fired.append(title)
t.roster_forms = lambda: set()
t.STATE.update(score=None, clock=None, clock_label=None)
t.MEMORY["lines"].append((clock[0], {"text": "Brunson pulls up from deep.", "tags": [{"tag": "ENTITY_PERSON", "text": "Brunson"}]}))
t.on_ocr({"score": [79, 83], "teams": ["NY", "SA"], "period": "4TH", "clock": "5:18"})
first = list(fired)
clock[0] += 5
t.on_ocr({"score": [82, 83], "teams": ["NY", "SA"], "period": "4TH", "clock": "4:58"})
board_ok = (not first and any(x.startswith("Three! Brunson · NY 82 – 83 SA") for x in fired)
            and t.STATE["clock_label"] == "4TH 4:58" and t.score_text() == "NY 82 – 83 SA")
f = t.facts()
board_ok = board_ok and f["points_by_player_heard"].get("Brunson", {}).get("points") == 3 and f["scoring_plays"][-1]["what"] == "Three"
# scoring heard in the commentary (no scoreboard): credited to the player named with it, misses not counted
t.HEARD.update(players={}, plays=[], last={})
for txt in ["Hart buries the three!", "Towns thought about a three, shot blocked by Wembanyama.", "Brunson drives and shoots. It's good."]:
    w = txt.split()
    t.heard_scoring(txt, [{"tag": "ENTITY_PERSON", "text": x.strip(".,!"), "wb": i, "we": i + 1} for i, x in enumerate(w) if x[0].isupper() and x.strip(".,!") not in ("It's",)])
heard = t.HEARD["players"]
board_ok = board_ok and heard.get("Hart", {}).get("heard_points") == 3 and "Towns" not in heard and heard.get("Brunson", {}).get("heard_points") == 2
print("board:", "ok" if board_ok else f"FAILED first={first} fired={fired} clock={t.STATE['clock_label']} {t.score_text()}")
ok = ok and board_ok
sys.exit(0 if ok else 1)
