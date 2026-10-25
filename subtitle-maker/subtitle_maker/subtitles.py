"""Turn Whisper output into readable subtitle cues and write SRT files.

Whisper segments can run for 20+ seconds, which is unreadable on screen, so
cues are rebuilt from word timestamps: a new cue starts when the text gets
too long, the cue gets too long, there is a pause in speech, or a sentence
ends.
"""

import math
import textwrap
from dataclasses import dataclass

MAX_LINE_CHARS = 42      # common broadcast limit per line
MAX_CUE_CHARS = 84       # two full lines
MAX_CUE_SECONDS = 7.0
MAX_PAUSE_SECONDS = 1.0  # silence longer than this splits a cue
MIN_CUE_SECONDS = 1.0
MIN_GAP_SECONDS = 0.05   # keep cues from touching

SENTENCE_END = (".", "?", "!", "。", "？", "！", "؟", "…")
CLAUSE_END = SENTENCE_END + (",", ";", ":", "،", "؛", "，", "、")

RLM = "‏"


@dataclass
class Cue:
    start: float
    end: float
    text: str


@dataclass
class _Word:
    start: float
    end: float
    word: str


def _join(words):
    return "".join(w.word for w in words).strip()


def build_cues(segments, max_chars=MAX_CUE_CHARS, max_seconds=MAX_CUE_SECONDS,
               max_pause=MAX_PAUSE_SECONDS):
    """Group the words of Whisper segments into subtitle-sized cues.

    `segments` is any iterable of objects with `start`, `end`, `text` and an
    optional `words` list (each with `start`, `end`, `word`).
    """
    cues = []
    current = []

    def flush(words):
        text = _join(words)
        if text:
            cues.append(Cue(words[0].start, words[-1].end, text))

    for seg in segments:
        words = getattr(seg, "words", None) or [_Word(seg.start, seg.end, seg.text)]
        for w in words:
            if current:
                too_long = len(_join(current + [w])) > max_chars
                too_slow = w.end - current[0].start > max_seconds
                paused = w.start - current[-1].end > max_pause
                if too_long or too_slow or paused:
                    keep = [] if paused else _split_point(current)
                    flush(current[:len(current) - len(keep)])
                    current = keep
            current.append(w)
            if w.word.strip().endswith(SENTENCE_END) and len(_join(current)) >= max_chars // 3:
                flush(current)
                current = []
        # Whisper segments usually end at a natural break.
        if current:
            flush(current)
            current = []

    return fix_timing(cues)


def _split_point(words):
    """When a cue overflows, prefer breaking after the last comma/full stop in
    its second half; return the words that move on to the next cue."""
    for i in range(len(words) - 1, len(words) // 2 - 1, -1):
        if words[i].word.strip().endswith(CLAUSE_END):
            return words[i + 1:]
    return []


def fix_timing(cues, min_seconds=MIN_CUE_SECONDS, min_gap=MIN_GAP_SECONDS):
    """Remove overlaps and stretch very short cues so they can be read."""
    cues = sorted(cues, key=lambda c: c.start)
    for i, cue in enumerate(cues):
        next_start = cues[i + 1].start if i + 1 < len(cues) else math.inf
        if cue.end - cue.start < min_seconds:
            cue.end = cue.start + min_seconds
        cue.end = max(min(cue.end, next_start - min_gap), cue.start + 0.01)
    return cues


def wrap_text(text, max_line=MAX_LINE_CHARS):
    """Break text into balanced lines (two lines, or three for very long
    translations)."""
    text = " ".join(text.split())
    if len(text) <= max_line:
        return [text]
    n_lines = min(3, math.ceil(len(text) / max_line))
    if " " not in text:
        # Scripts without spaces (Chinese, Japanese, Thai): cut evenly.
        size = math.ceil(len(text) / n_lines)
        return [text[i:i + size] for i in range(0, len(text), size)]
    width = math.ceil(len(text) / n_lines)
    while True:
        lines = textwrap.wrap(text, width=width, break_long_words=False)
        if len(lines) <= n_lines:
            return lines
        width += 1


def format_timestamp(seconds):
    ms = max(0, round(seconds * 1000))
    h, ms = divmod(ms, 3_600_000)
    m, ms = divmod(ms, 60_000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def to_srt(cues, rtl=False):
    blocks = []
    for i, cue in enumerate(cues, 1):
        lines = wrap_text(cue.text)
        if rtl:
            lines = [f"{RLM}{line}{RLM}" for line in lines]
        blocks.append(
            f"{i}\r\n{format_timestamp(cue.start)} --> {format_timestamp(cue.end)}\r\n"
            + "\r\n".join(lines) + "\r\n"
        )
    return "\r\n".join(blocks)


def write_srt(path, cues, rtl=False):
    # UTF-8 with BOM: every player reads it, and older Windows players need
    # the BOM to show Arabic instead of gibberish.
    with open(path, "w", encoding="utf-8-sig", newline="") as f:
        f.write(to_srt(cues, rtl=rtl))
