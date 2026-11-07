#!/usr/bin/env python3
"""Synthesise the TV eval: every line in lines.json x 4 voices x 3 conditions -> wav/<cond>/<id>__<voice>.wav (16 kHz).
  clean  the voice alone
  crowd  + babble of other commentary lines and pink noise at 10 dB SNR (a loud arena on the TV's own output)
  room   a mic across the room: reverb (RT60 0.5 s), crowd at 15 dB, small-speaker band (150 Hz - 5 kHz), quieter
  near   the setup we recommend: a mic at the TV speaker. Short echo with a strong direct path (RT60 0.25 s), arena
         noise (24 overlapping voices + pink noise: a roar, not words) at 15 dB, TV-speaker band (120 Hz - 6 kHz)"""
import json, os, subprocess, sys, warnings
warnings.filterwarnings("ignore")
import numpy as np
from scipy.io import wavfile
from scipy.signal import fftconvolve, butter, sosfilt
HERE = os.path.dirname(os.path.abspath(__file__))
VOICES = ["Samantha", "Daniel", "Eddy (English (US))", "Flo (English (UK))"]
SR = 16000
rng = np.random.default_rng(7)


def tts(text, voice, path):
    if not os.path.exists(path):
        aiff = path + ".aiff"
        subprocess.run(["say", "-v", voice, "-o", aiff, text], check=True)
        subprocess.run(["afconvert", "-f", "WAVE", "-d", "LEI16@16000", "-c", "1", aiff, path], check=True)
        os.remove(aiff)
    return wavfile.read(path)[1].astype(np.float32) / 32768


def mix_to(x, noise, snr_db):
    noise = np.resize(noise, len(x))
    px, pn = np.mean(x ** 2) + 1e-9, np.mean(noise ** 2) + 1e-9
    return x + noise * np.sqrt(px / (pn * 10 ** (snr_db / 10)))


def pink(n):
    w = np.fft.rfft(rng.standard_normal(n))
    f = np.arange(len(w)); f[0] = 1
    return np.fft.irfft(w / np.sqrt(f), n)


def save(path, x):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    x = x / max(1.0, np.max(np.abs(x)) / 0.95)
    wavfile.write(path, SR, (x * 32767).astype(np.int16))


lines = json.load(open(os.path.join(HERE, "lines.json")))
raw = os.path.join(HERE, "wav", "_tts")
os.makedirs(raw, exist_ok=True)
clips = {}
for l in lines:
    for v in VOICES:
        vk = v.split(" ")[0].lower()
        clips[(l["id"], vk)] = tts(l["text"], v, os.path.join(raw, f"{l['id']}__{vk}.wav"))
babble_src = list(clips.values())
t = np.arange(int(SR * 0.6)) / SR
ir = rng.standard_normal(len(t)) * np.exp(-6.9 * t / 0.5)   # RT60 0.5 s
ir[0] = 4.0
ir /= np.sqrt(np.sum(ir ** 2))
band = butter(4, [150, 5000], btype="band", fs=SR, output="sos")
t2 = np.arange(int(SR * 0.4)) / SR
ir_near = rng.standard_normal(len(t2)) * np.exp(-6.9 * t2 / 0.25) * 0.15
ir_near[0] = 1.0
ir_near /= np.sqrt(np.sum(ir_near ** 2))
band_near = butter(4, [120, 6000], btype="band", fs=SR, output="sos")
only = sys.argv[1].split(",") if len(sys.argv) > 1 else ["clean", "crowd", "room", "near"]
for (lid, vk), x in clips.items():
    pad = np.zeros(int(SR * 0.4), np.float32)
    x = np.concatenate([pad, x, pad])
    others = [babble_src[i] for i in rng.choice(len(babble_src), 6, replace=False)]
    bab = sum(np.resize(o, len(x)) * rng.uniform(0.3, 1.0) for o in others) + 0.5 * pink(len(x)) * 0.05
    if "clean" in only:
        save(os.path.join(HERE, "wav", "clean", f"{lid}__{vk}.wav"), x)
    if "crowd" in only:
        save(os.path.join(HERE, "wav", "crowd", f"{lid}__{vk}.wav"), mix_to(x, bab, 10))
    if "room" in only:
        wet = fftconvolve(x, ir)[:len(x)]
        save(os.path.join(HERE, "wav", "room", f"{lid}__{vk}.wav"), sosfilt(band, mix_to(wet, bab, 15)) * 0.3)
    if "near" in only:
        roar = sum(np.roll(np.resize(babble_src[i], len(x)), rng.integers(len(x)))
                   for i in rng.choice(len(babble_src), 24, replace=True)) + pink(len(x)) * 0.1
        wet = fftconvolve(x, ir_near)[:len(x)]
        save(os.path.join(HERE, "wav", "near", f"{lid}__{vk}.wav"), sosfilt(band_near, mix_to(wet, roar, 15)) * 0.6)
print(len(clips), "clips x 3 conditions")
