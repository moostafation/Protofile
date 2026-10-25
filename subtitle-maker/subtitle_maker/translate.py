"""Translate subtitle lines with Google Translate (needs internet)."""

import time

from .languages import google_code

CHUNK_CHARS = 4000  # Google rejects requests of 5000+ characters


class TranslationError(Exception):
    pass


def _chunks(texts, limit=CHUNK_CHARS):
    chunk, size = [], 0
    for text in texts:
        if chunk and size + len(text) + 1 > limit:
            yield chunk
            chunk, size = [], 0
        chunk.append(text)
        size += len(text) + 1
    if chunk:
        yield chunk


def _retry(func, *args, attempts=3):
    for attempt in range(attempts):
        try:
            return func(*args)
        except Exception as e:
            if attempt == attempts - 1:
                raise TranslationError(f"{type(e).__name__}: {e}") from e
            time.sleep(2 ** attempt)


def google_translate(texts, source, target, progress=None, cancel=None):
    """Translate a list of single-line strings, keeping the list aligned.

    Lines are sent many at a time (joined by newlines) to keep the number of
    requests low; if Google merges or splits lines in a batch, that batch is
    redone line by line.
    """
    from deep_translator import GoogleTranslator

    supported = set(GoogleTranslator(source="auto", target="en")
                    .get_supported_languages(as_dict=True).values())
    src = google_code(source) if source and google_code(source) in supported else "auto"
    translator = GoogleTranslator(source=src, target=google_code(target))

    texts = [" ".join(t.split()) for t in texts]
    out = []
    for chunk in _chunks(texts):
        if cancel is not None and cancel.is_set():
            break
        result = _retry(translator.translate, "\n".join(chunk)) or ""
        parts = [p.strip() for p in result.split("\n")]
        if len(parts) != len(chunk):
            parts = [(_retry(translator.translate, t) or t).strip() for t in chunk]
        out.extend(parts)
        if progress:
            progress(len(out) / len(texts))
    return out
