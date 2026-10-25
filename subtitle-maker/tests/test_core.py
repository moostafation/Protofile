import os
import shutil
import subprocess
import threading
from types import SimpleNamespace as NS

import pytest

from subtitle_maker import core, instance, translate
from subtitle_maker.cli import main as cli_main
from subtitle_maker.core import Cancelled, Settings, SubtitleMaker, find_media
from subtitle_maker.subtitles import RLM


class FakeModel:
    """Stands in for faster_whisper.WhisperModel."""

    def __init__(self, language="en"):
        self.language = language
        self.calls = []

    def transcribe(self, path, **kwargs):
        self.calls.append(kwargs)
        lines = [(0.5, 2.0, "Hello and welcome."), (2.5, 5.0, "Today we talk about pipes.")]

        def segments():
            for start, end, text in lines:
                words, t = [], start
                step = (end - start) / len(text.split())
                for w in text.split():
                    words.append(NS(start=t, end=t + step, word=" " + w))
                    t += step
                yield NS(start=start, end=end, text=" " + text, words=words)

        return segments(), NS(language=self.language, duration=6.0)


def fake_translator(texts, source, target, progress=None, cancel=None):
    return [f"[{target}] {t}" for t in texts]


@pytest.fixture
def video(tmp_path):
    return make_video(tmp_path / "my video.mp4")


def make_video(path, audio=True):
    if not shutil.which("ffmpeg"):
        pytest.skip("needs ffmpeg")
    sound = ["-f", "lavfi", "-i", "sine=frequency=440", "-c:a", "aac"] if audio else []
    subprocess.run(["ffmpeg", "-loglevel", "error", "-f", "lavfi", "-i",
                    "color=c=black:s=160x90:r=10", *sound, "-t", "6", "-c:v", "libx264",
                    "-pix_fmt", "yuv420p", str(path)], check=True)
    return path


def make(settings, **kw):
    logs = []
    maker = SubtitleMaker(settings, log=logs.append, model=FakeModel(**kw),
                          translator=fake_translator)
    return maker, logs


def test_transcribe_only(video):
    maker, _ = make(Settings())
    progress = []
    result = maker.process(video, progress=lambda f, t: progress.append(f))
    srt = video.with_suffix(".srt")
    assert result.status == "done" and result.files == [srt]
    text = srt.read_text(encoding="utf-8-sig")
    assert "00:00:00,500 --> " in text and "Hello and welcome." in text
    assert progress[-1] == 1 and progress == sorted(progress)
    assert maker.model.calls[0]["language"] is None


def test_translation_keeps_original_and_marks_rtl(video):
    maker, _ = make(Settings(target="ar"))
    result = maker.process(video)
    primary, original = video.with_suffix(".srt"), video.with_suffix(".en.srt")
    assert result.files == [primary, original]
    assert f"{RLM}[ar] Hello and welcome.{RLM}" in primary.read_text(encoding="utf-8-sig")
    assert "[ar]" not in original.read_text(encoding="utf-8-sig")


def test_no_translation_when_target_is_spoken_language(video):
    maker, _ = make(Settings(target="ar"), language="ar")
    assert maker.process(video).files == [video.with_suffix(".srt")]


def test_failed_translation_falls_back_to_original(video):
    def broken(*a, **kw):
        raise translate.TranslationError("no internet")
    maker, logs = make(Settings(target="ar"))
    maker.translator = broken
    result = maker.process(video)
    assert result.files == [video.with_suffix(".srt")]
    assert any("Translation failed" in line for line in logs)


def test_existing_subtitles_are_skipped_unless_overwrite(video):
    srt = video.with_suffix(".srt")
    srt.write_text("old")
    maker, _ = make(Settings())
    assert maker.process(video).status == "skipped"
    assert srt.read_text() == "old"
    maker.settings.overwrite = True
    assert maker.process(video).status == "done"


def test_unreadable_or_silent_files(tmp_path):
    maker, _ = make(Settings())
    silent = make_video(tmp_path / "silent.mp4", audio=False)
    assert maker.process(silent).message == "the video has no sound"
    broken = tmp_path / "broken.mp4"
    broken.write_bytes(b"not a video")
    with pytest.raises(RuntimeError, match="can't read this file"):
        maker.process(broken)


def test_cancel(video):
    cancel = threading.Event()
    cancel.set()
    maker, _ = make(Settings())
    with pytest.raises(Cancelled):
        maker.process(video, cancel=cancel)


def test_embed_creates_mkv_with_default_track(video):
    import av
    maker, logs = make(Settings(target="ar", embed=True))
    result = maker.process(video)
    mkv = video.with_name("my video.subtitled.mkv")
    assert mkv in result.files, logs
    with av.open(str(mkv)) as c:
        subs = c.streams.subtitles
        assert [s.metadata.get("language") for s in subs] == ["ara", "eng"]
        assert len(c.streams.video) == 1 and len(c.streams.audio) == 1
    probe = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "s",
                            "-show_entries", "stream_disposition=default", "-of", "csv=p=0",
                            str(mkv)], capture_output=True, text=True).stdout.split()
    assert probe == ["1", "0"]


def test_find_media(tmp_path):
    (tmp_path / "sub").mkdir()
    for name in ["a.mp4", "sub/b.MKV", "c.txt", "a.subtitled.mkv", "d.srt"]:
        (tmp_path / name).write_bytes(b"")
    found = [p.relative_to(tmp_path).as_posix() for p in find_media([tmp_path])]
    assert found == ["a.mp4", "sub/b.MKV"]


def test_translate_batches_and_falls_back_per_line(monkeypatch):
    requests = []

    class FakeGoogle:
        def __init__(self, source, target):
            self.source = source

        def get_supported_languages(self, as_dict=False):
            return {"english": "en", "arabic": "ar"}

        def translate(self, text):
            requests.append(text)
            if "MERGE" in text and "\n" in text:
                return text.replace("\n", " ")  # Google glued lines together
            return text.upper()

    import deep_translator
    monkeypatch.setattr(deep_translator, "GoogleTranslator", FakeGoogle)

    assert translate.google_translate(["one", "two"], "en", "ar") == ["ONE", "TWO"]
    assert requests == ["one\ntwo"]

    requests.clear()
    assert translate.google_translate(["MERGE a", "b"], "xx", "ar") == ["MERGE A", "B"]
    assert requests == ["MERGE a\nb", "MERGE a", "b"]


def test_chunks_respect_limit():
    chunks = list(translate._chunks(["x" * 1500] * 7, limit=4000))
    assert [len(c) for c in chunks] == [2, 2, 2, 1]


def test_cli(video, monkeypatch, capsys):
    monkeypatch.setattr(SubtitleMaker, "load_model",
                        lambda self, device=None: setattr(self, "model", FakeModel()))
    monkeypatch.setattr(core, "google_translate", fake_translator)
    with pytest.raises(SystemExit) as exit_info:
        cli_main([str(video.parent), "--to", "ar", "--no-original"])
    assert exit_info.value.code == 0
    assert "[ar] Hello" in video.with_suffix(".srt").read_text(encoding="utf-8-sig")
    assert not video.with_suffix(".en.srt").exists()
    assert "done" in capsys.readouterr().out


def test_single_instance_hands_files_over(monkeypatch):
    monkeypatch.setattr(instance, "PORT", 47392)
    server = instance.claim()
    assert server is not None
    try:
        assert instance.claim() is None  # second process can't bind
        got = []
        done = threading.Event()
        instance.serve(server, lambda paths, start: (got.append((paths, start)), done.set()))
        assert instance.send(["videos/a.mp4", "b.mkv"], True)
        assert done.wait(5)
        assert got == [([os.path.abspath("videos/a.mp4"), os.path.abspath("b.mkv")], True)]
    finally:
        server.close()
