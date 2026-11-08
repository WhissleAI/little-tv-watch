#!/usr/bin/env python3
"""TV Watch: listens to the TV through Arc Mini (arc_tv) and pings your phone (ntfy) when your rules fire.

  python3 tvwatch.py --device plughw:1 --domain nba --ntfy tvwatch-abc123      # live, USB mic / sound card
  python3 tvwatch.py --file demo.wav --domain nba --dry-run                    # a clip at real-time speed, no push
  python3 tvwatch.py --list-devices

Web page on http://<pi>:8080 : live transcript, rules (add / delete), alerts. Standard library only.
Rules live in rules.json; watchlist names in names.txt ("Name|kind|alias1,alias2"), also given to Arc.
"""
import argparse
import difflib
import html
import json
import os
import queue
import re
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.request
import wave
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
LOCK = threading.Lock()
STATE = {"lines": deque(maxlen=60), "partial": "", "alerts": deque(maxlen=50), "score": None, "clock": None, "clock_label": None,
         "level": 0.0, "status": "starting"}
ARGS = None
SUBS = []   # one queue.Queue per connected phone (/api/events)
MEMORY = {"lines": deque(), "scores": deque(), "alerts": deque(), "ctx_written": 0.0}   # the last 30 minutes
KIND = {"ENTITY_PERSON": "person", "ENTITY_TEAM": "team", "ENTITY_PLACE": "place", "ENTITY_ORG": "organization"}


def publish(kind, data):
    """Server-sent event to every connected phone app."""
    msg = f"event: {kind}\ndata: {json.dumps(data)}\n\n".encode()
    with LOCK:
        for q in SUBS:
            q.put(msg)

# ---------------------------------------------------------------- numbers spoken on TV ("one hundred two")
UNITS = {w: i for i, w in enumerate("zero one two three four five six seven eight nine ten eleven twelve thirteen "
                                     "fourteen fifteen sixteen seventeen eighteen nineteen".split())}
UNITS.update(nil=0, nothing=0, love=0)
TENS = {w: 10 * i for i, w in enumerate("_ _ twenty thirty forty fifty sixty seventy eighty ninety".split()) if i > 1}


def words_to_int(ws):
    """['one','hundred','two'] -> 102; digits pass through; None when nothing numeric."""
    total, cur, seen = 0, 0, False
    for w in ws:
        w = w.lower().strip(".,!?'\"").replace("-", " ")
        for p in w.split():
            if p.isdigit():
                cur += int(p); seen = True
            elif p in UNITS:
                cur += UNITS[p]; seen = True
            elif p in TENS:
                cur += TENS[p]; seen = True
            elif p == "hundred":
                cur = max(cur, 1) * 100; seen = True
            elif p == "thousand":
                total += max(cur, 1) * 1000; cur = 0; seen = True
            elif p in ("and", "a"):
                continue
            elif seen:
                return total + cur
    return total + cur if seen else None


def parse_score(text):
    """'one hundred two to ninety eight' / '102-98' -> (102, 98)"""
    t = text.lower().replace("–", "-")
    m = re.search(r"(\d+)\s*(?:-|to)\s*(\d+)", t)
    if m:
        return int(m.group(1)), int(m.group(2))
    m = re.search(r"\b(\w+)\s+nil\b", t)
    if m and words_to_int([m.group(1)]) is not None:
        return words_to_int([m.group(1)]), 0
    parts = re.split(r"\s(?:to|-)\s", t, maxsplit=1)
    if len(parts) == 2:
        a, b = words_to_int(parts[0].split()), words_to_int(parts[1].split())
        if a is not None and b is not None:
            return a, b
    return None


NUMW = set(UNITS) | set(TENS) | {"hundred", "thousand"}


def isnum(w):
    return w.isdigit() or w in NUMW


ORD = {"first": 1, "second": 2, "third": 3, "fourth": 4, "fifth": 5, "sixth": 6, "seventh": 7, "eighth": 8,
       "ninth": 9, "tenth": 10, "eleventh": 11, "twelfth": 12, "thirteenth": 13, "fourteenth": 14, "fifteenth": 15,
       "sixteenth": 16, "seventeenth": 17, "eighteenth": 18, "nineteenth": 19, "twentieth": 20, "thirtieth": 30,
       "fortieth": 40, "fiftieth": 50, "sixtieth": 60, "seventieth": 70, "eightieth": 80, "ninetieth": 90}


def parse_match_minute(text):
    """'in the eighty seventh minute' / '87th minute' / "87'" -> 87; plain durations ('five minutes') are not minutes"""
    t = text.lower().replace("-", " ")
    m = re.search(r"\b(\d+)(?:st|nd|rd|th)\s+minute\b", t) or re.search(r"\b(\d+)'", t)
    if m:
        return int(m.group(1))
    m = re.search(r"(?:(\w+)\s+)?(\w+)\s+minute\b", t)
    if m and m.group(2) in ORD:
        return TENS.get(m.group(1) or "", 0) + ORD[m.group(2)]
    m = re.search(r"\b(?:in|into)\s+the\s+((?:\w+\s+){1,2}?)minutes?\b", t)   # "in the seventy eight minutes"
    if m:
        v = words_to_int(m.group(1).split())
        if v is not None and m.group(1).split()[0] in NUMW | {str(v)}:
            return v
    return None


def parse_clock(text):
    """'one minute forty five left' / '1:45' / 'forty seconds' / '2 minutes' -> seconds"""
    t = text.lower()
    m = re.search(r"(\d+):(\d\d)", t)
    if m:
        return int(m.group(1)) * 60 + int(m.group(2))
    ws = re.sub(r"[^a-z0-9 ]", " ", t.replace("-", " ")).split()
    mins = secs = None
    for i, w in enumerate(ws):
        if w in ("minute", "minutes", "second", "seconds"):
            j = i
            while j > 0 and isnum(ws[j - 1]):
                j -= 1
            v = words_to_int(ws[j:i]) if j < i else (1 if w == "minute" else None)
            if w.startswith("minute"):
                mins = v
                k = i + 1                       # "one minute forty five (left)"
                while k < len(ws) and isnum(ws[k]):
                    k += 1
                if k > i + 1 and (k == len(ws) or ws[k] not in ("second", "seconds")):
                    secs = words_to_int(ws[i + 1:k])
            elif v is not None:
                secs = v
    if mins is None and secs is None:
        return None
    return (mins or 0) * 60 + (secs or 0)


# ---------------------------------------------------------------- rules
def load_rules():
    p = os.path.join(HERE, "rules.json")
    if not os.path.exists(p):
        return []
    with open(p) as f:
        return json.load(f)


def save_rules(rules):
    with open(os.path.join(HERE, "rules.json"), "w") as f:
        json.dump(rules, f, indent=2)


def roster_path():
    return os.path.join(HERE, "rosters", f"{ARGS.domain}.txt")


def load_names(path=None):
    """the watchlist (names.txt, starred), or any names file in the same format (a roster)"""
    out = []
    p = path or os.path.join(HERE, "names.txt")
    if os.path.exists(p):
        for line in open(p):
            line = line.strip()
            if line and not line.startswith("#"):
                bits = line.split("|")
                aliases = [a.strip() for a in bits[2].split(",")] if len(bits) > 2 and bits[2] else []
                out.append((bits[0].strip(), [bits[0].strip()] + aliases))
    return out


LAST_FIRED = {}
COLLECT = None   # a list while rules run over a partial: hits are gathered, not sent
STRICT = False   # partials: exact words only (no near misses), the final still gets the fuzzy pass


EARLY_SENT = {}   # rule id -> (alert, when): fired from a partial; its sentence's final will clean the text up
AID = [0]


def fire(rule, title, body, early=False):
    if COLLECT is not None:
        COLLECT.append((rule, title, body))
        return
    now = time.time()
    key = rule.get("id", title)
    if now - LAST_FIRED.get(key, 0) < float(rule.get("cooldown_s", 60)):
        sent = None if early else EARLY_SENT.pop(key, None)   # later partials re-hit it: only the final cleans up
        if sent and now - sent[1] < 30:   # the final of an early alert: replace its partial text
            with LOCK:
                sent[0].update(title=title, body=body)
            publish("alert_update", {"aid": sent[0]["aid"], "title": title, "body": body})
        return
    LAST_FIRED[key] = now
    AID[0] += 1
    alert = {"aid": AID[0], "time": time.strftime("%H:%M:%S"), "title": title, "body": body,
             "priority": int(rule.get("priority", 4)), "clock": STATE.get("clock_label")}   # the game clock, not the wall
    if early:
        EARLY_SENT[key] = (alert, now)
    with LOCK:
        STATE["alerts"].appendleft(alert)
        MEMORY["alerts"].append((now, alert))
    if alert["priority"] >= 4 and rule.get("type") != "sound":
        LAST_BIG.update(alert=alert, t=now, boosted=False)
    publish("alert", alert)
    tele("alert", {"title": title, "body": body, "rule": rule.get("id"), "type": rule.get("type"), "priority": alert["priority"]})
    print(f"ALERT  {time.time():.2f} {title} — {body}", flush=True)
    if ARGS.dry_run or not ARGS.ntfy:
        return
    try:
        req = urllib.request.Request(f"{ARGS.ntfy_server}/{ARGS.ntfy}", data=body.encode(), method="POST",
                                     headers={"Title": title.encode("ascii", "ignore").decode() or "TV Watch",
                                              "Tags": "tv", "Priority": str(rule.get("priority", 4))})
        urllib.request.urlopen(req, timeout=5).read()
    except Exception as e:  # never let a push failure stop listening
        print(f"ntfy failed: {e}", file=sys.stderr)


LAST_BIG = {"alert": None, "t": 0, "boosted": False}   # the last important alert, for the crowd to confirm


def crowd(rule, label):
    """On broadcast audio the sound labels fire every few seconds (measured: horn / whistle 6-20 a minute), so a
    cheer never alerts on its own: it upgrades an important alert sent in the last `window_s` ("Goal! 🔥")."""
    a = LAST_BIG["alert"]
    if not a or LAST_BIG["boosted"] or time.time() - LAST_BIG["t"] > float(rule.get("window_s", 12)):
        return
    LAST_BIG["boosted"] = True
    with LOCK:
        a["title"] = a["title"] + " " + rule.get("mark", "🔥")
    publish("alert_update", {"aid": a["aid"], "title": a["title"], "body": a["body"]})
    print(f"CROWD  {label} confirms: {a['title']}", flush=True)


def snippet(text, needle=""):
    """the sentence of text that holds needle (an alert body, not the whole utterance)"""
    sents = re.split(r"(?<=[.!?])\s+", text)
    for x in sents:
        if needle and needle.lower().strip(" .,") in x.lower():
            return x
    return sents[-1] if len(text) > 160 else text


def fuzzy_has(text, phrase):
    """has_phrase, or a near miss for a long enough phrase: the recogniser's "couchdown" for touchdown, "Arsenel" """
    if has_phrase(text, phrase):
        return True
    if STRICT:
        return False
    p = re.sub(r"[^a-z0-9 ]", "", phrase.lower()).split()
    if sum(len(w) for w in p) < 6:
        return False
    ws = re.sub(r"[^a-z0-9 ]", " ", text.lower()).split()
    target = " ".join(p)
    return any(difflib.SequenceMatcher(None, " ".join(ws[i:i + len(p)]), target).ratio() >= FUZZY_MIN
               for i in range(len(ws) - len(p) + 1))


def has_phrase(text, phrase):
    return re.search(r"\b" + re.escape(phrase.lower()) + r"\b", text.lower()) is not None


SPORTS = {"nba", "nhl", "nfl", "cricket", "soccer", "esports"}
_W = "|".join(sorted(NUMW - {"nil", "nothing", "love"}, key=len, reverse=True))
_NW = r"(?:\d+|(?:%s)(?:(?:[ -]|\s+and\s+)(?:%s))*)" % (_W, _W)
SCORE_RE = re.compile(r"\b%s\s*(?:\bto\b|-)\s*%s\b|\b(?:%s)\s+nil\b" % (_NW, _NW, _W), re.I)
CRICKET_RE = re.compile(r"\b(%s)\s*(?:\bfor\b|/)\s*(%s)\b" % (_NW, _NW), re.I)   # runs for wickets: "142 for 6"
UNIT_AFTER = re.compile(r"^\W*(?:seconds?|secs?|minutes?|mins?|hours?|yards?|yard line|metres?|meters?|feet|foot|percent|years?|"
                        r"games?|wins?|losses|records?|times|overs?|balls?|days?|weeks?|points? per|rebounds|assists)\b", re.I)
SCORE_MAX = {"soccer": 15, "nhl": 15, "nfl": 80, "nba": 200, "esports": 60}   # a goal sport never reads "30-40"


def plausible_score(sc, after):
    """A score this sport can have, not a duration / distance / stat ("at least 30, 40 seconds", "the 20-yard line")."""
    if UNIT_AFTER.match(after):
        return False
    hi = SCORE_MAX.get(ARGS.domain, 400)
    if max(sc) > hi:
        return False
    prev = STATE["score"]
    if prev and time.time() - STATE.get("score_at", 0) < 20 * 60 and ARGS.domain != "cricket":
        # within a game a score only goes up; commentators say the leader first, so either order counts
        # ("102 to 98" after "102 to 100" is a misheard or replayed line, not the game going backwards)
        up = lambda a, b: a[0] >= b[0] and a[1] >= b[1]
        if not (up(sc, prev) or up(sc[::-1], prev)):
            return False
    return True


def score_text(s=None):
    s = STATE["score"] if s is None else s
    if not s:
        return None
    if ARGS.domain == "cricket":
        return f"{OCR['teams'][0]} {s[0]}/{s[1]}" if ocr_fresh() and OCR["teams"][0] else f"{s[0]}/{s[1]}"
    a, b = OCR["teams"] if ocr_fresh() else ("", "")
    return f"{a} {s[0]} – {s[1]} {b}".strip()


# ---------------------------------------------------------------- the scoreboard on screen (OCR in the TV app)
# The TV app reads the broadcast's score graphic about once a second and posts only stable readings. While it is
# readable it owns the score and the clock (commentators rarely say the score, and Arc mishears numbers), and a
# change on it is a real event, named by the sport and the size of the jump, with the scorer from what Arc just heard.
OCR = {"at": 0.0, "teams": ("", ""), "src": "", "history": []}   # history: every score the board went through
OCR_FRESH_S = 30
JUMPS = {"nba": {1: "Free throw", 2: "Basket", 3: "Three!"},
         "nfl": {6: "🏈 Touchdown!", 7: "🏈 Touchdown!", 8: "🏈 Touchdown!", 3: "Field goal", 1: "Extra point", 2: "Safety / two points"},
         "nhl": {1: "🚨 Goal!"}, "soccer": {1: "⚽ Goal!"}, "esports": {}}


def ocr_fresh():
    return time.time() - OCR["at"] < OCR_FRESH_S


def recent_person(within=15):
    """the player Arc heard last (a scorer is usually named right before the score changes)"""
    now = time.time()
    with LOCK:
        lines = [l for t, l in MEMORY["lines"] if 0 <= now - t < within]
    for line in reversed(lines):
        roster = roster_forms()   # with a roster, only its players can score ("Neither" was once tagged a person)
        people = [t["text"].strip(" .,!?") for t in line.get("tags", []) if t["tag"] == "ENTITY_PERSON"]
        people = [p for p in people if not roster or p.lower() in roster or any(w.lower() in roster for w in p.split())]
        if people:
            return people[-1], line["text"]
    return None, (lines[-1]["text"] if lines else "")


def on_ocr(b):
    tele("board", b)
    now = time.time()
    first = not ocr_fresh()
    OCR["at"] = now
    if b.get("teams"):   # clock-only readings (the clock ticks every second) keep the teams from the last score
        OCR["teams"] = tuple(b["teams"][:2])
    clock = " ".join(x for x in (b.get("period"), b.get("clock")) if x) or None
    if ARGS.domain == "cricket" and b.get("overs"):
        clock = f"{b['overs']} ov"
    changed = False
    if clock and clock != STATE["clock_label"]:
        STATE.update(clock_label=clock, clock=None, clock_at=now)
        changed = True
    sc = b.get("score")
    if sc and len(sc) == 2 and all(isinstance(x, int) and 0 <= x <= 999 for x in sc):
        sc = tuple(sc)
        prev = tuple(STATE["score"]) if STATE["score"] else None
        if sc != prev:
            changed = True
            rules = active_rules()
            if prev and not first and not b.get("correction") and all(x >= y for x, y in zip(sc, prev)):
                jump_alert(sc, prev)
                said = recent_person()[1]
                check_score([r for r in rules if r["type"] != "score_change"], {"text": ""}, sc, said or score_text(sc))
            else:   # the first reading, or a new game: no event, just the board
                STATE.update(score=sc, score_at=now)
                OCR["history"] = [sc]
    if changed:
        publish("state", {"score": STATE["score"], "score_text": score_text(), "clock": STATE["clock"],
                          "clock_label": STATE["clock_label"], "domain": ARGS.domain, "board": True})


def scoring_run(history, side):
    """(theirs, ours) points since the moment one side started pulling away: an NBA "9-0 run" is told as it builds.
    Only reported once it's a story (7+ points for the side that just scored, at most 2 for the other)."""
    if len(history) < 2:
        return None
    last = history[-1]
    for i in range(len(history) - 2, -1, -1):
        us, them = last[side] - history[i][side], last[1 - side] - history[i][1 - side]
        if them > 2:
            break
        best = (us, them)
    return best if best[0] >= 7 and best[1] <= 2 else None


# What the game has been, for questions ("how many does Brunson have?", "when did they tie it?"): built from the
# scoreboard's changes, credited to the player Arc heard just before each one (a guess from the commentary, marked so).
GAME = {"players": {}, "ties": 0, "lead_changes": 0, "max_lead": [0, 0], "runs": [], "plays": []}


def game_play(sc, prev, side, what, who):
    d = sc[side] - prev[side]
    if who and ARGS.domain != "cricket":
        p = GAME["players"].setdefault(who.split()[-1].title(), {"points": 0, "plays": 0})
        p["points"] += d
        p["plays"] += 1
    if sc[0] == sc[1]:
        GAME["ties"] += 1
    if (prev[0] - prev[1]) * (sc[0] - sc[1]) < 0:
        GAME["lead_changes"] += 1
    for i in (0, 1):
        GAME["max_lead"][i] = max(GAME["max_lead"][i], sc[i] - sc[1 - i])
    GAME["plays"].append({"clock": STATE.get("clock_label"), "score": score_text(sc), "what": what.strip("!🏈🚨⚽☝️🏏 "),
                          "by": who, "team": OCR["teams"][side] or ("home", "away")[side]})


# Scoring heard in the commentary, for when no scoreboard can be read (YouTube, a TV heard through the mic): a scoring
# phrase tied to the player Arc tags in the same clause (or the one before). Estimates, and labelled as such.
HEARD_PLAYS = {
    "nba": [(r"\b(three|3-pointer|three-pointer|triple|from deep|from downtown|from way downtown)\b", 3, "three"),
            (r"\b(free throws?|from the line|at the line)\b.*\b(good|makes?|hits?|both|knocks? down)\b", 1, "free throw"),
            (r"\b(lays? it (in|up)|layup|dunks?|slams?|jams?|finish(es)?|scores?|bucket|jumper|floater|hook shot|tip(s)? it in|puts it (in|home)|banks? it in|and one|backs? it home|knocks? (it )?down|hits?|buries|drains?|nails?|sinks?|it'?s good|is good|counts|gets it to go|goes down)\b", 2, "basket")],
    "soccer": [(r"\b(goal|scores?|finds the (net|corner)|into the net|back of the net|slots? (it )?(home|in)|heads? (it )?in|nets?)\b", 1, "goal")],
    "nhl": [(r"\b(goal|scores?|lights the lamp|puts it (in|home)|finds the net|buries it|backhand(er)? in|snipes?)\b", 1, "goal")],
    "nfl": [(r"\btouchdown\b", 6, "touchdown"), (r"\bfield goal\b.*\b(good|is good|through)\b|\bkick is good\b", 3, "field goal")],
    "cricket": [(r"\b(six|over the rope|into the stands)\b", 6, "six"), (r"\b(four|boundary)\b", 4, "four")],
}
NOT_SCORED = re.compile(r"\b(miss(es|ed)?|no good|off the (rim|front|back|iron|post|bar)|blocked|saved?|wide|short|can'?t get it|won'?t go|doesn'?t go|rims? out|denied)\b", re.I)
HEARD = {"players": {}, "plays": [], "last": {}}


def heard_scoring(text, tags):
    pats = HEARD_PLAYS.get(ARGS.domain)
    if not pats or not text:
        return
    roster = roster_forms()
    people = [(t["text"].strip(" .,!?"), t.get("wb", 0)) for t in tags if t["tag"] == "ENTITY_PERSON"]
    people = [(p, wb) for p, wb in people if p and (not roster or p.lower() in roster or any(w.lower() in roster for w in p.split()))]
    if not people:
        return
    words = text.split()
    clauses, start = [], 0   # word ranges of the clauses ("Brunson drives, kicks it to Hart, and he buries the three")
    for i, w in enumerate(words):
        if re.search(r"[.!?;]$", w) or i == len(words) - 1:
            clauses.append((start, i + 1))
            start = i + 1
    now = time.time()
    for ci, (a, b) in enumerate(clauses):
        clause = " ".join(words[a:b])
        if NOT_SCORED.search(clause):
            continue
        for pat, pts, what in pats:
            if re.search(pat, clause, re.I):
                inside = [p for p, wb in people if a <= wb < b]
                before = [p for p, wb in people if (clauses[ci - 1][0] if ci else a) <= wb < a]
                who = (inside or before or [None])[-1]
                if who:
                    key = who.split()[-1].title()
                    if now - HEARD["last"].get(key, 0) > 8:   # the commentator says it twice: one score
                        HEARD["last"][key] = now
                        p = HEARD["players"].setdefault(key, {"heard_scores": 0, "heard_points": 0})
                        p["heard_scores"] += 1
                        p["heard_points"] += pts
                        HEARD["plays"].append({"clock": STATE.get("clock_label"), "what": what, "by": key, "said": clause[:120]})
                        tele("heard_score", {"by": key, "what": what, "pts": pts})
                break


def facts():
    """everything TV Watch knows about this game, for an answer: grounded, small, with where each part came from"""
    a, b = OCR["teams"] if ocr_fresh() else ("", "")
    return {"sport": SPORT_NAMES.get(ARGS.domain, ARGS.domain), "teams": [a, b], "score": score_text(), "clock": STATE.get("clock_label"),
            "score_source": "the broadcast's scoreboard" if ocr_fresh() else "the commentary",
            "scoring_plays": GAME["plays"][-25:],
            "points_by_player_heard": dict(sorted(GAME["players"].items(), key=lambda kv: -kv[1]["points"])),
            "note": "points_by_player credits each scoreboard change to the player named in the commentary just before it: a guess",
            "ties": GAME["ties"], "lead_changes": GAME["lead_changes"],
            "biggest_lead": {a or "home": GAME["max_lead"][0], b or "away": GAME["max_lead"][1]},
            "most_talked_about": [{"name": n, "mentions": c} for n, k, c in top_mentions(8)],
            "recent_commentary": " ".join(l["text"] for l in list(STATE["lines"])[:10][::-1])[-2500:],
            "watching": [r["name"] for r in active_rules() if r["type"] == "name"],
            "scoring_heard_in_commentary": dict(sorted(HEARD["players"].items(), key=lambda kv: -kv[1]["heard_points"])),
            "scoring_plays_heard": HEARD["plays"][-20:],
            "heard_note": "scoring_heard_in_commentary counts scoring plays the commentators described, credited to the player "
                          "named with them: an estimate from what was heard, useful when the scoreboard can't be read"}


def ask_audio(pcm):
    """a viewer's spoken question, heard by Arc on its own (domain assistant): the words and what they want"""
    cmd = [ARGS.arc or os.path.join(HERE, "arc_tv"), ARGS.model, "--domain", "assistant", "--threads", "2", "--partial-ms", "-1",
           "--names", write_arc_names()]
    try:
        out = subprocess.run(cmd, input=pcm + b"\0" * 16000, capture_output=True, timeout=20).stdout.decode(errors="ignore")
    except (OSError, subprocess.TimeoutExpired):
        return {"text": "", "error": "arc"}
    finals = [json.loads(l) for l in out.splitlines() if l.startswith('{"k":"final"')]
    text = " ".join(f["text"] for f in finals).strip()
    tele("ask", {"text": text, "intent": [f.get("intent") for f in finals]})
    return {"text": text, "intent": next((f.get("intent") for f in finals if f.get("intent")), None),
            "tags": [t for f in finals for t in f.get("tags", [])]}


CLIPS = os.environ.get("TVW_CLIPS", "media")
REELS = os.environ.get("TVW_REELS", "reels")


FONTS = os.environ.get("TVW_FONTS", "fonts")


def reel_plate(title, clock, n, total, path):
    """a 1920x1080 overlay for one moment: REPLAY tag, what happened, the clock, and who made the reel"""
    from PIL import Image, ImageDraw, ImageFont
    font = lambda name, size: ImageFont.truetype(os.path.join(FONTS, name), size)
    im = Image.new("RGBA", (1920, 1080), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    what, _, rest = title.partition(" · ")
    big, small = font("Sora-Bold.ttf", 60), font("Atkinson-Regular.ttf", 36)
    w = max(d.textlength(what, font=big), d.textlength(rest, font=small) + 40) + 120
    y = 170 if ARGS.domain in ("nba", "nfl", "cricket") else 820   # clear of the broadcast's own scoreboard
    d.rounded_rectangle((60, y, 60 + w, y + 200), 22, fill=(10, 14, 26, 235))
    d.rounded_rectangle((60, y, 72, y + 200), 6, fill=(245, 197, 66, 255))
    d.rounded_rectangle((100, y - 50, 330, y + 10), 12, fill=(245, 197, 66, 255))
    d.text((122, y - 42), "REPLAY", font=font("Sora-Bold.ttf", 34), fill=(17, 17, 17, 255))
    meta = f"{n} / {total}" + (f"  ·  {clock}" if clock else "")
    d.rounded_rectangle((342, y - 50, 342 + d.textlength(meta, font=small) + 36, y + 10), 12, fill=(10, 14, 26, 220))
    d.text((360, y - 42), meta, font=small, fill=(255, 255, 255, 235))
    d.text((100, y + 25), what, font=big, fill=(255, 255, 255, 255))
    d.text((100, y + 120), rest, font=small, fill=(201, 207, 221, 255))
    tag = "TV Watch  ·  Arc on Little"
    tf = font("Atkinson-Bold.ttf", 28)
    tw = d.textlength(tag, font=tf)
    d.rounded_rectangle((1860 - tw - 36, 50, 1860, 104), 14, fill=(10, 14, 26, 200))
    d.text((1860 - tw - 18, 60), tag, font=tf, fill=(255, 255, 255, 235))
    im.save(path)


def cut_reel(src, segments):
    """the TV app's highlight reel as a file to share: each moment's few seconds with its card on top, joined"""
    path = os.path.join(CLIPS, os.path.basename(str(src)))
    if not os.path.exists(path) or not segments:
        return
    os.makedirs(os.path.join(REELS, "plates"), exist_ok=True)
    stamp = time.strftime("%H%M%S")
    out = os.path.join(REELS, f"reel_{ARGS.domain}_{stamp}.mp4")
    segs = segments[:8]
    inputs, graph, parts = [], [], []
    for i, seg in enumerate(segs):
        a, b, title = seg[:3]
        inputs += ["-ss", f"{float(a):.2f}", "-t", f"{float(b) - float(a):.2f}", "-i", path]
    for i, seg in enumerate(segs):
        plate = os.path.join(REELS, "plates", f"{stamp}_{i}.png")
        reel_plate(seg[2], seg[3] if len(seg) > 3 else "", i + 1, len(segs), plate)
        inputs += ["-i", plate]
        k = len(segs) + i
        graph.append(f"[{i}:v]scale=1920:1080,setsar=1,fps=30[s{i}];[s{i}][{k}:v]overlay=0:0[o{i}]")
        parts.append(f"[o{i}][{i}:a]")
    graph.append("".join(parts) + f"concat=n={len(segs)}:v=1:a=1[v][a]")
    cmd = ["taskpolicy", "-b", "nice", "-n", "15", "ffmpeg", "-v", "error", "-y", *inputs, "-filter_complex", ";".join(graph),
           "-map", "[v]", "-map", "[a]", "-c:v", "libx264", "-crf", "17", "-preset", "veryfast", "-pix_fmt", "yuv420p",
           "-c:a", "aac", "-b:a", "192k", out]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode == 0:
        print(f"reel   {out} ({len(segs)} moments)", flush=True)
        tele("reel", {"file": out, "segments": segs})
        publish("reel", {"file": os.path.basename(out), "moments": len(segs)})
    else:
        print(f"reel   failed: {r.stderr[-300:]}", flush=True)


# ---------------------------------------------------------------- YouTube search (the official Data API, no downloads)
def yt_key():
    if os.environ.get("YOUTUBE_API_KEY"):
        return os.environ["YOUTUBE_API_KEY"]
    env = os.environ.get("TVW_ENV_FILE", ".env")
    for line in open(env) if os.path.exists(env) else []:
        if line.startswith("YOUTUBE_API_KEY="):
            return line.split("=", 1)[1].strip().strip('"')
    return None


SPORT_WORDS = [("nba", r"\bnba\b|basketball|lakers|warriors|celtics|knicks|spurs|nuggets|bucks|thunder"),
               ("nfl", r"\bnfl\b|football|chiefs|eagles|cowboys|bills|ravens|49ers|touchdown"),
               ("nhl", r"\bnhl\b|hockey|oilers|bruins|panthers|rangers|maple leafs"),
               ("cricket", r"cricket|\bipl\b|\bt20\b|\bodi\b|test match|ashes|wicket"),
               ("soccer", r"premier league|la liga|serie a|bundesliga|champions league|\bfc\b|soccer|football club|arsenal|liverpool|madrid|barcelona|chelsea|man utd|manchester")]


def guess_sport(text):
    t = text.lower()
    for sport, pat in SPORT_WORDS:
        if re.search(pat, t):
            return sport
    return None


BAD_YT = set()   # ids the player refused (embedding off, removed, private): never shown again this run


def iso_seconds(d):
    m = re.fullmatch(r"P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?", d or "")
    return sum(int(x or 0) * k for x, k in zip(m.groups(), (86400, 3600, 60, 1))) if m else 0


def playable(v):
    """a video our embedded player can actually play here: public, processed, embeddable, not age-restricted, not
    blocked in the US, not an upcoming premiere, at least a minute long (or live now)"""
    st, cd, sn = v.get("status", {}), v.get("contentDetails", {}), v.get("snippet", {})
    region = cd.get("regionRestriction", {})
    live = sn.get("liveBroadcastContent") == "live"
    return (st.get("embeddable") and st.get("privacyStatus") == "public" and st.get("uploadStatus") == "processed"
            and cd.get("contentRating", {}).get("ytRating") != "ytAgeRestricted"
            and "US" not in region.get("blocked", []) and ("allowed" not in region or "US" in region["allowed"])
            and sn.get("liveBroadcastContent") != "upcoming" and (live or iso_seconds(cd.get("duration")) >= 60)
            and v.get("id") not in BAD_YT)


def yt_search(q, live=False):
    """games on YouTube for a query that will play in TV Watch: id, title, channel, thumbnail, live, and the sport"""
    key = yt_key()
    if not key:
        return {"error": "no YouTube API key"}
    params = {"part": "snippet", "type": "video", "maxResults": "50", "q": q, "key": key, "videoEmbeddable": "true",
              "videoSyndicated": "true", "safeSearch": "moderate", "relevanceLanguage": "en", "regionCode": "US"}
    if live:
        params["eventType"] = "live"
    try:
        hits = json.loads(urllib.request.urlopen("https://www.googleapis.com/youtube/v3/search?" + urllib.parse.urlencode(params),
                                                 timeout=8).read()).get("items", [])
        ids = [h["id"]["videoId"] for h in hits if h.get("id", {}).get("videoId") and h["id"]["videoId"] not in BAD_YT]
        vids = json.loads(urllib.request.urlopen("https://www.googleapis.com/youtube/v3/videos?" + urllib.parse.urlencode(
            {"part": "status,contentDetails,snippet", "id": ",".join(ids), "key": key}), timeout=8).read()).get("items", []) if ids else []
    except (OSError, ValueError) as e:
        return {"error": str(e)[:200]}
    by_id = {v["id"]: v for v in vids}
    out = []
    for vid in ids:   # search order is relevance order
        v = by_id.get(vid)
        if not v or not playable(v):
            continue
        sn = v["snippet"]
        title = html.unescape(sn.get("title", ""))
        out.append({"id": vid, "title": title, "channel": sn.get("channelTitle", ""),
                    "thumb": (sn.get("thumbnails", {}).get("high") or sn.get("thumbnails", {}).get("medium") or {}).get("url"),
                    "live": sn.get("liveBroadcastContent") == "live", "sport": guess_sport(title + " " + q),
                    "duration": iso_seconds(v.get("contentDetails", {}).get("duration"))})
        if len(out) >= 16:
            break
    tele("yt_search", {"q": q, "found": len(ids), "playable": len(out)})
    return {"q": q, "results": out}


def jump_alert(sc, prev):
    who, said = recent_person()
    side = 0 if sc[0] != prev[0] else 1
    team = OCR["teams"][side] or ("" if ARGS.domain == "cricket" else ("home", "away")[side])
    if ARGS.domain == "cricket":   # (runs, wickets)
        runs, wkts = sc[0] - prev[0], sc[1] - prev[1]
        what = "☝️ Wicket!" if wkts else {4: "🏏 FOUR", 6: "🏏 SIX!"}.get(runs)
        if not what:
            return
        title = f"{what} {team} {sc[0]}/{sc[1]}".strip()
    else:
        d = sc[side] - prev[side]
        what = JUMPS.get(ARGS.domain, {}).get(d) or f"+{d}"
        a, b = OCR["teams"]
        board = f"{a} {sc[0]} – {sc[1]} {b}".strip()
        title = f"{what}{' ' + who if who else ''} · {board}"   # the board shows which side moved
        if sc[0] == sc[1]:
            title += " · tied!"
        elif (prev[0] - prev[1]) * (sc[0] - sc[1]) < 0:
            title += " · lead change!"
    game_play(sc, prev, side, what, who)
    OCR["history"].append(sc)
    run = scoring_run(OCR["history"], side)
    told = OCR.setdefault("run_said", {})   # (not `said`: that's the commentary line the alert carries)
    if not run:
        told.pop(side, None)
    elif ARGS.domain in ("nba", "nfl") and run[0] >= told.get(side, 0) + (3 if side in told else 0):
        told[side] = run[0]   # told at 7, then again only as it grows (10, 13...): not on every point
        title += f" · {team} on a {run[0]}–{run[1]} run"
    print(f"board  {prev} -> {sc}", flush=True)
    fire({"id": f"board{time.time()}", "cooldown_s": 0, "priority": 5, "type": "board"}, title,
         snippet(said) if said else "from the scoreboard")


CLOCK_RE = re.compile(r"((?:\S+\s+){1,6}?)(?:left|remaining|to play|two play|to go|on the clock)\b", re.I)
FUZZY_MIN = 0.8   # a misheard keyword / name still counts ("couchdown" ~ touchdown)


def check_score(rules, t, s, text):
    prev = STATE["score"]
    STATE["score"] = s
    STATE["score_at"] = time.time()
    if s != prev:
        MEMORY["scores"].append((time.time(), list(s), snippet(text, t["text"])))
    for r in rules:
        if r["type"] == "score_change" and s != prev:
            fire(r, f"Score {score_text(s)}", snippet(text, t["text"]))
        if r["type"] == "lead_change" and prev and (prev[0] - prev[1]) * (s[0] - s[1]) < 0:
            fire(r, f"Lead change! {s[0]}-{s[1]}", snippet(text, t["text"]))
        if r["type"] == "close_game" and abs(s[0] - s[1]) <= int(r.get("margin", 3)):
            fire(r, f"Close game: {s[0]}-{s[1]}", snippet(text, t["text"]))


def mark_watch(text, tags):
    """flag tags that are one of the watchlist's names (or aliases): the app stars them"""
    names = sport_names()
    for t in tags:
        span = t["text"].strip(" .,!?").lower()
        t["watch"] = next((c for c, forms in names if any(span == f.lower() or f.lower() in span for f in forms)), None)
    return tags


def bias_phrases(rules, names):
    """phrases to pull Arc's decoder towards: every watchlist form, and the words the sport's rules listen for"""
    out = []
    for canon, forms in names:
        if in_game(forms):
            out += forms
    for r in rules:
        out += r.get("words", [])
        if r["type"] == "name" and r.get("name") and in_game([r["name"]]):
            out.append(r["name"])
    seen, uniq = set(), []
    for p in out:
        if p.lower() not in seen and len(p) > 2:
            seen.add(p.lower())
            uniq.append(p)
    return uniq


def other_rosters():
    """names on the other sports' rosters (lower case): a hockey player on the watchlist must not pull Arc's decoder
    during cricket (it hallucinated "Kyle Keller" x6), so the watchlist is scoped by the rosters"""
    out = set()
    d = os.path.join(HERE, "rosters")
    for fn in os.listdir(d) if os.path.isdir(d) else []:
        if fn.endswith(".txt") and fn != f"{ARGS.domain}.txt":
            out |= {c.lower() for c, _ in load_names(os.path.join(d, fn))}
    return out - {c.lower() for c, _ in load_names(roster_path())}


def roster_forms():
    """every form (name and aliases, lower case) on tonight's roster for this sport; empty when there is no roster"""
    return {x.lower() for c, f in load_names(roster_path()) for x in [c] + f}


def in_game(forms):
    """with a roster, only its people are in this game: a watchlist star from another team must not pull Arc's
    decoder (the Warriors' Curry, starred for an old demo, turned "crowd's back" into "Curry's back" in Knicks-Spurs)"""
    roster = roster_forms()
    return not roster or any(x.lower() in roster for x in forms)


def sport_names():
    """the watchlist names Arc may hear in this game"""
    other = other_rosters()
    return [(c, f) for c, f in load_names() if c.lower() not in other and in_game([c] + f)]


def write_arc_names():
    """Arc's names list: the watchlist plus the game's roster (rosters/<sport>.txt: teams, players, coaches, venue),
    so it spells the people on screen right; only the watchlist is starred and alerted"""
    path = os.path.join(HERE, "arc_names.txt")
    lines, seen = [], set()
    other = other_rosters()
    for p in (os.path.join(HERE, "names.txt"), roster_path()):
        for line in open(p) if os.path.exists(p) else []:
            k = line.split("|")[0].strip().lower()
            forms = [k] + [a for a in (line.split("|")[2].split(",") if line.count("|") >= 2 else []) if a.strip()]
            if p.endswith("names.txt") and not in_game([x.strip() for x in forms]):
                continue
            if k and not k.startswith("#") and k not in seen and k not in other:
                seen.add(k); lines.append(line.rstrip("\n"))
    with open(path, "w") as f:
        f.write("\n".join(lines) + "\n")
    return path


def write_bias():
    path = os.path.join(HERE, "bias.txt")
    with open(path, "w") as f:
        f.write("\n".join(bias_phrases(active_rules(), sport_names())) + "\n")
    return path


def active_rules():
    """rules for the sport being watched (a rule without "sports" applies to every sport)"""
    return [r for r in load_rules() if not r.get("sports") or ARGS.domain in r["sports"]]


def looping(text):
    """Arc hallucinating under noise repeats itself ("we've got a lot of time out in the middle" x3): a sentence
    whose most common three-word phrase comes 3+ times is not trusted for alerts"""
    w = [_norm(x) for x in text.split()]
    grams = [tuple(w[i:i + 3]) for i in range(len(w) - 2)]
    return bool(grams) and max(grams.count(g) for g in set(grams)) >= 3


def check_rules(rec):
    text = rec["text"]
    if looping(text):
        print(f"skip   a looping sentence: {text[:80]}", flush=True)
        return
    tags = rec.get("tags", [])
    rules = active_rules()
    names = sport_names()
    score_before, clock_before = STATE["score"], STATE["clock"]
    mm = parse_match_minute(text) if ARGS.domain == "soccer" else None
    if mm and 0 < mm <= 130 and not ocr_fresh():
        STATE["clock"] = None
        STATE["clock_label"] = f"{mm}'"
        STATE["clock_at"] = time.time()
        for r in rules:
            if r["type"] == "clock_under" and mm >= 85:
                fire(r, f"Final minutes: {mm}'", snippet(text, "minute"))
    if ARGS.domain in SPORTS and not ocr_fresh():   # scores (the scoreboard on screen wins while it is readable): from the text ("one hundred and one to ninety nine"),
        if ARGS.domain == "cricket":   # cricket's score is runs for wickets ("142 for 6"), never "a to b"
            for m in CRICKET_RE.finditer(text):
                r_, w_ = (int(g) if g.isdigit() else words_to_int(g.lower().replace("-", " ").split()) for g in m.groups())
                if r_ is not None and w_ is not None and w_ <= 10 and r_ <= 600 and not UNIT_AFTER.match(text[m.end():]):
                    check_score(rules, {"text": m.group(0)}, (r_, w_), text)
        else:
            found = [(m.group(0), text[m.end():]) for m in SCORE_RE.finditer(text)]   # else Arc's score tag ("88-25")
            found = found or [(t["text"], "") for t in tags if t["tag"] == "NUMBER_SCORE"]
            for f, after in found:
                sc = parse_score(f)
                if sc and plausible_score(sc, after):
                    check_score(rules, {"text": f}, sc, text)
    if ARGS.domain in ("nba", "nfl", "nhl") and not ocr_fresh():   # a game clock: Arc's clock tags, or "... left / remaining / to play"
        spans = [t["text"] for t in tags if t["tag"] == "NUMBER_CLOCK"]
        spans += [re.split(r"[.,;!?]", m.group(1))[-1] for m in CLOCK_RE.finditer(text)]
        for span in spans:
            c = parse_clock(span)
            if c is not None and 0 < c <= 20 * 60:
                STATE["clock_label"] = f"{c // 60}:{c % 60:02d}"
                STATE["clock"] = c
                STATE["clock_at"] = time.time()
                for r in rules:
                    if r["type"] == "clock_under" and c <= int(r.get("seconds", 120)):
                        fire(r, f"Crunch time: {c // 60}:{c % 60:02d} left", snippet(text, span.strip()))
                break
    if not STRICT:   # a finished sentence: is the game on? (a watchlist name, a score or a clock: ads rarely say those)
        game = (STATE["score"] != score_before or STATE["clock"] != clock_before or
                any(t.get("watch") for t in tags) or any(fuzzy_has(text, f) for _, fs in names for f in fs))
        now = time.time()
        if game:
            gap = now - STATE.get("last_game", now)
            for r in rules:
                if r["type"] == "game_back" and gap >= float(r.get("after_s", 90)):
                    fire(r, r.get("title") or "▶️ The game is back on", snippet(text))
            STATE["last_game"] = now
    for r in rules:
        if r["type"] == "name":   # a watchlist name (its aliases too), or any name typed in the rule
            want = r.get("name", "").strip().lower()
            cands = ([(c, f) for c, f in names if want in [x.lower() for x in f]]
                     or [(c, f) for c, f in load_names(roster_path()) if want in [x.lower() for x in [c] + f]]   # "Brunson" -> Jalen Brunson
                     or [(r.get("name", ""), [r.get("name", "")])])
            for canon, forms in cands:
                if want and any(fuzzy_has(text, f) for f in forms if f):
                    fire(r, f"{canon} is on TV", snippet(text, next((f for f in forms if has_phrase(text, f)), "")))
                    break
        elif r["type"] == "keyword":
            hit = [k for k in r.get("words", []) if fuzzy_has(text, k)]
            if hit:
                fire(r, r.get("title") or f"Heard: {', '.join(hit)}", snippet(text, hit[0]))
        elif r["type"] == "entity":   # any person / team / place Arc tags (e.g. every team mentioned)
            hit = [t["text"].strip(" .,") for t in tags if t["tag"] == r.get("tag", "ENTITY_PERSON")]
            if hit:
                fire(r, f"{r.get('label', 'Mentioned')}: {', '.join(hit)}", text)


# ---------------------------------------------------------------- Arc's own heads, frame by frame
# Arc's trunk reads the broadcast every 100 ms: sports events ("ev_rec:event.sports.score.recent": a score just
# happened, whatever words were used), game state, affect, speaker roles and sounds. A label is "on" once it holds
# above its threshold for `hold` frames; it re-arms after falling below 60 % of it. Every edge is logged (labels.log)
# so the thresholds keep being calibrated; rules of type "arc_label" turn chosen edges into alerts.
LABEL_ON = {}      # label -> [frames above, on?]
LABEL_LOG = None


def label_thr(r, label):
    t = r.get("thr", 0.5)
    if isinstance(t, dict):
        t = t.get(ARGS.domain, t.get(label, t.get("default", 0.5)))
    return t


SPEECH = deque(maxlen=15)   # Arc's speech probability, its last ~3 s of frames


def speech_level():
    return sum(SPEECH) / len(SPEECH) if SPEECH else 1.0


def arc_frame(rec):
    global LABEL_LOG
    SPEECH.append(rec.get("sp", 1.0))
    rules = [r for r in active_rules() if r["type"] == "arc_label"]
    watched = {l: r for r in rules for l in r.get("labels", [])}
    for label, p in rec["p"].items():
        r = watched.get(label)
        thr = label_thr(r, label) if r else LOG_THR.get(label, 0.6)
        st = LABEL_ON.setdefault(label, [0, False])
        if p >= thr:
            st[0] += 1
        else:
            st[0] = 0
            if st[1] and p < thr * 0.6:
                st[1] = False
        hold = r.get("hold", 3) if r else 3
        if st[0] >= hold and not st[1]:
            st[1] = True
            if LABEL_LOG is None:
                LABEL_LOG = open(os.path.join(HERE, "labels.log"), "a")
            LABEL_LOG.write(json.dumps({"t": time.time(), "domain": ARGS.domain, "label": label, "p": round(p, 3),
                                        "text": STATE["partial"][-120:]}) + "\n")
            LABEL_LOG.flush()
            publish("event", {"time": time.strftime("%H:%M:%S"), "label": label, "p": p})
            if r:
                fire(r, r.get("title") or label.split(".")[-2], STATE["partial"][-140:] or
                     (STATE["lines"][0]["text"] if STATE["lines"] else ""))
    # labels that dropped out of the frame (under the floor) are off
    for label, st in LABEL_ON.items():
        if label not in rec["p"]:
            st[0] = 0
            st[1] = False


LOG_THR = {}   # thresholds for labels no rule watches (logged only); default 0.6


# ---------------------------------------------------------------- optional LLM topic rules
CLOCK_STALE_S = 90


def health_loop():
    """every 2 s: the Pi's temperature / throttling and the input level, for the app's setup view"""
    peak = 0.0
    while True:
        time.sleep(2)
        try:
            temp = float(re.sub(r"[^0-9.]", "", subprocess.run(["vcgencmd", "measure_temp"], capture_output=True,
                                                               text=True, timeout=2).stdout) or "nan")
            thr = int(subprocess.run(["vcgencmd", "get_throttled"], capture_output=True, text=True,
                                     timeout=2).stdout.split("=")[-1], 16)
        except Exception:
            temp, thr = None, 0
        STATE["temp"] = temp
        if STATE["clock_label"] and time.time() - STATE.get("clock_at", 0) > CLOCK_STALE_S:
            STATE["clock"] = STATE["clock_label"] = None   # a clock nobody has said for a while is no longer the clock
            publish("state", {"score": STATE["score"], "score_text": score_text(), "clock": None, "clock_label": None,
                              "domain": ARGS.domain})
        STATE["throttled"] = bool(thr & 0x4)   # throttled right now
        publish("health", {"temp": temp, "throttled": STATE["throttled"], "level": STATE["level"],
                           "phone_mic": time.time() < PHONE["until"], "status": STATE["status"]})


def llm_loop():
    """Every 30 s: ask Claude whether the last minute of TV is about any 'topic' rule. Needs ANTHROPIC_API_KEY."""
    key = os.environ.get("ANTHROPIC_API_KEY")
    if not key:
        return
    while True:
        time.sleep(30)
        topics = [r for r in load_rules() if r["type"] == "topic"]
        with LOCK:
            recent = " ".join(l["text"] for l in list(STATE["lines"])[:8][::-1])
        if not topics or len(recent) < 40:
            continue
        prompt = ("TV transcript (last minute):\n" + recent + "\n\nWhich of these topics is the TV currently "
                  "discussing? " + json.dumps({r["id"]: r["topic"] for r in topics}) +
                  '\nAnswer only JSON: {"match": [ids], "why": "<10 words"}')
        try:
            req = urllib.request.Request(
                "https://api.anthropic.com/v1/messages",
                data=json.dumps({"model": ARGS.llm_model, "max_tokens": 100,
                                 "messages": [{"role": "user", "content": prompt}]}).encode(),
                headers={"x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json"})
            out = json.loads(urllib.request.urlopen(req, timeout=20).read())
            ans = json.loads(re.search(r"\{.*\}", out["content"][0]["text"], re.S).group(0))
            for r in topics:
                if r["id"] in ans.get("match", []):
                    fire(r, f"Topic: {r['topic']}", ans.get("why", recent[-160:]))
        except Exception as e:
            print(f"llm: {e}", file=sys.stderr)


# ---------------------------------------------------------------- audio -> arc_tv
def audio_source():
    """A process / file object giving 16 kHz mono s16le."""
    if ARGS.file:
        return None
    cmd = ["arecord", "-q", "-f", "S16_LE", "-r", "16000", "-c", "1", "-t", "raw"]
    if ARGS.device:
        cmd[1:1] = ["-D", ARGS.device]
    return subprocess.Popen(cmd, stdout=subprocess.PIPE)


CUR = {"arc": None}
STOPPING = [False]   # the audio ended on purpose (a clip without --loop): don't restart Arc   # the running arc_tv; a sport switch starts a new one and the audio moves over
SPORT_NAMES = {"nba": "Basketball (NBA)", "nfl": "American football (NFL)", "nhl": "Hockey (NHL)",
               "soccer": "Soccer", "cricket": "Cricket", "esports": "Esports", "news": "News", "talk": "Talk show",
               "court_trial": "Court TV", "stream_chat": "Live stream"}


def clip_for(domain):
    """--file demo.wav, or one clip per sport: --file nba=demo.wav,soccer=demo_soccer.wav"""
    if "=" not in ARGS.file:
        return ARGS.file
    clips = dict(x.split("=", 1) for x in ARGS.file.split(","))
    return clips.get(domain) or next(iter(clips.values()))


def write_audio(chunk):
    arc = CUR["arc"]
    try:
        arc.stdin.write(chunk)
        arc.stdin.flush()
    except (BrokenPipeError, ValueError, AttributeError):   # mid-switch: the old one is closing
        pass


PHONE = {"until": 0.0, "name": ""}   # a phone streaming its microphone (/api/audio) takes over while it sends


def feed(chunk, phone=False):
    if not phone and time.time() < PHONE["until"]:
        return False   # the phone is the microphone right now
    if len(chunk) >= 2:
        n = len(chunk) // 2
        vals = memoryview(chunk[:n * 2]).cast("h")
        STATE["level"] = round(max(abs(v) for v in vals[::8]) / 32768.0, 3)
    write_audio(chunk)
    return True


def pump():
    """Audio into the current arc_tv; files go at real-time speed (--fast: as fast as possible). Tracks the level."""
    if ARGS.file:
        while True:
            domain = ARGS.domain
            path = clip_for(domain)
            with wave.open(path) as w:
                assert w.getframerate() == 16000 and w.getnchannels() == 1 and w.getsampwidth() == 2, \
                    "file must be 16 kHz mono 16-bit WAV"
                STATE["status"] = f"playing {os.path.basename(path)}"
                while ARGS.domain == domain:   # a sport switch moves to that sport's clip
                    if time.time() < PHONE["until"]:   # the phone's microphone has the stream: hold the clip
                        time.sleep(0.2)
                        continue
                    chunk = w.readframes(1600)
                    if not chunk:
                        break
                    feed(chunk)
                    if not ARGS.fast:
                        time.sleep(0.1)
            if not ARGS.loop:
                break
            if ARGS.domain == domain:
                feed(b"\0" * 32000 * 3)
        STATE["status"] = "clip finished"
    elif ARGS.listen:   # no local mic: audio arrives over HTTP (/api/pcm from the Little TV app, /api/audio from the phone)
        STATE["status"] = "waiting for the TV app's audio"
        while True:
            time.sleep(3600)
    else:
        while True:   # a USB mic can be unplugged and plugged back: keep trying
            src = audio_source()
            STATE["status"] = f"listening ({ARGS.device or 'default mic'})"
            got = 0
            while True:
                chunk = src.stdout.read(3200)
                if not chunk:
                    break
                got += len(chunk)
                feed(chunk)
            src.wait()
            STATE["status"] = "microphone unplugged? retrying…" if got else "no microphone: plug it in, or use the phone mic"
            print(f"audio  {STATE['status']}", flush=True)
            time.sleep(2)
    STOPPING[0] = True
    CUR["arc"].stdin.close()


def start_arc():
    """(Re)start arc_tv with ARGS.domain; the old one finishes what it has and exits."""
    cmd = [ARGS.arc or os.path.join(HERE, "arc_tv"), ARGS.model, "--domain", ARGS.domain, "--threads", str(ARGS.threads),
           "--partial-ms", str(ARGS.partial_ms), "--partial-window", str(ARGS.partial_window)]
    cmd += ["--names", write_arc_names(), "--frames", "0.2"]
    cmd += ["--context", os.path.join(HERE, "context.txt"), "--bias", write_bias()]
    arc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=False)
    t = threading.Thread(target=read_arc, args=(arc,), daemon=True)
    t.start()
    old, CUR["arc"] = CUR["arc"], arc
    if old:
        try:
            old.stdin.close()
        except OSError:
            pass
    return t


SESSION = {"id": 0, "started": 0.0, "owner": None}
STRAY = {}   # client -> when we last logged ignoring it


def owns(handler):
    """one screen per game: the client (X-Client header) that started the session owns its audio and scoreboard.
    Another screen (the simulator while the TV plays, a second tab) can't mix its game in. Clients that don't send the
    header (older pages, tests, the phone) are accepted as before."""
    c = handler.headers.get("X-Client")
    if not c or not SESSION["owner"] or c == SESSION["owner"]:
        return True
    if time.time() - STRAY.get(c, 0) > 30:
        STRAY[c] = time.time()
        print(f"client {c} ignored: session {SESSION['id']} belongs to {SESSION['owner']}", flush=True)
    return False


def reset_game():
    """a new session: one game, its own memory. Nothing from the last game (Arc's context, the moments, catch-up,
    facts, cooldowns, the live line, the telemetry file) carries into this one; only the user's watchlist does."""
    with LOCK:
        for k in ("lines", "alerts"):
            STATE[k].clear()
        for k in ("lines", "scores", "alerts"):
            MEMORY[k].clear()
        STATE.update(partial="", score=None, clock=None, clock_label=None, score_at=0, clock_at=0)
        OCR.update(at=0.0, teams=("", ""), history=[], run_said={})
        GAME.update(players={}, ties=0, lead_changes=0, max_lead=[0, 0], runs=[], plays=[])
        HEARD.update(players={}, plays=[], last={})
        LAST_FIRED.clear()
        EARLY_SENT.clear()
        LABEL_ON.clear()
        LAST_BIG.update(alert=None, t=0, boosted=False)
        STITCH.update(id=None, words=[], tags=[])
        SPEECH.clear()
        MEMORY["ctx_written"] = 0.0
        SESSION.update(id=SESSION["id"] + 1, started=time.time())
    with open(os.path.join(HERE, "context.txt"), "w"):
        pass
    if TELE["f"] is not None and not TELE["f"].closed and TELE["f"].name != os.devnull:   # one telemetry file per session
        TELE["f"].close()
        TELE["f"] = None
    print(f"reset  new session {SESSION['id']}", flush=True)
    tele("reset", {"session": SESSION["id"]})
    if CUR["arc"] is not None:
        start_arc()   # a fresh Arc: no decoder context or names from the last game
    publish("state", {"text": "", "score": None, "score_text": "", "clock": None, "clock_label": None, "domain": ARGS.domain})


def set_sport(domain):
    if domain not in SPORT_NAMES or domain == ARGS.domain:
        return
    ARGS.domain = domain
    STATE["score"] = STATE["clock"] = STATE["clock_label"] = None
    print(f"sport  -> {domain}", flush=True)
    start_arc()
    publish("state", {"text": "", "score": None, "clock": None, "clock_label": None, "domain": domain})


STITCH = {"id": None, "words": [], "tags": []}


def _norm(w):
    return re.sub(r"[^a-z0-9]", "", w.lower())


def clean_window(words):
    """A greedy partial loops where its audio runs out ("Curry, Curry, Curry", "... Stephen Curry brings it up," again):
    keep one of a repeated word, and stop where a three-word phrase of this window starts over."""
    out, seen = [], set()
    for w in words:
        if out and _norm(w) == _norm(out[-1]) and _norm(w):
            continue
        out.append(w)
        if len(out) >= 3:
            g = tuple(_norm(x) for x in out[-3:])
            if g in seen and all(g):
                del out[-3:]
                break
            seen.add(tuple(_norm(x) for x in out[-4:-1])) if len(out) >= 4 else None
    return out


def undouble(words):
    """drop a phrase said twice in a row by the stitch, not the commentator ("goes right goes right at" -> "goes right
    at"): an overlap that slipped by a word re-adds the words it overlapped"""
    out = list(words)
    for n in range(6, 1, -1):
        i = 0
        while i + 2 * n <= len(out):
            if [_norm(w) for w in out[i:i + n]] == [_norm(w) for w in out[i + n:i + 2 * n]]:
                del out[i + n:i + 2 * n]
            else:
                i += 1
    return out


def stitch(rec):
    """Arc's partials re-decode only the last few seconds of a long sentence; join each window onto what came before
    at the place it overlaps best (fuzzy: a re-decode may spell a word differently; a window that starts mid-word may
    begin with junk, so its first two words may be skipped). The live line never shrinks: a garbled window keeps it."""
    words = clean_window(rec["text"].split(" "))
    if STITCH["id"] != rec["id"]:
        STITCH.update(id=rec["id"], words=[], tags=[])
    old = STITCH["words"]
    on, wn = [_norm(w) for w in old], [_norm(w) for w in words]
    sim = lambda a, b: 1.0 if a == b else difflib.SequenceMatcher(None, a, b).ratio()   # "curi" ~ "curry"
    best, cut, skip = 0.0, None, 0
    for sk in (0, 1, 2):
        for i in range(max(0, len(old) - len(words) - 8), len(old)):
            n = min(len(old) - i, len(wn) - sk, 5)   # anchor on the window's first words: a misheard tail can't spoil it
            if n <= 0:
                continue
            r = sum(sim(on[i + j], wn[sk + j]) for j in range(n)) / n * min(1.0, n / 3) - 0.05 * sk
            if r >= best - 1e-9 and r >= 0.6:   # ties: the latest place
                best, cut, skip = r, i, sk
    if cut is None:
        if old and len(words) < len(old):
            return " ".join(old), STITCH["tags"]   # no overlap and shorter: a garbled window, keep the line
        cut = 0 if not old else len(old)
    new = undouble(old[:cut] + words[skip:])
    if len(new) < len(old) - 2:
        return " ".join(old), STITCH["tags"]   # the line never shrinks by more than a word or two
    tags = [t for t in STITCH["tags"] if t["we"] <= cut]
    tags += [dict(t, wb=t["wb"] - skip + cut, we=t["we"] - skip + cut) for t in rec["tags"]
             if "wb" in t and t["wb"] >= skip and t["we"] <= len(words)]
    STITCH.update(words=new, tags=tags)
    return " ".join(new), tags


def remember(line):
    """keep the last --memory-min minutes; every 20 s hand the names heard most to Arc's decoder (context.txt)"""
    now = time.time()
    with LOCK:
        MEMORY["lines"].append((now, dict(line, domain=ARGS.domain)))
        for k in ("lines", "scores", "alerts"):
            while MEMORY[k] and MEMORY[k][0][0] < now - ARGS.memory_min * 60:
                MEMORY[k].popleft()
    if now - MEMORY["ctx_written"] >= 20:
        MEMORY["ctx_written"] = now
        names = []
        for line in open(write_arc_names()):
            bits = line.strip().split("|")
            if bits[0] and not bits[0].startswith("#"):
                names.append((bits[0].strip(), bits[1].strip() if len(bits) > 1 else ""))
        seen = {c.lower() for c, _ in names}
        for name, kind, _n in top_mentions(16):
            if name.lower() not in seen:
                names.append((name, kind))
                seen.add(name.lower())
        tmp = os.path.join(HERE, "context.txt.tmp")
        with open(tmp, "w") as f:
            f.write("".join(f"{n}|{k}\n" for n, k in names[:24]))
        os.replace(tmp, os.path.join(HERE, "context.txt"))


def top_mentions(k=8):
    """[(name, kind, count)] most heard in memory (Arc's person / team / place / org tags)"""
    counts, kinds, shown = {}, {}, {}
    with LOCK:
        lines = [l for _, l in MEMORY["lines"] if l.get("domain", ARGS.domain) == ARGS.domain]
    for l in lines:
        for t in l.get("tags", []):
            if t["tag"] in KIND:
                name = t.get("watch") or t["text"].strip(" .,!?'\"")
                if len(name) < 3:
                    continue
                key = name.lower()
                counts[key] = counts.get(key, 0) + 1
                kinds[key] = KIND[t["tag"]]
                shown.setdefault(key, name)
    top = sorted(counts, key=lambda x: -counts[x])[:k]
    return [(shown[x], kinds[x], counts[x]) for x in top]


def catchup():
    """what happened in the last --memory-min minutes: score changes, alerts, who was talked about, a recap"""
    with LOCK:
        lines = list(MEMORY["lines"])
        scores = list(MEMORY["scores"])
        alerts = list(MEMORY["alerts"])
    span = (time.time() - lines[0][0]) / 60 if lines else 0
    out = {"minutes": round(span, 1), "window": ARGS.memory_min, "domain": ARGS.domain,
           "sentences": len(lines), "words": sum(len(l["text"].split()) for _, l in lines),
           "score": STATE["score"], "score_text": score_text(), "clock": STATE.get("clock_label"),
           "scores": [{"time": time.strftime("%H:%M", time.localtime(t)), "score": sc, "said": said}
                      for t, sc, said in scores[-12:]],
           "moments": [dict(a, time=a["time"][:5]) for _, a in alerts[-15:]][::-1],
           "top": [{"name": n, "kind": k, "count": c} for n, k, c in top_mentions(10)],
           "recap": None}
    if os.environ.get("ANTHROPIC_API_KEY") and lines:
        text = " ".join(l["text"] for _, l in lines)[-12000:]
        out["recap"] = llm(f"This is the last {span:.0f} minutes of a {SPORT_NAMES.get(ARGS.domain, '')} TV broadcast, "
                           f"transcribed live (expect some recognition errors):\n\n{text}\n\nCatch a viewer up in 3 "
                           "short sentences: what happened, the score and the key players. Plain text.", 220)
    return out


def llm(prompt, max_tokens):
    try:
        req = urllib.request.Request(
            "https://api.anthropic.com/v1/messages",
            data=json.dumps({"model": ARGS.llm_model, "max_tokens": max_tokens,
                             "messages": [{"role": "user", "content": prompt}]}).encode(),
            headers={"x-api-key": os.environ["ANTHROPIC_API_KEY"], "anthropic-version": "2023-06-01",
                     "content-type": "application/json"})
        return json.loads(urllib.request.urlopen(req, timeout=25).read())["content"][0]["text"].strip()
    except Exception as e:
        print(f"llm: {e}", file=sys.stderr)
        return None


EARLY = {"id": None, "hits": set()}


def early_alerts(rec, text, tags):
    """Alerts before the sentence ends: run the rules over the live partial without touching the game state; a hit
    the last partial of this sentence also had is stable, and fires now (the final's own pass is then in cooldown)."""
    global COLLECT, STRICT
    saved = (STATE["score"], STATE["clock"], STATE["clock_label"], len(MEMORY["scores"]))
    COLLECT, STRICT = [], True
    try:
        check_rules({"text": text, "tags": tags})
        hits = COLLECT
    finally:
        COLLECT, STRICT = None, False
        STATE["score"], STATE["clock"], STATE["clock_label"] = saved[:3]
        while len(MEMORY["scores"]) > saved[3]:
            MEMORY["scores"].pop()
    if EARLY["id"] != rec["id"]:
        EARLY.update(id=rec["id"], hits=set())
    keys = {(r.get("id"), title) for r, title, _ in hits}
    for r, title, body in hits:
        if (r.get("id"), title) in EARLY["hits"]:
            fire(r, title, body, early=True)
    EARLY["hits"] = keys


def read_arc(arc):
    t_start = time.time()
    for raw in arc.stdout:
        try:
            rec = json.loads(raw)
        except ValueError:
            continue
        try:
            handle(arc, rec)
        except Exception as e:   # a bug in one record must never stop the live feed
            import traceback
            print(f"error  {e!r} on {rec.get('k')} record", file=sys.stderr, flush=True)
            traceback.print_exc()
    code = arc.wait()
    if arc is CUR["arc"] and not STOPPING[0]:   # Arc died under us (not a sport switch, not the end): bring it back
        print(f"arc    exited ({code}) after {time.time() - t_start:.0f} s; restarting", file=sys.stderr, flush=True)
        STATE["status"] = "restarting Arc"
        time.sleep(1 if time.time() - t_start > 30 else 5)   # a crash loop backs off
        start_arc()


# ---------------------------------------------------------------- telemetry (every stream)
TELE = {"f": None}


def tele(kind, data):
    """one JSON line per record: Arc's frames, finals and events, the tagger, the scoreboard, alerts. Written
    locally to $TVW_SESSIONS (default ./sessions)."""
    try:
        if TELE["f"] is None:
            d = os.environ.get("TVW_SESSIONS", "sessions")
            os.makedirs(d, exist_ok=True)
            TELE["f"] = open(os.path.join(d, time.strftime("%Y%m%d-%H%M%S") + ".jsonl"), "a", buffering=1)
        TELE["f"].write(json.dumps({"w": round(time.time(), 2), "k": kind, "dom": ARGS.domain, **data}) + "\n")
    except OSError:
        pass


# ---------------------------------------------------------------- Arc Tagger (text): events and spans on each sentence
TAGGER = os.environ.get("ARCTAG_URL", "http://127.0.0.1:8090")


def tag_text(text):
    """Arc Tagger's read of a finished sentence, logged for the director (not alerted on: uncalibrated so far)"""
    try:
        req = urllib.request.Request(TAGGER + "/tag", data=json.dumps({"text": text, "domain": "sports" if ARGS.domain in SPORTS else ARGS.domain}).encode())
        out = json.loads(urllib.request.urlopen(req, timeout=2).read())
    except (OSError, ValueError):
        return
    tele("tagger", {"text": text, "events": [{"tag": e.get("tag") or e.get("type"), "p": e.get("p") or e.get("score"), "at": e.get("at")} for e in out.get("events", [])],
                    "spans": [{"type": x.get("type"), "text": x.get("text"), "p": x.get("score")} for x in out.get("spans", [])
                              if (x.get("type") or "").startswith(("entity.number.score", "entity.number.clock", "entity.mention"))],
                    "utt": [{"intent": u.get("intent"), "state": u.get("state")} for u in out.get("utterances", [])]})


# Arc mishears under crowd noise ("and the foul" came out as "and the fuck"): no swear word reaches a screen.
SWEAR = re.compile(r"\b(fuck\w*|shit\w*|bitch\w*|asshole\w*|cunt\w*|motherfuck\w*|dick(?:head)?s?|bastard\w*)\b", re.I)


def clean(text):
    def fix(m):
        w = m.group(0)
        if ARGS.domain in SPORTS and w.lower().startswith("fuck"):   # in a game it's almost always "foul"
            return ("F" if w[0].isupper() else "f") + "oul" + ("s" if w.lower().endswith("s") else "")
        return w[0] + "*" * (len(w) - 1)
    return SWEAR.sub(fix, text or "")


def handle(arc, rec):
    if "text" in rec:
        rec["text"] = clean(rec["text"])
    if arc is CUR["arc"] and rec.get("k") != "partial":
        tele("arc", rec)
    if True:
        if arc is not CUR["arc"]:   # the previous sport's stream finishing: not this game's
            return
        if rec["k"] in ("partial", "final"):
            rec["tags"] = mark_watch(rec["text"], rec.get("tags", []))
        if rec["k"] == "partial":
            text, tags = stitch(rec)
            text = clean(text)
            if looping(text) or speech_level() < 0.45:   # crowd noise: Arc's guesses don't reach the screen
                return
            STATE["partial"] = text
            publish("partial", {"id": rec["id"], "text": text, "tags": tags})
            if not ARGS.no_early:
                early_alerts(rec, text, [dict(t) for t in tags])
        elif rec["k"] == "final":
            STATE["partial"] = ""
            line = {"id": rec["id"], "time": time.strftime("%H:%M:%S"), "text": rec["text"], "tags": rec["tags"]}
            with LOCK:
                STATE["lines"].appendleft(line)
            remember(line)
            publish("final", line)
            print(f"TV     {time.time():.2f} {rec['text']}", flush=True)
            threading.Thread(target=tag_text, args=(rec["text"],), daemon=True).start()
            check_rules(rec)
            heard_scoring(rec["text"], rec["tags"])
            publish("state", {"text": rec["text"], "score": STATE["score"], "score_text": score_text(), "clock": STATE["clock"],
                              "clock_label": STATE["clock_label"], "domain": ARGS.domain})
        elif rec["k"] == "frame":
            arc_frame(rec)
        elif rec["k"] == "event":
            ev = {"time": time.strftime("%H:%M:%S"), "label": rec["label"], "p": rec["p"]}
            publish("event", ev)
            for r in active_rules():   # a crowd reaction often comes before the commentator names the moment
                if r["type"] == "sound" and rec["label"] in r.get("labels", []) and rec["p"] >= r.get("min_p", 0.9):
                    crowd(r, rec["label"])
            print(f"event  {rec['label']} p={rec['p']}", flush=True)


# ---------------------------------------------------------------- web page
def page(name):
    p = os.path.join(HERE, name)
    return open(p, encoding="utf-8").read() if os.path.exists(p) else f"<p>{name} missing</p>"


class Web(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def send(self, code, body, ctype="application/json"):
        b = body if isinstance(body, bytes) else body.encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def events(self):
        q = queue.Queue()
        with LOCK:
            SUBS.append(q)
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        try:
            with LOCK:
                hello = {"sports": SPORT_NAMES,
                         "text": (STATE["lines"][0]["text"] if STATE["lines"] else ""), "score": STATE["score"], "score_text": score_text(),
                         "clock": STATE["clock"], "clock_label": STATE["clock_label"], "status": STATE["status"],
                         "domain": ARGS.domain,
                         "lines": list(STATE["lines"])[:12][::-1], "alerts": list(STATE["alerts"])[:10][::-1]}
            self.wfile.write(f"event: hello\ndata: {json.dumps(hello)}\n\n".encode())
            self.wfile.flush()
            while True:
                try:
                    self.wfile.write(q.get(timeout=10))
                except queue.Empty:
                    self.wfile.write(b": ping\n\n")   # keeps the phone's connection (and its watchdog) alive
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            with LOCK:
                SUBS.remove(q)

    def do_GET(self):
        if self.path == "/api/events":
            return self.events()
        if self.path.startswith("/api/yt/search"):
            qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            return self.send(200, json.dumps(yt_search(qs.get("q", [""])[0][:120], qs.get("live", ["0"])[0] == "1")))
        if self.path == "/api/facts":
            return self.send(200, json.dumps(facts()))
        if self.path == "/api/catchup":
            return self.send(200, json.dumps(catchup()))
        if self.path == "/api/state":
            with LOCK:
                s = {"lines": list(STATE["lines"]), "partial": STATE["partial"], "alerts": list(STATE["alerts"]),
                     "score": STATE["score"], "score_text": score_text(), "clock": STATE["clock"], "clock_label": STATE["clock_label"],
                     "level": STATE["level"], "session": SESSION["id"], "owner": SESSION["owner"], "board": ocr_fresh(), "board_age_s": round(time.time() - OCR["at"], 1) if OCR["at"] else None,
                     "teams": list(OCR["teams"]) if ocr_fresh() else None,
                     "status": STATE["status"], "domain": ARGS.domain, "ntfy": ARGS.ntfy, "dry_run": ARGS.dry_run,
                     "rules": load_rules(), "active": [r.get("id") for r in active_rules()],
                     "sports": SPORT_NAMES, "names": [n for n, _ in sport_names()] + [n for n, _ in load_names(roster_path())]}
            self.send(200, json.dumps(s))
        elif self.path.rstrip("/") == "/tv":   # full-screen captions + score bug + alerts, for the TV itself
            self.send(200, page("tv.html"), "text/html; charset=utf-8")
        else:
            self.send(200, page("index.html"), "text/html; charset=utf-8")

    def phone_audio(self):
        """The phone app's microphone: 16 kHz mono s16le, a chunked POST that lasts as long as it streams."""
        PHONE["name"] = self.headers.get("X-Device", "phone")
        STATE["status"] = f"listening ({PHONE['name']} microphone)"
        print(f"audio  {PHONE['name']} microphone connected", flush=True)
        n = 0
        try:
            chunked = "chunked" in self.headers.get("Transfer-Encoding", "")
            left = int(self.headers.get("Content-Length", 0))
            while True:
                if chunked:
                    size = int(self.rfile.readline().split(b";")[0].strip() or b"0", 16)
                    if size == 0:
                        break
                    data = self.rfile.read(size)
                    self.rfile.readline()
                else:
                    if left <= 0:
                        break
                    data = self.rfile.read(min(3200, left))
                    left -= len(data)
                    if not data:
                        break
                PHONE["until"] = time.time() + 1.5
                feed(data, phone=True)
                n += len(data)
        except (ConnectionResetError, OSError, ValueError):
            pass
        PHONE["until"] = 0
        STATE["status"] = "phone microphone stopped"
        print(f"audio  {PHONE['name']} microphone gone after {n / 32000:.0f} s", flush=True)
        self.send(200, "{}")

    def app_pcm(self):
        """One short chunk of 16 kHz mono s16le from the Little TV app (its mic, or the clip it is playing)."""
        data = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        if not owns(self):
            return self.send(409, "{}")
        src = urllib.parse.unquote(self.headers.get("X-Source", "tv app"))
        if not STATE["status"].endswith(f"({src})"):
            STATE["status"] = f"listening ({src})"
            print(f"audio  {src} streaming", flush=True)
        PHONE["until"] = time.time() + 1.5   # the app holds the stream like the phone does: a clip pauses meanwhile
        feed(data, phone=True)
        self.send(200, "{}")

    def do_POST(self):
        if self.path == "/api/audio":
            return self.phone_audio()
        if self.path == "/api/pcm":
            return self.app_pcm()
        if self.path == "/api/ask":   # a spoken question (16 kHz mono s16le): Arc's words, then the facts to answer from
            pcm = self.rfile.read(int(self.headers.get("Content-Length", 0)))
            return self.send(200, json.dumps({"heard": ask_audio(pcm), "facts": facts()}))
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
        if self.path in ("/api/reset", "/api/sport", "/api/roster") and self.headers.get("X-Client"):
            if SESSION["owner"] != self.headers["X-Client"]:
                print(f"client {self.headers['X-Client']} starts a game: it owns the session now", flush=True)
            SESSION["owner"] = self.headers["X-Client"]   # starting a game claims it; the last screen to start one wins
        elif self.path == "/api/ocr" and not owns(self):
            return self.send(409, json.dumps({"error": "another screen owns this game"}))
        rules = load_rules()
        if self.path == "/api/rules":
            body["id"] = body.get("id") or f"r{int(time.time() * 1000)}"
            rules = [r for r in rules if r.get("id") != body["id"]] + [body]   # same id: replace
            save_rules(rules)
        elif self.path == "/api/rules/delete":
            save_rules([r for r in rules if r.get("id") != body.get("id")])
        elif self.path == "/api/sport":
            set_sport(body.get("domain", ""))
        elif self.path == "/api/ocr":
            on_ocr(body)
        elif self.path == "/api/yt/bad":   # the player refused this video (error 100/101/150): never offer it again
            BAD_YT.add(str(body.get("id", ""))[:20])
            print(f"yt     bad video {body.get('id')} ({body.get('code')})", flush=True)
        elif self.path == "/api/reel":   # cut the app's highlights into a shareable file, off the request thread
            threading.Thread(target=cut_reel, args=(body.get("src", ""), body.get("segments", [])), daemon=True).start()
        elif self.path == "/api/telemetry":   # the app's own streams (raw scoreboard reads, what it played)
            tele(str(body.pop("k", "app")), body)
        elif self.path == "/api/reset":   # a new programme (the TV app starts another clip): forget the old game
            reset_game()
        elif self.path == "/api/roster":   # tonight's lineup for a sport: {"domain": "nba", "names": "Jalen Brunson|person|Brunson\n..."}
            d = body.get("domain") or ARGS.domain
            if d not in SPORT_NAMES:
                return self.send(400, "{}")
            os.makedirs(os.path.join(HERE, "rosters"), exist_ok=True)
            with open(os.path.join(HERE, "rosters", f"{d}.txt"), "w") as f:
                f.write(str(body.get("names", "")).strip() + "\n")
            if d == ARGS.domain:
                start_arc()   # Arc picks the new names up now
        elif self.path == "/api/test":
            fire({"id": f"test{time.time()}", "cooldown_s": 0}, "TV Watch test", "Notifications are working.")
        else:
            return self.send(404, "{}")
        self.send(200, "{}")


def main():
    global ARGS
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--device", help="arecord device, e.g. plughw:1 (see --list-devices)")
    ap.add_argument("--file", help="16 kHz mono WAV instead of the mic (played at real-time speed)")
    ap.add_argument("--fast", action="store_true", help="with --file: as fast as possible")
    ap.add_argument("--loop", action="store_true", help="with --file: replay the clip forever (a demo without a TV)")
    ap.add_argument("--domain", default="nba",
                    help="Arc domain: nba nhl nfl cricket soccer esports news talk meeting unknown (default news)")
    ap.add_argument("--model", default=os.path.expanduser("~/arc/models/mini-tv")
                    if os.path.isdir(os.path.expanduser("~/arc/models/mini-tv")) else os.path.expanduser("~/arc/models/mini"),
                    help="Arc Mini folder; mini-tv = the same weights with crowd / venue sounds switched on")
    ap.add_argument("--threads", type=int, default=3)
    ap.add_argument("--partial-ms", type=int, default=1000, help="live partial text every N ms (-1: none)")
    ap.add_argument("--partial-window", type=float, default=7,
                    help="live partials re-decode at most the last N s of the sentence (Arc's default 7)")
    ap.add_argument("--ntfy", default=os.environ.get("TVWATCH_NTFY"), help="ntfy topic your phone subscribes to")
    ap.add_argument("--ntfy-server", default="https://ntfy.sh")
    ap.add_argument("--dry-run", action="store_true", help="print alerts, don't push them")
    ap.add_argument("--port", type=int, default=8080)
    ap.add_argument("--llm-model", default="claude-haiku-5-5")
    ap.add_argument("--no-early", action="store_true", help="alert on finished sentences only (no early alerts)")
    ap.add_argument("--memory-min", type=float, default=30, help="minutes of TV the Pi remembers (recap, Arc context)")
    ap.add_argument("--list-devices", action="store_true")
    ap.add_argument("--listen", action="store_true", help="no local mic: take audio only from the apps (/api/pcm, /api/audio)")
    ap.add_argument("--arc", help="the arc_tv binary (default: ./arc_tv)")
    ARGS = ap.parse_args()
    if ARGS.list_devices:
        subprocess.run(["arecord", "-l"])
        return
    with open(os.path.join(HERE, "context.txt"), "w"):
        pass   # the last run's context (names heard then, maybe another sport) must not steer this one
    srv = ThreadingHTTPServer(("0.0.0.0", ARGS.port), Web)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    threading.Thread(target=llm_loop, daemon=True).start()
    threading.Thread(target=health_loop, daemon=True).start()
    print(f"TV Watch: web page on http://{os.uname().nodename}.local:{ARGS.port}  "
          f"(alerts {'printed only' if ARGS.dry_run or not ARGS.ntfy else 'to ntfy topic ' + ARGS.ntfy})", flush=True)
    start_arc()
    pump()
    while CUR["arc"].poll() is None:
        time.sleep(0.5)
    if ARGS.file:
        print("clip done; web page stays up (Ctrl-C to quit)", flush=True)
        while True:
            time.sleep(3600)


if __name__ == "__main__":
    main()
