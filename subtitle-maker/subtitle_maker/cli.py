"""Command line entry point. With no files (or --gui) it opens the window."""

import argparse
import os
import shutil
import sys

from .core import DEFAULT_MODEL, MODELS, Settings, SubtitleMaker, find_media


def build_parser():
    p = argparse.ArgumentParser(
        prog="subtitle-maker",
        description="Generate .srt subtitles next to your videos so VLC and "
                    "other players load them automatically.")
    p.add_argument("paths", nargs="*", help="video files or folders")
    p.add_argument("-l", "--language", default="auto",
                   help="spoken language code, e.g. ar, en (default: detect)")
    p.add_argument("-t", "--to", dest="target",
                   help="translate subtitles to this language code, e.g. ar")
    p.add_argument("-m", "--model", default=DEFAULT_MODEL,
                   help="Whisper model: " + ", ".join(m[0] for m in MODELS)
                        + f" (default: {DEFAULT_MODEL})")
    p.add_argument("--device", choices=["auto", "cpu", "cuda"], default="auto")
    p.add_argument("--no-original", action="store_true",
                   help="when translating, don't keep the original-language .srt")
    p.add_argument("--embed", action="store_true",
                   help="also create <name>.subtitled.mkv with the subtitles inside")
    p.add_argument("--overwrite", action="store_true",
                   help="replace existing .srt files instead of skipping")
    p.add_argument("--no-rtl-fix", action="store_true",
                   help="don't add direction marks to Arabic/Hebrew/Persian lines")
    p.add_argument("--gui", action="store_true", help="open the window")
    p.add_argument("--start", action="store_true",
                   help="with --gui: start right away using the saved settings")
    p.add_argument("--install", action="store_true",
                   help="Windows: add the right-click menu and shortcuts")
    p.add_argument("--uninstall", action="store_true",
                   help="Windows: remove the right-click menu and shortcuts")
    return p


def main(argv=None):
    # pythonw.exe / windowed build: no console, so libraries that print
    # would crash, and progress can only be shown in the window.
    windowed = sys.stdout is None
    if windowed:
        sys.stdout = sys.stderr = open(os.devnull, "w")

    args = build_parser().parse_args(argv)
    args.gui = args.gui or windowed

    if args.install or args.uninstall:
        from . import windows
        windows.install() if args.install else windows.uninstall()
        return

    if args.gui or not args.paths:
        from .gui import main as gui_main
        gui_main(args.paths, autostart=args.start)
        return

    sys.exit(run_cli(args))


def run_cli(args):
    for stream in (sys.stdout, sys.stderr):
        stream.reconfigure(errors="replace")  # Windows consoles and Arabic text

    files = find_media(args.paths)
    if not files:
        print("No video files found.")
        return 1

    settings = Settings(
        model=args.model,
        device=args.device,
        language=None if args.language == "auto" else args.language,
        target=args.target,
        keep_original=not args.no_original,
        embed=args.embed,
        overwrite=args.overwrite,
        rtl_fix=not args.no_rtl_fix,
    )
    width = shutil.get_terminal_size().columns - 1

    def line(text, end="\n"):
        # Overwrite the progress line in place (padding works in every console).
        text = f"  {text}"
        if not end:
            text = text[:width]
        print("\r" + text.ljust(width), end=end, flush=True)

    maker = SubtitleMaker(settings, log=line)

    def progress(fraction, text):
        line(f"[{fraction:4.0%}] {text}", end="")

    failed = 0
    for n, video in enumerate(files, 1):
        print(f"\n[{n}/{len(files)}] {video}")
        try:
            result = maker.process(video, progress)
            line(f"{result.status}: {result.message}")
        except KeyboardInterrupt:
            print("\nCancelled.")
            return 130
        except Exception as e:
            failed += 1
            line(f"FAILED: {e}")
    return 1 if failed else 0
