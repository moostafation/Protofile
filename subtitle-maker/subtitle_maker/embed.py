"""Mux subtitle files into a copy of the video (MKV) with ffmpeg.

The video and audio are copied as-is, so this takes seconds, not minutes.
"""

import shutil
import subprocess
import sys
from pathlib import Path

from .languages import iso639_2, language_name


class EmbedError(Exception):
    pass


def find_ffmpeg():
    exe = shutil.which("ffmpeg")
    if exe:
        return exe
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return None


def _existing_subtitle_codecs(video):
    """Codec names of the subtitle tracks already in the video, or None if
    the file couldn't be inspected."""
    try:
        import av
        with av.open(str(video)) as container:
            return [s.codec_context.name for s in container.streams.subtitles]
    except Exception:
        return None


def embed_subtitles(video, subtitles, output):
    """Write `output` (.mkv) = `video` + `subtitles`.

    `subtitles` is a list of (srt_path, language_code); the first one becomes
    the default track.
    """
    ffmpeg = find_ffmpeg()
    if not ffmpeg:
        raise EmbedError("ffmpeg was not found (pip install imageio-ffmpeg)")

    existing = _existing_subtitle_codecs(video)
    cmd = [ffmpeg, "-y", "-hide_banner", "-loglevel", "error", "-i", str(video)]
    for srt, _ in subtitles:
        cmd += ["-i", str(srt)]
    cmd += ["-map", "0:v?", "-map", "0:a?"]
    if existing:
        cmd += ["-map", "0:s?", "-map", "0:t?"]
    else:
        existing = []
    for i in range(len(subtitles)):
        cmd += ["-map", str(i + 1)]
    cmd += ["-c", "copy"]

    for i, codec in enumerate(existing):
        if codec == "mov_text":  # MP4-only format, MKV can't hold it
            cmd += [f"-c:s:{i}", "srt"]
        cmd += [f"-disposition:s:{i}", "0"]
    for n, (_, lang) in enumerate(subtitles):
        i = len(existing) + n
        cmd += [f"-metadata:s:s:{i}", f"language={iso639_2(lang)}",
                f"-metadata:s:s:{i}", f"title={language_name(lang)} (auto)",
                f"-disposition:s:{i}", "default" if n == 0 else "0"]
    cmd.append(str(output))

    flags = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0
    proc = subprocess.run(cmd, capture_output=True, text=True, errors="replace",
                          creationflags=flags)
    if proc.returncode != 0:
        Path(output).unlink(missing_ok=True)
        raise EmbedError(proc.stderr.strip() or f"ffmpeg exited with code {proc.returncode}")
