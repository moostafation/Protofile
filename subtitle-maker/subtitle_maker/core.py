"""Speech-to-subtitles pipeline: transcribe -> (translate) -> SRT -> (MKV)."""

import os
import sys
import sysconfig
import time
from dataclasses import dataclass, field
from pathlib import Path

from .embed import embed_subtitles
from .languages import is_rtl, language_name
from .subtitles import Cue, build_cues, write_srt
from .translate import google_translate

os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")

VIDEO_EXTENSIONS = {
    ".mp4", ".mkv", ".avi", ".mov", ".wmv", ".flv", ".webm", ".m4v", ".mpg",
    ".mpeg", ".ts", ".m2ts", ".mts", ".3gp", ".ogv", ".vob",
}
AUDIO_EXTENSIONS = {".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg", ".opus", ".wma"}
MEDIA_EXTENSIONS = VIDEO_EXTENSIONS | AUDIO_EXTENSIONS

# (name, description, approximate download size)
MODELS = [
    ("tiny", "fastest, lowest accuracy", "75 MB"),
    ("base", "fast", "145 MB"),
    ("small", "recommended for most laptops", "480 MB"),
    ("medium", "more accurate, slower", "1.5 GB"),
    ("large-v3-turbo", "very accurate, needs a strong PC or GPU", "1.6 GB"),
    ("large-v3", "most accurate, slowest", "3 GB"),
]
DEFAULT_MODEL = "small"

# Audio is cut into ~30 s pieces at pauses and this many pieces are decoded
# together: about twice as fast as one by one.
BATCH_SIZE = 8


class Cancelled(Exception):
    pass


@dataclass
class Settings:
    model: str = DEFAULT_MODEL
    device: str = "auto"          # auto | cpu | cuda
    language: str = None          # spoken language, None = detect
    target: str = None            # subtitle language, None = same as spoken
    keep_original: bool = True    # also save untranslated subtitles
    embed: bool = False           # also write <name>.subtitled.mkv
    overwrite: bool = False
    rtl_fix: bool = True


@dataclass
class Result:
    status: str                   # "done" | "skipped"
    files: list = field(default_factory=list)
    language: str = None
    message: str = ""


def find_media(paths, recursive=True):
    """Expand files and folders into a sorted list of media files."""
    found = []
    for p in (Path(os.path.abspath(p)) for p in paths):
        if p.is_dir():
            pattern = "**/*" if recursive else "*"
            found += sorted(f for f in p.glob(pattern)
                            if f.suffix.lower() in MEDIA_EXTENSIONS and f.is_file()
                            and not f.stem.endswith(".subtitled"))
        elif p.is_file():
            found.append(p)
    return found


def output_paths(video):
    video = Path(video)
    return {
        "primary": video.with_suffix(".srt"),
        "embedded": video.with_name(video.stem + ".subtitled.mkv"),
    }


_dll_dirs = []


def _use_pip_cuda_libraries():
    """Windows: let CTranslate2 find the cuBLAS/cuDNN DLLs installed by
    install-gpu.bat (pip packages nvidia-cublas-cu12 / nvidia-cudnn-cu12)."""
    if sys.platform != "win32":
        return
    nvidia = Path(sysconfig.get_paths()["purelib"]) / "nvidia"
    for lib in ("cublas", "cudnn"):
        bin_dir = str(nvidia / lib / "bin")
        if os.path.isdir(bin_dir) and bin_dir not in os.environ["PATH"]:
            os.environ["PATH"] = bin_dir + os.pathsep + os.environ["PATH"]
            _dll_dirs.append(os.add_dll_directory(bin_dir))


def _has_audio(video):
    import av
    try:
        with av.open(str(video)) as container:
            return bool(container.streams.audio)
    except Exception as e:
        raise RuntimeError(f"can't read this file as a video ({e})") from e


def _cuda_available():
    try:
        import ctranslate2
        return ctranslate2.get_cuda_device_count() > 0
    except Exception:
        return False


class SubtitleMaker:
    """Processes media files one after another, loading the model once.

    `log(str)` receives human-readable status lines; `model` and `translator`
    can be injected (used by the tests).
    """

    def __init__(self, settings, log=print, model=None, translator=None):
        self.settings = settings
        self.log = log
        self.model = model
        self.pipeline = model  # what .transcribe() is called on
        self.translator = translator or google_translate
        self.device = None

    # -- model -----------------------------------------------------------

    def load_model(self, device=None):
        from faster_whisper import BatchedInferencePipeline, WhisperModel

        _use_pip_cuda_libraries()
        device = device or self.settings.device
        if device == "auto":
            device = "cuda" if _cuda_available() else "cpu"
        compute_type = "float16" if device == "cuda" else "int8"
        cores = os.cpu_count() or 4
        threads = min(cores, max(4, cores // 2))

        size = dict((m[0], m[2]) for m in MODELS).get(self.settings.model)
        self.log(f"Loading model '{self.settings.model}' on {device.upper()}"
                 + (f" (first run downloads ~{size}, please wait)" if size else ""))
        try:
            self.model = WhisperModel(self.settings.model, device=device,
                                      compute_type=compute_type, cpu_threads=threads)
        except Exception as e:
            if device == "cuda" and self.settings.device == "auto":
                self.log(f"GPU not usable ({e}); using CPU")
                return self.load_model("cpu")
            raise RuntimeError(
                f"Could not load the '{self.settings.model}' model ({e}). The first "
                "run needs internet to download it; after that it works offline.") from e
        self.pipeline = BatchedInferencePipeline(self.model)
        self.device = device

    # -- pipeline --------------------------------------------------------

    def process(self, video, progress=None, cancel=None):
        """Create subtitles for one file. `progress(fraction, text)`."""
        video = Path(video)
        s = self.settings
        out = output_paths(video)
        progress = progress or (lambda f, t: None)

        if out["primary"].exists() and not s.overwrite:
            return Result("skipped", message=f"{out['primary'].name} already exists")

        if not _has_audio(video):
            return Result("skipped", message="the video has no sound")

        started = time.monotonic()
        if self.model is None:
            progress(0, "Loading model…")
            self.load_model()

        # Share of the progress bar for each stage.
        translate_share = 0.1 if s.target else 0
        embed_share = 0.05 if s.embed else 0
        transcribe_share = 1 - translate_share - embed_share

        cues, language = self._transcribe(
            video, lambda f, t: progress(f * transcribe_share, t), cancel)
        if not cues:
            return Result("skipped", language=language, message="no speech found")
        self.log(f"Spoken language: {language_name(language)} — {len(cues)} subtitles")

        tracks = [(cues, language)]  # (cues, language), first = primary
        if s.target and s.target != language:
            progress(transcribe_share, f"Translating to {language_name(s.target)}…")
            try:
                translated = self.translator(
                    [c.text for c in cues], language, s.target,
                    progress=lambda f: progress(transcribe_share + f * translate_share,
                                                f"Translating to {language_name(s.target)}…"),
                    cancel=cancel)
                _check(cancel)
                translated = list(translated) + [None] * (len(cues) - len(translated))
                tracks = [([Cue(c.start, c.end, t or c.text) for c, t in zip(cues, translated)],
                           s.target)]
                if s.keep_original:
                    tracks.append((cues, language))
            except Cancelled:
                raise
            except Exception as e:
                self.log(f"Translation failed ({e}). Saving the original-language "
                         "subtitles instead — check the internet connection.")

        files = []
        for i, (track_cues, lang) in enumerate(tracks):
            path = out["primary"] if i == 0 else video.with_suffix(f".{lang}.srt")
            write_srt(path, track_cues, rtl=s.rtl_fix and is_rtl(lang))
            files.append((path, lang))
            self.log(f"Saved {path.name}")

        if s.embed:
            progress(1 - embed_share, "Embedding subtitles into MKV…")
            if out["embedded"].exists() and not s.overwrite:
                self.log(f"{out['embedded'].name} already exists, not embedding")
            else:
                try:
                    embed_subtitles(video, files, out["embedded"])
                    files.append((out["embedded"], None))
                    self.log(f"Saved {out['embedded'].name}")
                except Exception as e:
                    self.log(f"Could not create MKV: {e}")

        progress(1, "Done")
        took = time.monotonic() - started
        return Result("done", files=[f for f, _ in files], language=language,
                      message=f"finished in {_clock(took)}")

    def _transcribe(self, video, progress, cancel):
        try:
            return self._run_whisper(video, progress, cancel)
        except Cancelled:
            raise
        except Exception as e:
            # Missing CUDA/cuDNN DLLs only show up once decoding starts.
            if self.device != "cuda":
                raise
            self.log(f"GPU failed ({e}); switching to CPU")
            self.load_model("cpu")
            return self._run_whisper(video, progress, cancel)

    def _run_whisper(self, video, progress, cancel):
        s = self.settings
        progress(0, "Reading audio…")
        segments, info = self.pipeline.transcribe(
            str(video),
            language=s.language,
            word_timestamps=True,
            vad_filter=True,                   # skip silence/music, fewer hallucinations
            condition_on_previous_text=False,  # avoids repeated-line loops
            batch_size=BATCH_SIZE,
            # Beam search is ~2x slower for a small accuracy gain: worth it
            # only on a graphics card.
            beam_size=5 if self.device == "cuda" else 1,
        )
        duration = info.duration or 0
        progress(0, "Transcribing… (the first update can take a minute)")
        started = time.monotonic()

        def watched():
            for seg in segments:
                _check(cancel)
                if duration:
                    done = min(seg.end / duration, 1)
                    left = _time_left(time.monotonic() - started, done)
                    progress(done, f"Transcribing {_clock(seg.end)} / {_clock(duration)}{left}")
                yield seg

        return build_cues(watched()), info.language


def _check(cancel):
    if cancel is not None and cancel.is_set():
        raise Cancelled()


def _time_left(elapsed, fraction):
    if fraction < 0.02 or elapsed < 5:
        return ""
    minutes = round(elapsed * (1 - fraction) / fraction / 60)
    return " — less than a minute left" if minutes < 1 else f" — about {minutes} min left"


def _clock(seconds):
    seconds = int(seconds)
    h, rem = divmod(seconds, 3600)
    m, s = divmod(rem, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"
