"""Language lists and code conversions between Whisper and Google Translate."""

# (Whisper code, display name) - the languages offered in the GUI.
LANGUAGES = [
    ("ar", "Arabic"),
    ("en", "English"),
    ("fr", "French"),
    ("de", "German"),
    ("es", "Spanish"),
    ("it", "Italian"),
    ("pt", "Portuguese"),
    ("ru", "Russian"),
    ("tr", "Turkish"),
    ("fa", "Persian"),
    ("ur", "Urdu"),
    ("hi", "Hindi"),
    ("bn", "Bengali"),
    ("id", "Indonesian"),
    ("ms", "Malay"),
    ("nl", "Dutch"),
    ("pl", "Polish"),
    ("uk", "Ukrainian"),
    ("sv", "Swedish"),
    ("el", "Greek"),
    ("he", "Hebrew"),
    ("ja", "Japanese"),
    ("ko", "Korean"),
    ("zh", "Chinese"),
    ("th", "Thai"),
    ("vi", "Vietnamese"),
    ("ro", "Romanian"),
    ("cs", "Czech"),
    ("hu", "Hungarian"),
    ("sw", "Swahili"),
    ("tl", "Tagalog"),
]

LANGUAGE_NAMES = dict(LANGUAGES)

# Right-to-left scripts: lines get Unicode RLM marks so punctuation lands on
# the correct side in players that don't run a full bidi algorithm.
RTL_LANGUAGES = {"ar", "fa", "ur", "he", "yi", "ps", "sd", "ug"}

# Whisper uses ISO 639-1 codes; Google Translate differs for a few.
_GOOGLE_CODES = {"zh": "zh-CN", "he": "iw", "jw": "jw", "yue": "zh-TW"}


# ISO 639-2/B codes, which MKV track language tags use.
_ISO639_2 = {
    "ar": "ara", "en": "eng", "fr": "fre", "de": "ger", "es": "spa", "it": "ita",
    "pt": "por", "ru": "rus", "tr": "tur", "fa": "per", "ur": "urd", "hi": "hin",
    "bn": "ben", "id": "ind", "ms": "may", "nl": "dut", "pl": "pol", "uk": "ukr",
    "sv": "swe", "el": "gre", "he": "heb", "ja": "jpn", "ko": "kor", "zh": "chi",
    "th": "tha", "vi": "vie", "ro": "rum", "cs": "cze", "hu": "hun", "sw": "swa",
    "tl": "tgl",
}


def language_name(code):
    return LANGUAGE_NAMES.get(code, code)


def google_code(code):
    return _GOOGLE_CODES.get(code, code)


def iso639_2(code):
    return _ISO639_2.get(code, code)


def is_rtl(code):
    return code in RTL_LANGUAGES
