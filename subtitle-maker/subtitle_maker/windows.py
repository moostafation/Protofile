"""Windows integration: right-click menu on videos/folders and shortcuts.

Everything goes under HKEY_CURRENT_USER, so no administrator rights are
needed and other users of the PC are not affected.
"""

import os
import subprocess
import sys
import sysconfig
from pathlib import Path

from .core import VIDEO_EXTENSIONS

VERB = "SubtitleMaker"
MENU_TEXT = "Generate subtitles"
SHORTCUT_NAME = "Subtitle Maker.lnk"


def _launcher():
    """(executable, arguments, icon) that start the app without a console."""
    if getattr(sys, "frozen", False):  # PyInstaller build
        return sys.executable, "", f"{sys.executable},0"
    pythonw = Path(sys.executable).with_name("pythonw.exe")
    if not pythonw.exists():
        pythonw = Path(sys.executable)
    icon = f"{pythonw},0"
    # The launcher pip creates for the gui-script entry point.
    gui_exe = Path(sysconfig.get_path("scripts")) / "subtitle-maker-gui.exe"
    if gui_exe.exists():
        return str(gui_exe), "", icon
    # -P keeps Python from importing modules out of the video's folder.
    safe = "-P " if sys.version_info >= (3, 11) else ""
    return str(pythonw), f"{safe}-m subtitle_maker", icon


def _menu_keys():
    base = r"Software\Classes"
    keys = [rf"{base}\SystemFileAssociations\{ext}\shell\{VERB}"
            for ext in sorted(VIDEO_EXTENSIONS)]
    keys += [rf"{base}\Directory\shell\{VERB}"]
    return keys


def _set_menu(key, command, icon):
    import winreg
    with winreg.CreateKey(winreg.HKEY_CURRENT_USER, key) as k:
        winreg.SetValueEx(k, None, 0, winreg.REG_SZ, MENU_TEXT)
        winreg.SetValueEx(k, "Icon", 0, winreg.REG_SZ, icon)
        # Show the entry even when more than 15 files are selected.
        winreg.SetValueEx(k, "MultiSelectModel", 0, winreg.REG_SZ, "Player")
    with winreg.CreateKey(winreg.HKEY_CURRENT_USER, key + r"\command") as k:
        winreg.SetValueEx(k, None, 0, winreg.REG_SZ, command)


def _delete_tree(key):
    import winreg
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, key) as k:
            while True:
                try:
                    child = winreg.EnumKey(k, 0)
                except OSError:
                    break
                _delete_tree(key + "\\" + child)
        winreg.DeleteKey(winreg.HKEY_CURRENT_USER, key)
    except FileNotFoundError:
        pass


def _powershell(script, env):
    subprocess.run(
        ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
        env={**os.environ, **env}, check=True, capture_output=True,
        creationflags=subprocess.CREATE_NO_WINDOW)


# Paths go through environment variables so quotes/spaces in them can't
# break the PowerShell command.
_MAKE_SHORTCUTS = """
foreach ($folder in 'Desktop', 'Programs') {
    $path = Join-Path ([Environment]::GetFolderPath($folder)) $env:SM_NAME
    $s = (New-Object -ComObject WScript.Shell).CreateShortcut($path)
    $s.TargetPath = $env:SM_TARGET
    $s.Arguments = $env:SM_ARGS
    $s.WorkingDirectory = $env:SM_DIR
    $s.IconLocation = $env:SM_ICON
    $s.Save()
}
"""

_REMOVE_SHORTCUTS = """
foreach ($folder in 'Desktop', 'Programs') {
    $path = Join-Path ([Environment]::GetFolderPath($folder)) $env:SM_NAME
    if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path }
}
"""


def install():
    if sys.platform != "win32":
        print("The right-click menu is only available on Windows.")
        return
    exe, args, icon = _launcher()
    command = " ".join(filter(None, [f'"{exe}"', args, '--gui --start "%1"']))
    for key in _menu_keys():
        _set_menu(key, command, icon)
    print(f'Added "{MENU_TEXT}" to the right-click menu of videos and folders.')

    try:
        _powershell(_MAKE_SHORTCUTS, {
            "SM_NAME": SHORTCUT_NAME, "SM_TARGET": exe, "SM_ARGS": args,
            "SM_DIR": str(Path.home()), "SM_ICON": icon})
        print("Added Subtitle Maker to the Desktop and the Start menu.")
    except (OSError, subprocess.CalledProcessError) as e:
        print(f"Could not create shortcuts: {e}")


def uninstall():
    if sys.platform != "win32":
        return
    for key in _menu_keys():
        _delete_tree(key)
    print("Removed the right-click menu entries.")
    try:
        _powershell(_REMOVE_SHORTCUTS, {"SM_NAME": SHORTCUT_NAME})
        print("Removed the shortcuts.")
    except (OSError, subprocess.CalledProcessError) as e:
        print(f"Could not remove shortcuts: {e}")
