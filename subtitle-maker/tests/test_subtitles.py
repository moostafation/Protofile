from types import SimpleNamespace as NS

import pytest

from subtitle_maker.subtitles import (MAX_CUE_CHARS, RLM, Cue, build_cues, fix_timing,
                                      format_timestamp, to_srt, wrap_text, write_srt)


def words_segment(text, start=0.0, step=0.4, pause_after=None):
    """A fake Whisper segment whose words are spaced `step` seconds apart."""
    words, t = [], start
    for i, w in enumerate(text.split()):
        words.append(NS(start=t, end=t + step * 0.9, word=" " + w))
        t += step
        if pause_after is not None and i == pause_after:
            t += 3
    return NS(start=start, end=t, text=" " + text, words=words)


def test_long_segment_is_split_into_readable_cues():
    text = ("this is a very long sentence that keeps going and going without any "
            "punctuation at all because people talk like that sometimes in videos "
            "and whisper puts all of it into a single segment of thirty seconds")
    cues = build_cues([words_segment(text)])
    assert len(cues) > 1
    assert all(len(c.text) <= MAX_CUE_CHARS for c in cues)
    assert all(c.end - c.start <= 7.0 for c in cues)
    assert " ".join(c.text for c in cues) == text


def test_sentence_end_and_pause_start_new_cues():
    seg = words_segment("Welcome to the channel everybody here. Today we talk pipes", pause_after=None)
    cues = build_cues([seg])
    assert cues[0].text == "Welcome to the channel everybody here."
    assert cues[1].text == "Today we talk pipes"

    seg = words_segment("first part here second part", pause_after=2)
    assert [c.text for c in build_cues([seg])] == ["first part here", "second part"]


def test_overflow_prefers_breaking_after_a_comma():
    text = ("When the pumps are ready and tested by the site team, we start routing "
            "the main header lines toward the cooling towers")
    cues = build_cues([words_segment(text)])
    assert cues[0].text.endswith("team,")


def test_segment_without_words_is_used_as_is():
    cues = build_cues([NS(start=1.0, end=3.0, text=" مرحبا بكم", words=None)])
    assert cues == [Cue(1.0, 3.0, "مرحبا بكم")]


def test_fix_timing_removes_overlap_and_extends_short_cues():
    cues = fix_timing([Cue(0.0, 0.3, "a"), Cue(0.8, 5.0, "b"), Cue(4.0, 6.0, "c")])
    assert cues[0].end == pytest.approx(0.75)  # stretched, but stops before the next cue
    assert cues[1].end == pytest.approx(3.95)  # no longer overlaps "c"
    assert cues[2].end == 6.0


def test_wrap_text():
    assert wrap_text("short line") == ["short line"]
    lines = wrap_text("the quick brown fox jumps over the lazy dog near the river bank today")
    assert len(lines) == 2 and abs(len(lines[0]) - len(lines[1])) < 10
    assert len(wrap_text("字" * 60)) == 2


def test_format_timestamp():
    assert format_timestamp(0) == "00:00:00,000"
    assert format_timestamp(3725.5) == "01:02:05,500"
    assert format_timestamp(59.9996) == "00:01:00,000"


def test_srt_output(tmp_path):
    cues = [Cue(1.0, 2.5, "Hello"), Cue(3.0, 4.0, "World")]
    assert to_srt(cues) == ("1\r\n00:00:01,000 --> 00:00:02,500\r\nHello\r\n\r\n"
                            "2\r\n00:00:03,000 --> 00:00:04,000\r\nWorld\r\n")
    assert f"{RLM}أهلا{RLM}" in to_srt([Cue(0, 1, "أهلا")], rtl=True)

    path = tmp_path / "x.srt"
    write_srt(path, cues)
    assert path.read_bytes().startswith(b"\xef\xbb\xbf1\r\n")
