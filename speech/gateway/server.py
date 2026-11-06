"""OpenAI-compatible speech gateway for Open WebUI.

One base URL for every engine in the speech stack; the request's `model`
picks the backend:

- POST /v1/audio/transcriptions: the upload is converted to 16 kHz mono PCM
  with ffmpeg and sent to a Wyoming speech-to-text server.
- POST /v1/audio/speech: the JSON body is forwarded to an OpenAI-compatible
  text-to-speech server, with `model` rewritten and optional extra fields
  (such as Supertonic's `lang`) added.
  Engines in WYOMING_TTS_BACKENDS (such as Piper) are synthesised over
  Wyoming instead and returned as WAV.
- GET /v1/audio/voices: the voices of one engine (?model=) or of all.
- TTS_ROUTES: virtual engines (e.g. "assistant") that forward each request to
  a real engine and voice chosen by the language of the text.
- GET /: the voice tester page (tester.html), which uses the routes above.
- AUDIOCPP_URL: text-to-speech engines are discovered from that audio.cpp
  server's /v1/models (every `tts` model becomes an engine of the same name)
  and their voices from the GGUF files under AUDIOCPP_MODELS_DIR (embedded
  `voices/<name>.bin` / `voice_styles/<name>.json`). TTS_BACKENDS entries of
  the same name are merged on top (e.g. voice_options); others stay static.
- STT engines (STT_BACKENDS): a string is a Wyoming server "host:port"; an
  object {"url": ".../v1", "model": "...", "language": "..."} is an OpenAI-style
  HTTP /audio/transcriptions server (audio.cpp), sent a `language` field.
- STT model "auto" (STT_AUTO {"primary", "greek", "greek_fallback"}): the
  primary (CPU) and the Greek engine (language "el", GPU) start together. A
  clear English primary transcript is returned at once and the Greek call is
  cancelled; a Greek (or unclear) one waits for the Greek engine. If that
  fails or exceeds STT_GREEK_TIMEOUT_S, greek_fallback (chunked) answers, and
  then the primary text. A `language` of el/en runs only that engine. The same
  "auto" engine is also served over Wyoming on WYOMING_PORT (10300).
- STT model "auto" with STT_AUTO {"detector": "whisper-lid", "engine": "cohere",
  "languages": ["el", "en"], "fallback": "parakeet"}: a small CPU Whisper
  int8 language-ID model (lid.py, in this process) decides el or en from the
  first seconds of audio, then `engine` transcribes with exactly that language
  hint. A client `language` skips detection. If detection fails the
  primary/greek logic above runs with `fallback` as the primary; if the engine
  fails, `fallback` alone answers. STT_SAVE_DIR / STT_SAVE_MAX keep the first
  few requests (WAV + JSON sidecar) to check real recordings.

Backends come from STT_BACKENDS, TTS_BACKENDS and WYOMING_TTS_BACKENDS (JSON
objects, see docker-compose.yml). There is no authentication: Traefik serves
the tester over the VPN, and Home Assistant / Open WebUI reach the API on the
internal speech network.
"""

import asyncio
import contextvars
import io
import json
import logging
import os
import re
import time
import unicodedata
import wave
from concurrent.futures import ThreadPoolExecutor
from functools import lru_cache, partial
from pathlib import Path

import aiohttp
from aiohttp import web
from wyoming.asr import Transcribe, Transcript
from wyoming.audio import AudioChunk, AudioStart, AudioStop
from wyoming.client import AsyncTcpClient
from wyoming.audio import AudioChunkConverter
from wyoming.event import Event
from wyoming.info import AsrModel, AsrProgram, Attribution, Describe, Info
from wyoming.server import AsyncEventHandler, AsyncServer
from wyoming.tts import Synthesize, SynthesizeVoice

_LOGGER = logging.getLogger("speech-gateway")

STT_BACKENDS = json.loads(os.environ["STT_BACKENDS"])
TTS_BACKENDS = json.loads(os.environ["TTS_BACKENDS"])
# {"piper": {"address": "wyoming-piper:10200", "languages": ["en", "el"]}}:
# voices are read from the server's Describe info, limited to `languages`.
WYOMING_TTS_BACKENDS = json.loads(os.environ.get("WYOMING_TTS_BACKENDS") or "{}")
TESTER_PAGE = Path(__file__).with_name("tester.html")
# {"primary": "parakeet", "greek": "parakeet-greek"}: exposed as STT model "auto".
STT_AUTO = json.loads(os.environ.get("STT_AUTO") or "{}")
if STT_AUTO:
    STT_BACKENDS = {"auto": None, **STT_BACKENDS}
# Recording capture (see _save_recording): the first STT_SAVE_MAX requests
# are kept in STT_SAVE_DIR as 16 kHz WAV plus a JSON sidecar.
STT_SAVE_DIR = os.environ.get("STT_SAVE_DIR", "")
STT_SAVE_MAX = int(os.environ.get("STT_SAVE_MAX") or 10)
# Per-request details (detected language, timings) filled in by _stt for the
# log line and the recording sidecar.
_stt_meta: contextvars.ContextVar = contextvars.ContextVar("stt_meta", default=None)
WYOMING_PORT = int(os.environ.get("WYOMING_PORT") or 0)
_GREEK = re.compile(r"[\u0370-\u03ff\u1f00-\u1fff]")
_LATIN = re.compile(r"[A-Za-z]")
STT_DEFAULT = os.environ.get("STT_DEFAULT") or next(iter(STT_BACKENDS))
TTS_DEFAULT_ENV = os.environ.get("TTS_DEFAULT", "")
AUDIOCPP_URL = (os.environ.get("AUDIOCPP_URL") or "").rstrip("/")
AUDIOCPP_MODELS_DIR = os.environ.get("AUDIOCPP_MODELS_DIR", "/models")
# Families that take a `language` hint and speak Greek and English.
AUTO_LANGUAGE_FAMILIES = set(
    (os.environ.get("AUTO_LANGUAGE_FAMILIES")
     or "supertonic,omnivoice,voxcpm2,voxcpm1,chatterbox,chatterbox_multilingual").split(","))
DISCOVERY_TTL = float(os.environ.get("DISCOVERY_TTL", "30"))
# Fallback engine when a text-to-speech request fails (e.g. audio.cpp refused
# to load a model because the GPU is full): {"model": "...", "voice": "..."}.
TTS_FALLBACK = json.loads(os.environ.get("TTS_FALLBACK") or "{}")
# Virtual engines that pick a real engine and voice by the language of the
# text: {"assistant": {"en": {"model": "jarvis", "voice": "jarvis"},
# "el": {"model": "pocket-greek", "voice": "spyros"}}}. The whole request goes
# by the majority script (Greek letters vs Latin); "en" is the default entry.
TTS_ROUTES = json.loads(os.environ.get("TTS_ROUTES") or "{}")
# Warmer (see _warmer): keeps WARM_LLM loaded in the llama.cpp router and
# WARM_TTS in audio.cpp while the GPU is free for them.
LLAMA_URL = (os.environ.get("LLAMA_URL") or "").rstrip("/")
LLAMA_API_KEY = os.environ.get("LLAMA_API_KEY", "")
WARM_LLM = os.environ.get("WARM_LLM", "")
WARM_TTS = os.environ.get("WARM_TTS", "")
WARM_STT = os.environ.get("WARM_STT", "")
WARM_TTS_IDLE = float(os.environ.get("WARM_TTS_IDLE", "600"))
WARM_INTERVAL = float(os.environ.get("WARM_INTERVAL", "15"))
# While this file exists the warmer does nothing (benchmark runs need the
# router and audio.cpp to themselves): docker exec speech-gateway touch it.
WARM_PAUSE_FILE = os.environ.get("WARM_PAUSE_FILE", "/tmp/warmer.pause")
# audio.cpp models parked (replaced by PARK_TTS, the smallest) while another
# llama.cpp model than WARM_LLM needs the card.
HEAVY_TTS = set((os.environ.get("HEAVY_TTS") or "jarvis,voxcpm2,omnivoice").split(","))
# Comma-separated: audio.cpp keeps up to two models, so parking loads one small
# model per slot (phonon, then kokoro) to push Jarvis and the STT model out.
PARK_TTS = os.environ.get("PARK_TTS", "phonon")
_last_tts = {"at": 0.0}
_warm_failed: dict = {}  # model -> llama.cpp state in which its load failed
# Families that clone a reference: they also get the server's voice library.
CLONE_FAMILIES = set(
    (os.environ.get("CLONE_FAMILIES")
     or "voxcpm2,voxcpm1,omnivoice,chatterbox,chatterbox_multilingual,pocket_tts").split(","))
_VOICE_NAME = re.compile(rb"(?:voices|voice_styles|speakers)/([A-Za-z0-9_.-]+?)\.(?:bin|json|pt|safetensors)")
_discovered: dict = {"at": 0.0, "engines": {}, "stt": set()}
# OpenAI model names some clients only offer (e.g. Hermes' dashboard selects):
# mapped to our engines so a client that saves one of them keeps working.
STT_ALIASES = json.loads(os.environ.get("STT_ALIASES") or "{}") or {
    name: "auto" for name in ("whisper-1", "gpt-4o-mini-transcribe", "gpt-4o-transcribe", "gpt-transcribe")}
TTS_ALIASES = json.loads(os.environ.get("TTS_ALIASES") or "{}") or {
    name: "assistant" for name in ("tts-1", "tts-1-hd", "gpt-4o-mini-tts")}
_voice_cache: dict = {}
TIMEOUT = float(os.environ.get("BACKEND_TIMEOUT", "120"))

RATE, WIDTH, CHANNELS = 16000, 2, 1
CHUNK_BYTES = RATE * WIDTH // 10  # 100 ms


def _error(status: int, message: str) -> web.Response:
    return web.json_response(
        {"error": {"message": message, "type": "invalid_request_error"}},
        status=status,
    )


async def _to_pcm(audio: bytes) -> bytes:
    """Decode any container/codec ffmpeg knows to 16 kHz mono s16le."""
    proc = await asyncio.create_subprocess_exec(
        "ffmpeg", "-nostdin", "-loglevel", "error", "-i", "pipe:0",
        "-f", "s16le", "-ac", str(CHANNELS), "-ar", str(RATE), "pipe:1",
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    pcm, err = await proc.communicate(audio)
    if proc.returncode != 0:
        raise ValueError(err.decode(errors="replace").strip() or "ffmpeg failed")
    return pcm


def _level_db(pcm: bytes) -> tuple[float, float]:
    """Peak and RMS level of 16-bit PCM in dBFS (silence about -90)."""
    import array, math
    samples = array.array("h", pcm[: len(pcm) // 2 * 2])
    if not samples:
        return (-120.0, -120.0)
    peak = max(abs(v) for v in samples) or 1
    rms = math.sqrt(sum(v * v for v in samples) / len(samples)) or 1
    return (20 * math.log10(peak / 32768), 20 * math.log10(rms / 32768))


async def _transcribe(address: str, pcm: bytes, language: str | None) -> str:
    host, port = address.rsplit(":", 1)
    async with AsyncTcpClient(host, int(port)) as client:
        await client.write_event(Transcribe(language=language).event())
        await client.write_event(
            AudioStart(rate=RATE, width=WIDTH, channels=CHANNELS).event()
        )
        for start in range(0, len(pcm), CHUNK_BYTES):
            chunk = AudioChunk(
                rate=RATE, width=WIDTH, channels=CHANNELS,
                audio=pcm[start:start + CHUNK_BYTES],
            )
            await client.write_event(chunk.event())
        await client.write_event(AudioStop().event())
        while True:
            event = await client.read_event()
            if event is None:
                raise ConnectionError("Wyoming server closed the connection")
            if Transcript.is_type(event.type):
                return Transcript.from_event(event).text


def _mostly_greek(text: str) -> bool:
    return len(_GREEK.findall(text)) > len(_LATIN.findall(text))


# English function words: a Latin-letter transcript with almost none of them
# is usually Greek speech that the multilingual model spelled out in Latin
# (often Spanish-looking), not English.
_EN_WORDS = set("""the and but with from are was were been this that these those what
when where who why how which can could will would should does did not yes please
hello thanks thank okay remind turn add call tell show today tomorrow time there
here have has had just about like want need you your my it's i'm don't is it of
for on at by be am we they he she him her them our their its into than then""".split())
# Words Spanish (and other Latin-script languages Parakeet falls back to)
# share with English; they say nothing about the language.
_AMBIGUOUS = set("a i me no do to in an or so se de la el en un es".split())
GREEK_CHUNK_S = float(os.environ.get("STT_GREEK_CHUNK_SECONDS", "8"))
# Longest wait for the GPU Greek engine before the fallback answers.
GREEK_TIMEOUT_S = float(os.environ.get("STT_GREEK_TIMEOUT_S", "8"))


def _english_score(text: str) -> float:
    words = [w for w in re.findall(r"[A-Za-z']+", text.lower()) if w not in _AMBIGUOUS]
    if not words:
        return 0.0
    hits = sum(w in _EN_WORDS for w in words)
    # Short utterances need at least one real English word; longer ones a share.
    return hits / len(words) if hits else 0.0


def _split_pcm(pcm: bytes, max_s: float) -> list[bytes]:
    """Cut PCM into pieces of at most max_s seconds, at the quietest 0.2 s
    window in the last third of each piece, so words are not split."""
    import array
    step = int(RATE * max_s) * WIDTH
    if len(pcm) <= step:
        return [pcm]
    win = int(RATE * 0.2) * WIDTH
    parts, start = [], 0
    while len(pcm) - start > step:
        lo, hi = start + step * 2 // 3, start + step
        best, cut = None, hi
        for pos in range(lo, hi - win, win // 2):
            seg = array.array("h", pcm[pos:pos + win])
            energy = sum(abs(v) for v in seg[::8])
            if best is None or energy < best:
                best, cut = energy, pos + win // 2
        cut -= cut % WIDTH
        parts.append(pcm[start:cut])
        start = cut
    parts.append(pcm[start:])
    return parts


async def _transcribe_greek(address: str, pcm: bytes) -> str:
    """Greek Parakeet returns nothing for clips longer than ~10 s: send pieces."""
    texts = []
    for part in _split_pcm(pcm, GREEK_CHUNK_S):
        text = (await _transcribe(address, part, "el")).strip()
        if text:
            texts.append(text)
    return " ".join(texts)


def _wav(pcm: bytes) -> bytes:
    out = io.BytesIO()
    with wave.open(out, "wb") as wav:
        wav.setframerate(RATE)
        wav.setsampwidth(WIDTH)
        wav.setnchannels(CHANNELS)
        wav.writeframes(pcm)
    return out.getvalue()


def _is_http(name: str) -> bool:
    return isinstance(STT_BACKENDS.get(name), dict)


async def _transcribe_http(cfg: dict, pcm: bytes, language: str | None,
                           timeout: float | None = None) -> str:
    """POST the clip to an OpenAI-style /audio/transcriptions server."""
    form = aiohttp.FormData()
    form.add_field("file", _wav(pcm), filename="audio.wav", content_type="audio/wav")
    form.add_field("model", cfg["model"])
    language = language or cfg.get("language")
    if language:
        form.add_field("language", language)
    async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(
            total=timeout or TIMEOUT, sock_connect=5)) as session:
        async with session.post(f"{cfg['url'].rstrip('/')}/audio/transcriptions",
                                data=form) as resp:
            body = await resp.read()
            if resp.status != 200:
                raise RuntimeError(f"HTTP {resp.status}: {body[:200].decode(errors='replace')}")
    try:
        data = json.loads(body)
    except json.JSONDecodeError:
        return body.decode(errors="replace").strip()
    if isinstance(data, dict) and "error" in data:
        raise RuntimeError(str(data["error"])[:200])
    return str(data.get("text", "")).strip()


async def _engine(name: str, pcm: bytes, language: str | None) -> str:
    """One engine, whatever its kind. Greek Wyoming engines get chunked audio."""
    backend = STT_BACKENDS[name]
    if isinstance(backend, dict):
        return await _transcribe_http(backend, pcm, language)
    if name in (STT_AUTO.get("greek"), STT_AUTO.get("greek_fallback")):
        return await _transcribe_greek(backend, pcm)
    return await _transcribe(backend, pcm, language)


async def _greek_engine(pcm: bytes, cfg: dict | None = None) -> str:
    """The Greek engine with its timeout; on failure the fallback engine."""
    cfg = cfg or STT_AUTO
    greek, fallback = cfg["greek"], cfg.get("greek_fallback")
    try:
        if _is_http(greek):
            return await asyncio.wait_for(_engine(greek, pcm, "el"), GREEK_TIMEOUT_S)
        return await _engine(greek, pcm, "el")
    except Exception as err:
        if not fallback:
            raise
        _LOGGER.warning("STT auto: %s failed (%s: %s), using %s", greek,
                        type(err).__name__, err, fallback)
        return await _engine(fallback, pcm, "el")


def _lang(language: str | None) -> str | None:
    return language.lower().replace("_", "-").split("-")[0] if language else None


async def _stt(model: str, pcm: bytes, language: str | None) -> str:
    """Transcribe with one engine, or pick the engine(s) by language for "auto"."""
    if model != "auto":
        return await _engine(model, pcm, language)
    if "detector" in STT_AUTO:
        return await _stt_detect(pcm, language)
    if "engine" in STT_AUTO:
        return await _stt_single(pcm, language)
    return await _stt_parallel(pcm, language, STT_AUTO)


async def _stt_parallel(pcm: bytes, language: str | None, cfg: dict) -> str:
    """cfg {"primary", "greek", "greek_fallback"}: the CPU primary and the
    Greek engine run together; the primary's text decides which one answers."""
    primary, greek = cfg["primary"], cfg.get("greek")
    if not greek:
        return await _engine(primary, pcm, language)
    lang = _lang(language)
    if lang and lang != "el":  # a stated non-Greek language: the primary alone
        return await _engine(primary, pcm, language)
    if lang == "el":  # stated Greek: the Greek engine; the primary if all fail
        try:
            return await _greek_engine(pcm, cfg)
        except Exception as err:
            _LOGGER.warning("STT auto: Greek engines failed (%s), using %s", err, primary)
            return await _engine(primary, pcm, language)
    # Both start now; the GPU Greek engine runs while the CPU engine works.
    greek_task = asyncio.ensure_future(_greek_engine(pcm, cfg))
    try:
        text = await _engine(primary, pcm, language)
    except BaseException:
        greek_task.cancel()
        raise
    # Clear English (enough English function words) stays with the primary
    # model; Greek letters, or Latin text that is not English (Greek heard as
    # Spanish/Finnish-looking words), wait for the Greek engine.
    if not _mostly_greek(text) and _english_score(text) >= 0.2:
        greek_task.cancel()
        _LOGGER.info("STT auto: English, used %s: %r", primary, text[:50])
        return text
    try:
        greek_text = await greek_task
    except Exception as err:
        _LOGGER.warning("STT auto: Greek engines failed (%s), used %s: %r",
                        err, primary, text[:50])
        return text
    if greek_text and _mostly_greek(greek_text):
        _LOGGER.info("STT auto: Greek, used %s (%s gave %r)", greek, primary, text[:40])
        return greek_text
    _LOGGER.info("STT auto: not Greek (greek gave %r), used %s: %r",
                 greek_text[:30], primary, text[:50])
    return text


_lid = None
_lid_pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="lid")


def _lid_model():
    """Load the language-ID model once (first use), inside the LID thread."""
    global _lid
    if _lid is None:
        from lid import LanguageID
        path = STT_AUTO.get("model") or "whisper-base"
        _lid = LanguageID(path if path.startswith("/") else f"/lid/{path}",
                          int(STT_AUTO.get("threads") or 2))
    return _lid


def _detect_sync(pcm: bytes, languages: list[str], seconds: float) -> dict:
    # el_bias: added to el's log-probability. Measured on FLEURS with Whisper
    # base, English clips score en-el >= +5.7 and Greek clips <= +2.0, so a
    # bias of 4 puts the boundary in the gap (README).
    return _lid_model().detect(pcm, languages, seconds,
                               float(STT_AUTO.get("el_bias", 0)))


async def _detect_language(pcm: bytes, languages: list[str]) -> dict:
    """Probabilities over `languages` from the first STT_AUTO["seconds"] s."""
    seconds = float(STT_AUTO.get("seconds") or 15)
    return await asyncio.wait_for(
        asyncio.get_running_loop().run_in_executor(
            _lid_pool, _detect_sync, pcm, languages, seconds),
        float(STT_AUTO.get("detect_timeout_s") or 10))


async def _stt_detect(pcm: bytes, language: str | None) -> str:
    """STT_AUTO {"detector", "engine", "languages", "fallback"}: the language
    comes from the CPU language-ID model, then `engine` (Cohere Transcribe)
    is told exactly that language. Cohere translates into whatever language it
    is hinted, so it never gets a guess. A client language skips detection."""
    engine = STT_AUTO["engine"]
    languages = STT_AUTO.get("languages") or ["el", "en"]
    fallback = STT_AUTO.get("fallback")
    meta = _stt_meta.get() if _stt_meta.get() is not None else {}
    lang = _lang(language)
    if lang:
        meta["language"], meta["language_source"] = lang, "client"
    else:
        started = time.perf_counter()
        try:
            probs = await _detect_language(pcm, languages)
        except Exception as err:
            meta["detect_error"] = f"{type(err).__name__}: {err}"
            _LOGGER.warning("STT auto: language detection failed (%s: %s)%s",
                            type(err).__name__, err,
                            f", using {fallback}" if fallback else "")
            if not fallback:
                raise
            return await _stt_parallel(pcm, None, {"primary": fallback, "greek": engine})
        meta["detect_ms"] = round((time.perf_counter() - started) * 1000)
        meta["probabilities"] = {k: round(v, 4) for k, v in probs.items()}
        lang = meta["language"] = max(probs, key=probs.get)
        meta["language_source"] = "detector"
    started = time.perf_counter()
    try:
        text = await _engine(engine, pcm, lang)
    except Exception as err:
        meta["engine_error"] = f"{type(err).__name__}: {err}"
        _LOGGER.warning("STT auto: %s (%s) failed (%s: %s)%s", engine, lang,
                        type(err).__name__, err,
                        f", using {fallback}" if fallback else "")
        if not fallback:
            raise
        meta["engine"] = fallback
        return await _engine(fallback, pcm, None)
    meta["engine"] = engine
    meta["engine_ms"] = round((time.perf_counter() - started) * 1000)
    _LOGGER.info("STT auto: %s (%s, %s) detect %s ms, %s %d ms: %r", lang,
                 meta["language_source"],
                 " ".join(f"{k}={v:.2f}" for k, v in meta.get("probabilities", {}).items()) or "no probabilities",
                 meta.get("detect_ms", "-"), engine, meta["engine_ms"], text[:50])
    return text


def _save_recording(pcm: bytes, text: str, meta: dict, source: str) -> None:
    """Keep the first STT_SAVE_MAX requests (16 kHz WAV + JSON) for checking
    real phone speech. This stores the owner's voice: see speech/README.md."""
    if not STT_SAVE_DIR or not pcm:
        return
    try:
        folder = Path(STT_SAVE_DIR)
        if len(list(folder.glob("*.wav"))) >= STT_SAVE_MAX:
            return
        stamp = time.strftime("%Y%m%d-%H%M%S")
        base = folder / f"{stamp}-{int(time.time() * 1000) % 1000:03d}"
        os.umask(0o007)
        base.with_suffix(".wav").write_bytes(_wav(pcm))
        base.with_suffix(".json").write_text(json.dumps({
            "time": stamp, "source": source,
            "seconds": round(len(pcm) / (RATE * WIDTH), 2),
            "transcript": text, **meta}, ensure_ascii=False, indent=2))
        _LOGGER.info("STT saved recording %s (%d of %d)", base.name,
                     len(list(folder.glob("*.wav"))), STT_SAVE_MAX)
    except OSError as err:
        _LOGGER.warning("STT recording not saved: %s", err)


def _latin_with_greek_leak(text: str) -> bool:
    """Mostly Latin letters with a few Greek ones: English audio that the
    Greek-hinted engine partly wrote in Greek (3 of 100 FLEURS clips)."""
    greek, latin = len(_GREEK.findall(text)), len(_LATIN.findall(text))
    return 0 < greek < latin


async def _stt_single(pcm: bytes, language: str | None) -> str:
    """STT_AUTO {"engine", "language", "english_rerun"}: one engine for every
    language. Cohere told "el" also writes English speech correctly (FLEURS
    2026-11-04: English 5.2% WER with "el" vs 4.5% with "en"; Greek 8.4%),
    while "en" garbles Greek, so the Greek hint is the default. A client
    language overrides it; a mostly-Latin transcript with stray Greek letters
    is transcribed again with english_rerun."""
    engine = STT_AUTO["engine"]
    base = STT_AUTO.get("language") or None
    lang = _lang(language) or base
    text = await _engine(engine, pcm, lang)
    rerun = STT_AUTO.get("english_rerun")
    if rerun and lang == base and _latin_with_greek_leak(text):
        again = await _engine(engine, pcm, rerun)
        _LOGGER.info("STT auto: %s %s leaked Greek letters, rerun with %s: %r",
                     engine, lang, rerun, again[:50])
        return again or text
    _LOGGER.info("STT auto: %s (%s): %r", engine, lang, text[:50])
    return text


class _WyomingAuto(AsyncEventHandler):
    """Wyoming speech-to-text server for the "auto" engine (Home Assistant)."""

    def __init__(self, info: Info, *args) -> None:
        super().__init__(*args)
        self._info = info
        self._converter = AudioChunkConverter(rate=RATE, width=WIDTH, channels=CHANNELS)
        self._pcm = bytearray()
        self._language: str | None = None

    async def handle_event(self, event: Event) -> bool:
        if Describe.is_type(event.type):
            await self.write_event(self._info.event())
        elif Transcribe.is_type(event.type):
            self._language = Transcribe.from_event(event).language
        elif AudioStart.is_type(event.type):
            self._pcm = bytearray()
        elif AudioChunk.is_type(event.type):
            self._pcm += self._converter.convert(AudioChunk.from_event(event)).audio
        elif AudioStop.is_type(event.type):
            meta: dict = {}
            _stt_meta.set(meta)
            try:
                text = await asyncio.wait_for(
                    _stt("auto", bytes(self._pcm), self._language), TIMEOUT)
            except Exception:
                _LOGGER.exception("Wyoming STT auto failed")
                text = ""
            _save_recording(bytes(self._pcm), text, meta, "wyoming")
            _LOGGER.info("Wyoming STT auto: %.1f s audio -> %d chars",
                         len(self._pcm) / (RATE * WIDTH), len(text))
            await self.write_event(Transcript(text=text).event())
            self._pcm = bytearray()
        return True


def _wyoming_info() -> Info:
    attribution = Attribution(name="homelab speech-gateway", url="")
    model = AsrModel(
        name="auto", attribution=attribution, installed=True, version=None,
        description=(f"{STT_AUTO['engine']} with a detected el/en language" if "detector" in STT_AUTO
                     else f"{STT_AUTO['engine']} for every language" if "engine" in STT_AUTO
                     else f"{STT_AUTO['primary']}, {STT_AUTO.get('greek')} for Greek"),
        languages=["en", "el"],
    )
    return Info(asr=[AsrProgram(
        name="speech-gateway-auto", attribution=attribution, installed=True,
        description="Picks the speech-to-text engine by language",
        version=None, models=[model],
    )])


async def transcriptions(request: web.Request) -> web.Response:
    form = await request.post()
    upload = form.get("file")
    if upload is None or not hasattr(upload, "file"):
        return _error(400, "missing 'file'")
    model = str(form.get("model") or STT_DEFAULT)
    model = STT_ALIASES.get(model, model)
    if model not in STT_BACKENDS:
        await _tts_backends(request.app["session"])  # audio.cpp models (cached)
    if model not in STT_BACKENDS:
        # Unknown names (e.g. OpenAI's whisper-1) use the default engine.
        _LOGGER.info("Unknown STT model %r, using %s", model, STT_DEFAULT)
        model = STT_DEFAULT
    language = str(form.get("language") or "") or None
    try:
        raw = upload.file.read()
        pcm = await _to_pcm(raw)
        meta: dict = {}
        _stt_meta.set(meta)
        text = await asyncio.wait_for(_stt(model, pcm, language), TIMEOUT)
        if model == "auto":
            _save_recording(pcm, text, meta, "http")
    except ValueError as err:
        return _error(400, f"cannot decode audio: {err}")
    except Exception as err:  # backend down, timeout
        _LOGGER.exception("STT via %s failed", model)
        return _error(502, f"{model}: {err}")
    level = _level_db(pcm)
    if not text.strip():
        # Keep the last empty-result clip (as received) for diagnosis.
        try:
            Path("/tmp/stt-last-empty.bin").write_bytes(raw)
        except OSError:
            pass
    _LOGGER.info("STT input: %s, %d bytes, peak %.1f dBFS, rms %.1f dBFS",
                 getattr(upload, "content_type", "?"), len(raw), level[0], level[1])
    _LOGGER.info("STT %s: %.1f s audio -> %d chars", model,
                 len(pcm) / (RATE * WIDTH), len(text))
    if form.get("response_format") == "text":
        return web.Response(text=text)
    return web.json_response({"text": text})


# --- TTS input cleanup -------------------------------------------------------
# LLM answers sometimes carry Markdown and stray letters of other scripts
# inside Greek words; the TTS engines read both badly. _speakable() runs once
# on the request text, before language detection, routing and sentence split.
_MD_FENCE = re.compile(r"^[ \t]*(?:```|~~~)[^\n]*$", re.M)
_MD_TABLE_SEP = re.compile(r"^[ \t]*\|?[ \t]*:?-{2,}:?[ \t]*(?:\|[ \t]*:?-{2,}:?[ \t]*)*\|?[ \t]*$", re.M)
_MD_IMAGE = re.compile(r"!\[([^\]]*)\]\([^)\s]*[^)]*\)")
_MD_LINK = re.compile(r"\[([^\]]+)\]\([^)]*\)")
_MD_URL = re.compile(r"(?:https?://|www\.)[^\s<>)\]]+", re.I)
_MD_HEADING = re.compile(r"^[ \t]*#{1,6}[ \t]+", re.M)
_MD_QUOTE = re.compile(r"^[ \t]*(?:>[ \t]?)+", re.M)
_MD_LIST = re.compile(r"^[ \t]*(?:[-*+\u2022\u25cf\u25e6\u2013][ \t]+|\d{1,3}[.)][ \t]+)", re.M)
_MD_BOLD = re.compile(r"(\*\*|__)(?=\S)(.+?)(?<=\S)\1", re.S)
_MD_EMPH = re.compile(r"(?<![\w*])\*(?=\S)([^*\n]+?)(?<=\S)\*(?![\w*])")
_MD_UEMPH = re.compile(r"(?<![\w_])_(?=\S)([^_\n]+?)(?<=\S)_(?![\w_])")
_MD_STRIKE = re.compile(r"~~(?=\S)(.+?)(?<=\S)~~", re.S)
_MD_LEFT = re.compile(r"\*\*|__|`+")
_END_PUNCT = ".!?;:\u2026\u037e\u00bb\"')"
_SPACES = re.compile(r"[ \t\u00a0]+")
_EXTRA_DROP = frozenset("\u200d\ufe0e\ufe0f\u20e3")


@lru_cache(maxsize=4096)
def _keep_char(ch: str) -> bool:
    """False for letters/digits/marks of scripts other than Latin and Greek,
    and for emoji and pictographs."""
    o = ord(ch)
    if o < 0x250:
        return True
    if ch in _EXTRA_DROP or o >= 0x1F000 or 0x2600 <= o <= 0x27BF:
        return False
    cat = unicodedata.category(ch)
    if cat[0] in "LMN" and cat not in ("No",):
        try:
            name = unicodedata.name(ch)
        except ValueError:
            return False
        # Greek/Latin letters, their combining accents and shared marks.
        return name.startswith(("LATIN", "GREEK", "COMBINING")) or cat == "Mn" and "COMBINING" in name
    return cat not in ("Cs", "Co", "Cn")


def _strip_scripts(text: str) -> str:
    out = []
    prev_kept = False
    for ch in text:
        if _keep_char(ch):
            if unicodedata.category(ch)[0] == "M" and not prev_kept:
                continue
            out.append(ch)
            prev_kept = True
        else:
            prev_kept = False
    return "".join(out)


def _speakable(text: str) -> str:
    """Deterministic cleanup of TTS input: Markdown to plain sentences, letters
    of scripts other than Latin/Greek and emoji removed. Never returns an empty
    string for a non-empty input (falls back to the original text)."""
    original = text
    if not text or not text.strip():
        return original
    t = text.replace("\r\n", "\n").replace("\r", "\n")
    t = _MD_FENCE.sub("", t)
    t = _MD_TABLE_SEP.sub("", t)
    t = _MD_IMAGE.sub(r"\1", t)
    t = _MD_LINK.sub(r"\1", t)
    t = _MD_URL.sub("", t)
    t = _MD_HEADING.sub("\x00", t)
    t = _MD_QUOTE.sub("", t)
    t = _MD_LIST.sub("\x00", t)
    t = _MD_BOLD.sub(r"\2", t)
    t = _MD_STRIKE.sub(r"\1", t)
    t = _MD_EMPH.sub(r"\1", t)
    t = _MD_UEMPH.sub(r"\1", t)
    t = _MD_LEFT.sub("", t)
    t = _strip_scripts(t)
    lines = []
    for line in t.split("\n"):
        mark = line.startswith("\x00")
        line = line.replace("\x00", "")
        if "|" in line:
            mark = True
            line = " ".join(c.strip() for c in line.strip().strip("|").split("|") if c.strip())
        line = _SPACES.sub(" ", line).strip()
        if not line:
            continue
        if mark and line[-1] not in _END_PUNCT:
            line += "."
        lines.append(line)
    cleaned = " ".join(lines)
    cleaned = re.sub(r" +([,.;!?])", r"\1", cleaned)
    if not cleaned.strip(" .,;:") or not re.search(r"\w", cleaned):
        return original
    if cleaned != original:
        _LOGGER.debug("TTS input cleaned: %d -> %d chars", len(original), len(cleaned))
    return cleaned


async def speech(request: web.Request) -> web.StreamResponse:
    try:
        body = await request.json()
    except json.JSONDecodeError:
        return _error(400, "body must be JSON")
    _last_tts["at"] = asyncio.get_running_loop().time()
    body = dict(body)
    if isinstance(body.get("input"), str):
        body["input"] = _speakable(body["input"])
    if body.get("model") in TTS_ALIASES:
        body["model"] = TTS_ALIASES[body["model"]]
    if TTS_ROUTES:
        _b, _e, default = await _tts_engines(request.app["session"])
        route = TTS_ROUTES.get(body.get("model") or default)
        if route:
            lang = "el" if _mostly_greek(str(body.get("input") or "")) else "en"
            target = route.get(lang) or route.get("en") or next(iter(route.values()))
            _LOGGER.info("TTS route %s: %s -> %s/%s", body.get("model") or default,
                         lang, target["model"], target.get("voice", ""))
            body = {**body, "model": target["model"]}
            body.pop("voice", None)
            if target.get("voice"):
                body["voice"] = target["voice"]
    if str(body.get("response_format") or "").lower() == "pcm":
        return await _speech_pcm(request, dict(body))
    response = await _speech(request, dict(body))
    fallback = TTS_FALLBACK.get("model")
    if (response.status >= 500 and fallback and body.get("model") != fallback
            and not response.prepared):
        _LOGGER.warning("TTS %s failed (%s), falling back to %s",
                        body.get("model"), response.status, fallback)
        response = await _speech(request, {**body, **TTS_FALLBACK})
        response.headers["X-TTS-Fallback"] = fallback
    return response


async def _build_request(request: web.Request, body: dict, language: str = ""):
    """Resolve engine, voice options, prefix and post filter for one request.

    Returns (model, backend, body, post_filter), or a web.Response error.
    `language` pre-sets the language of auto_language backends, so the pieces
    of one split reply all use the language of the whole reply.
    """
    tts_backends, tts_engines, tts_default = await _tts_engines(request.app["session"])
    if not tts_engines:
        return _error(404, "no text-to-speech engine is configured")
    model = body.get("model") or tts_default
    if model not in tts_engines:
        _LOGGER.info("Unknown TTS model %r, using %s", model, tts_default)
        model = tts_default
    if model in WYOMING_TTS_BACKENDS:
        return model, None, body, ""
    backend = tts_backends[model]
    body["model"] = backend["model"]
    if not body.get("voice"):
        body.pop("voice", None)
    body.update(backend.get("extra", {}))
    # voice_options: voice names that stand for request fields (a voice-design
    # instruction, an input prefix, a library voice plus a post filter, ...).
    options = backend.get("voice_options", {})
    voice = body.get("voice")
    if voice in options:
        body.pop("voice")
        body.update(options[voice])
    elif not voice and options and not backend.get("voices"):
        body.update(next(iter(options.values())))
    prefix = body.pop("input_prefix", "")
    if prefix:
        body["input"] = prefix + str(body.get("input") or "")
    post_filter = body.pop("post_filter", "") or backend.get("post_filter", "")
    if backend.get("auto_language") and not body.get("language"):
        body["language"] = language or (
            "el" if _mostly_greek(str(body.get("input") or "")) else "en")
    return model, backend, body, post_filter


async def _speech(request: web.Request, body: dict) -> web.StreamResponse:
    built = await _build_request(request, body)
    if isinstance(built, web.Response):
        return built
    model, backend, body, post_filter = built
    if backend is None:  # Wyoming engine
        text = str(body.get("input") or "")
        if not text.strip():
            return _error(400, "missing 'input'")
        try:
            audio = await asyncio.wait_for(_synthesize(
                WYOMING_TTS_BACKENDS[model]["address"], text,
                str(body.get("voice") or "") or None), TIMEOUT)
        except Exception as err:  # backend down, unknown voice, timeout
            _LOGGER.exception("TTS via %s failed", model)
            return _error(502, f"{model}: {err}")
        return web.Response(body=audio, content_type="audio/wav")
    session: aiohttp.ClientSession = request.app["session"]
    try:
        upstream = await session.post(f"{backend['url']}/audio/speech", json=body)
    except aiohttp.ClientError as err:
        return _error(502, f"{model}: {err}")
    async with upstream:
        # audio.cpp answers some errors with HTTP 200 and a JSON body.
        if upstream.status != 200 or upstream.content_type == "application/json":
            return web.Response(
                status=upstream.status if upstream.status != 200 else 502,
                body=await upstream.read(),
                content_type=upstream.content_type,
            )
        if post_filter:  # ffmpeg audio filter chain on the whole clip
            raw_pcm = body.get("response_format") == "pcm"
            try:
                audio = await _filter_audio(await upstream.read(), post_filter,
                                            "s16le" if raw_pcm else "wav")
            except ValueError as err:
                return _error(502, f"{model}: post filter failed: {err}")
            return web.Response(body=audio,
                                content_type="audio/pcm" if raw_pcm else "audio/wav")
        response = web.StreamResponse(
            headers={"Content-Type": upstream.headers.get("Content-Type", "audio/mpeg")}
        )
        await response.prepare(request)
        async for chunk in upstream.content.iter_chunked(16384):
            await response.write(chunk)
        await response.write_eof()
        return response


_SENT_SPLIT = re.compile(r"(?<=[.!?\u2026\u037e;])\s+|\n{2,}")
_SENT_MIN, _SENT_MAX = 25, 300


def _split_sentences(text: str) -> list[str]:
    """Sentence pieces for streamed TTS: short ones merge into the next, very
    long ones split at commas (or a space near _SENT_MAX)."""
    pieces: list[str] = []
    for part in _SENT_SPLIT.split(text):
        part = part.strip()
        while len(part) > _SENT_MAX:
            cut = max(part.rfind(", ", 0, _SENT_MAX), part.rfind("; ", 0, _SENT_MAX))
            if cut < _SENT_MIN:
                cut = part.rfind(" ", 0, _SENT_MAX)
            if cut < _SENT_MIN:
                cut = _SENT_MAX
            pieces.append(part[:cut + 1].strip())
            part = part[cut + 1:].strip()
        if part:
            pieces.append(part)
    out: list[str] = []
    carry = ""
    for piece in pieces:
        piece = f"{carry} {piece}".strip()
        if len(piece) < _SENT_MIN:
            carry = piece
        else:
            out.append(piece)
            carry = ""
    if carry:
        if out:
            out[-1] = f"{out[-1]} {carry}"
        else:
            out.append(carry)
    return out


async def _sentence_pcm(request: web.Request, body: dict, language: str):
    """Synthesize one piece to raw s16le 24 kHz mono; bytes or a web.Response error."""
    session: aiohttp.ClientSession = request.app["session"]

    async def attempt(piece_body: dict):
        built = await _build_request(request, dict(piece_body), language)
        if isinstance(built, web.Response):
            return built
        model, backend, req, post_filter = built
        if backend is None:
            return _error(400, f"{model}: streaming is not supported for Wyoming engines")
        req["response_format"] = "wav"
        try:
            upstream = await session.post(f"{backend['url']}/audio/speech", json=req)
        except aiohttp.ClientError as err:
            return _error(502, f"{model}: {err}")
        async with upstream:
            if upstream.status != 200 or upstream.content_type == "application/json":
                return web.Response(
                    status=upstream.status if upstream.status != 200 else 502,
                    body=await upstream.read(), content_type=upstream.content_type)
            audio = await upstream.read()
        try:
            return await _filter_audio(audio, post_filter, "s16le")
        except ValueError as err:
            return _error(502, f"{model}: audio conversion failed: {err}")

    result = await attempt(body)
    fallback = TTS_FALLBACK.get("model")
    if (isinstance(result, web.Response) and result.status >= 500 and fallback
            and body.get("model") != fallback):
        _LOGGER.warning("TTS %s failed (%s), falling back to %s",
                        body.get("model"), result.status, fallback)
        result = await attempt({**body, **TTS_FALLBACK})
    return result


async def _speech_pcm(request: web.Request, body: dict) -> web.StreamResponse:
    """response_format=pcm: synthesize sentence by sentence and stream raw
    s16le 24 kHz mono, so the first audio leaves after one sentence."""
    text = str(body.get("input") or "")
    if not text.strip():
        return _error(400, "missing 'input'")
    started = asyncio.get_running_loop().time()
    language = "el" if _mostly_greek(text) else "en"
    pieces = _split_sentences(text)
    queue: asyncio.Queue = asyncio.Queue(maxsize=2)

    async def produce() -> None:
        try:
            for piece in pieces:
                await queue.put(await _sentence_pcm(request, {**body, "input": piece}, language))
        except Exception as err:  # keep the consumer from waiting forever
            _LOGGER.exception("streamed TTS failed")
            await queue.put(_error(502, str(err)))
        await queue.put(None)

    task = asyncio.create_task(produce())
    response = None
    first = None
    count = 0
    try:
        while (item := await queue.get()) is not None:
            if isinstance(item, web.Response):
                if response is None:
                    return item
                _LOGGER.error("streamed TTS stopped after %d of %d pieces (%s)",
                              count, len(pieces), item.status)
                break
            if response is None:
                response = web.StreamResponse(headers={"Content-Type": "audio/pcm"})
                await response.prepare(request)
                first = asyncio.get_running_loop().time() - started
            if len(item) % 2:
                item = item[:-1]
            await response.write(item)
            count += 1
        if response is None:
            return _error(502, "no audio produced")
        await response.write_eof()
        _LOGGER.info("TTS pcm stream: %d pieces, first chunk %.2f s, total %.2f s",
                     len(pieces), first, asyncio.get_running_loop().time() - started)
        return response
    finally:
        task.cancel()


async def _filter_audio(audio: bytes, chain: str, fmt: str = "wav") -> bytes:
    """Run an ffmpeg audio filter chain (may be empty) on a whole clip. fmt
    "s16le" gives raw 24 kHz mono PCM, "wav" a WAV file."""
    args = ["-af", chain] if chain else []
    if fmt == "s16le":
        args += ["-ar", "24000", "-ac", "1"]
    proc = await asyncio.create_subprocess_exec(
        "ffmpeg", "-nostdin", "-loglevel", "error", "-i", "pipe:0", *args,
        "-f", fmt, "pipe:1",
        stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    out, err = await proc.communicate(audio)
    if proc.returncode != 0:
        raise ValueError(err.decode(errors="replace").strip() or "ffmpeg failed")
    return out


def _gguf_voices(path: str) -> list[str]:
    """Voice names embedded in a GGUF package (read from its first 16 MB)."""
    local = Path(AUDIOCPP_MODELS_DIR) / Path(path).relative_to("/models") \
        if path.startswith("/models/") else Path(path)
    try:
        key = (str(local), local.stat().st_mtime)
    except (OSError, ValueError):
        return []
    if not local.is_file():  # safetensors packages are folders
        return []
    if key not in _voice_cache:
        with open(local, "rb") as fh:
            head = fh.read(16 * 1024 * 1024)
        _voice_cache[key] = sorted(set(
            m.decode() for m in _VOICE_NAME.findall(head)))
    return _voice_cache[key]


async def _tts_backends(session: aiohttp.ClientSession) -> dict:
    """Static TTS_BACKENDS plus the models the audio.cpp server offers now."""
    loop = asyncio.get_running_loop()
    if AUDIOCPP_URL and loop.time() - _discovered["at"] > DISCOVERY_TTL:
        try:
            async with session.get(f"{AUDIOCPP_URL}/models",
                                   timeout=aiohttp.ClientTimeout(total=5)) as resp:
                data = (await resp.json(content_type=None)).get("data", [])
            engines = {}
            # Speech-to-text models of audio.cpp become HTTP STT engines of the
            # same name (STT_BACKENDS entries of that name win).
            asr = {item["id"] for item in data if item.get("task") == "asr"}
            for name in _discovered["stt"] - asr:
                STT_BACKENDS.pop(name, None)
            for name in asr - set(STT_BACKENDS):
                STT_BACKENDS[name] = {"url": AUDIOCPP_URL, "model": name}
                _discovered["stt"].add(name)
            _discovered["stt"] &= asr
            for item in data:
                if item.get("task") != "tts":
                    continue
                family = item.get("family", "")
                backend = {"url": AUDIOCPP_URL, "model": item["id"], "family": family,
                           "voices_path": f"/audio/voices?model={item['id']}"}
                if family in AUTO_LANGUAGE_FAMILIES:
                    backend["auto_language"] = True
                voices = await loop.run_in_executor(None, _gguf_voices, item.get("path", ""))
                # "library": false in TTS_BACKENDS keeps the voice library out.
                if (family in CLONE_FAMILIES
                        and TTS_BACKENDS.get(item["id"], {}).get("library", True)):  # reference WAVs of the voice library
                    voices += [v for v in await _voices_of(session, backend) if v not in voices]
                if voices:
                    backend["voices"] = voices
                engines[item["id"]] = backend
            _discovered.update(at=loop.time(), engines=engines)
        except (aiohttp.ClientError, asyncio.TimeoutError, json.JSONDecodeError, KeyError) as err:
            _LOGGER.warning("audio.cpp discovery failed: %s", err)
            _discovered["at"] = loop.time()  # keep the last list, retry later
    merged = {name: {**backend, **TTS_BACKENDS.get(name, {})}
              for name, backend in _discovered["engines"].items()}
    for name, backend in TTS_BACKENDS.items():
        if name not in merged and "url" in backend:
            merged[name] = backend
    return merged


async def _tts_engines(session: aiohttp.ClientSession) -> tuple[dict, list[str], str]:
    backends = await _tts_backends(session)
    names = [*TTS_ROUTES, *backends, *WYOMING_TTS_BACKENDS]
    default = TTS_DEFAULT_ENV if TTS_DEFAULT_ENV in names else next(iter(names), "")
    return backends, names, default


async def _synthesize(address: str, text: str, voice: str | None) -> bytes:
    """One Wyoming Synthesize round trip, returned as a WAV file."""
    host, port = address.rsplit(":", 1)
    pcm, fmt = bytearray(), None
    async with AsyncTcpClient(host, int(port)) as client:
        await client.write_event(Synthesize(
            text=text, voice=SynthesizeVoice(name=voice) if voice else None,
        ).event())
        while True:
            event = await client.read_event()
            if event is None:
                raise ConnectionError("Wyoming server closed the connection")
            if AudioChunk.is_type(event.type):
                chunk = AudioChunk.from_event(event)
                fmt = (chunk.rate, chunk.width, chunk.channels)
                pcm += chunk.audio
            elif AudioStop.is_type(event.type):
                break
    if fmt is None:
        raise ValueError("no audio returned")
    out = io.BytesIO()
    with wave.open(out, "wb") as wav:
        wav.setframerate(fmt[0])
        wav.setsampwidth(fmt[1])
        wav.setnchannels(fmt[2])
        wav.writeframes(bytes(pcm))
    return out.getvalue()


async def _wyoming_voices(backend: dict) -> list[str]:
    host, port = backend["address"].rsplit(":", 1)
    langs = tuple(backend.get("languages") or ())
    try:
        async with AsyncTcpClient(host, int(port)) as client:
            await client.write_event(Describe().event())
            while True:
                event = await asyncio.wait_for(client.read_event(), 10)
                if event is None:
                    return []
                if Info.is_type(event.type):
                    break
    except (OSError, asyncio.TimeoutError):
        return []
    names = []
    for program in Info.from_event(event).tts:
        for voice in program.voices:
            if not langs or any(l.startswith(langs) for l in voice.languages):
                names.append(voice.name)
    return names


async def _voices_of(session: aiohttp.ClientSession, backend: dict) -> list[str]:
    path = backend.get("voices_path", "/audio/voices")
    try:
        async with session.get(f"{backend['url']}{path}") as resp:
            data = await resp.json(content_type=None)
    except (aiohttp.ClientError, json.JSONDecodeError):
        return []
    items = data.get("voices", data) if isinstance(data, dict) else data
    if isinstance(items, dict):  # e.g. {"styles": [...]} shapes
        items = next((v for v in items.values() if isinstance(v, list)), [])
    names = []
    for item in items or []:
        name = item if isinstance(item, str) else (
            item.get("id") or item.get("name") or item.get("voice_id"))
        if name:
            names.append(str(name))
    return names


async def _backend_voices(session: aiohttp.ClientSession, backend: dict) -> list[str]:
    """A fixed `voices` list from the config wins over asking the backend."""
    listed = backend.get("voices") or []
    if not listed and not backend.get("voice_options"):
        listed = await _voices_of(session, backend)
    return list(dict.fromkeys([*backend.get("voice_options", {}), *listed]))


async def _static(items: list[str]) -> list[str]:
    return items


async def voices(request: web.Request) -> web.Response:
    session = request.app["session"]
    model = request.query.get("model")
    backends, engines, _default = await _tts_engines(session)
    if model and model not in engines:  # unknown or not yet discovered engine
        return web.json_response({"voices": []})
    names = [model] if model else engines
    found = await asyncio.gather(*(
        _static([n]) if n in TTS_ROUTES
        else _wyoming_voices(WYOMING_TTS_BACKENDS[n]) if n in WYOMING_TTS_BACKENDS
        else _backend_voices(session, backends[n]) for n in names))
    return web.json_response({"voices": list(dict.fromkeys(v for group in found for v in group))})


async def models(request: web.Request) -> web.Response:
    _backends, engines, default = await _tts_engines(request.app["session"])
    data = [{"id": name, "object": "model", "owned_by": "stt",
             "default": name == STT_DEFAULT} for name in STT_BACKENDS]
    data += [{"id": name, "object": "model", "owned_by": "tts",
              "default": name == default} for name in engines]
    data += [{"id": name, "object": "model", "owned_by": "stt", "alias_of": target}
             for name, target in STT_ALIASES.items()]
    data += [{"id": name, "object": "model", "owned_by": "tts", "alias_of": target}
             for name, target in TTS_ALIASES.items()]
    return web.json_response({"object": "list", "data": data})


async def _warm_once(session: aiohttp.ClientSession) -> None:
    if os.path.exists(WARM_PAUSE_FILE):
        return
    loop = asyncio.get_running_loop()
    headers = {"Authorization": f"Bearer {LLAMA_API_KEY}"} if LLAMA_API_KEY else {}
    async with session.get(f"{LLAMA_URL}/models", headers=headers,
                           timeout=aiohttp.ClientTimeout(total=10)) as resp:
        models = (await resp.json(content_type=None)).get("data", [])
    state = {m.get("id"): (m.get("status") or {}).get("value") for m in models}
    others = [n for n, v in state.items() if n != WARM_LLM and v in ("loaded", "loading")]
    async with session.get(f"{AUDIOCPP_URL}/models", timeout=aiohttp.ClientTimeout(total=10)) as resp:
        tts_loaded = [m["id"] for m in (await resp.json(content_type=None)).get("data", [])
                      if m.get("loaded")]
    if others:
        # Another llama.cpp model wants the card: make room.
        heavy = HEAVY_TTS | ({WARM_STT} if WARM_STT else set())
        parkers = [p for p in PARK_TTS.split(",") if p]
        if any(m in heavy for m in tts_loaded) and parkers:
            _LOGGER.info("warmer: %s active, parking audio.cpp on %s", others, parkers)
            for parker in parkers:  # one small model per audio.cpp slot
                if parker not in tts_loaded:
                    await _tts_ping(session, parker)
        return
    # "sleeping" keeps the process; only a request wakes it, so leave it.
    if WARM_LLM and state.get(WARM_LLM) not in ("loaded", "loading", "sleeping"):
        _LOGGER.info("warmer: llama.cpp idle, loading %s", WARM_LLM)
        async with session.post(f"{LLAMA_URL}/models/load", headers=headers,
                                json={"model": WARM_LLM},
                                timeout=aiohttp.ClientTimeout(total=300)) as resp:
            await resp.read()
        return
    idle = loop.time() - _last_tts["at"] > WARM_TTS_IDLE
    snapshot = json.dumps(state, sort_keys=True)
    if (WARM_TTS and WARM_TTS not in tts_loaded and (idle or not tts_loaded)
            and _warm_failed.get(WARM_TTS) != snapshot):
        _LOGGER.info("warmer: loading %s in audio.cpp", WARM_TTS)
        if not await _tts_ping(session, WARM_TTS):
            # Usually "insufficient_memory": retry only after llama.cpp changes.
            _warm_failed[WARM_TTS] = snapshot
    if (WARM_STT and WARM_STT not in tts_loaded
            and _warm_failed.get(WARM_STT) != snapshot):
        _LOGGER.info("warmer: loading %s in audio.cpp", WARM_STT)
        if not await _stt_ping(session, WARM_STT):
            _warm_failed[WARM_STT] = snapshot


async def _tts_ping(session: aiohttp.ClientSession, model: str) -> bool:
    """Load an audio.cpp model by synthesising one short word."""
    async with session.post(f"{AUDIOCPP_URL}/audio/speech",
                            json={"model": model, "input": "Ready."},
                            timeout=aiohttp.ClientTimeout(total=300)) as resp:
        body = await resp.read()
        ok = resp.status == 200 and resp.content_type != "application/json"
        if not ok:
            _LOGGER.warning("warmer: %s not loaded: %s", model, body[:200].decode(errors="replace"))
        return ok


async def _stt_ping(session: aiohttp.ClientSession, model: str) -> bool:
    """Load an audio.cpp speech-to-text model by transcribing 1 s of silence."""
    form = aiohttp.FormData()
    form.add_field("file", _wav(bytes(RATE * WIDTH)), filename="warm.wav",
                   content_type="audio/wav")
    form.add_field("model", model)
    form.add_field("language", "el")
    async with session.post(f"{AUDIOCPP_URL}/audio/transcriptions", data=form,
                            timeout=aiohttp.ClientTimeout(total=300)) as resp:
        body = await resp.read()
        ok = resp.status == 200 and b'"error"' not in body[:50]
        if not ok:
            _LOGGER.warning("warmer: %s not loaded: %s", model, body[:200].decode(errors="replace"))
        return ok


async def _warmer(app: web.Application):
    async def loop_forever():
        await asyncio.sleep(30)
        while True:
            try:
                await _warm_once(app["session"])
            except Exception as err:  # never let the warmer kill the gateway
                _LOGGER.warning("warmer: %s", err)
            await asyncio.sleep(WARM_INTERVAL)
    task = asyncio.create_task(loop_forever()) if LLAMA_URL and AUDIOCPP_URL else None
    yield
    if task:
        task.cancel()


async def tester(_request: web.Request) -> web.Response:
    return web.FileResponse(TESTER_PAGE, headers={"Cache-Control": "no-cache"})


async def health(_request: web.Request) -> web.Response:
    return web.json_response({"status": "ok"})


async def _session(app: web.Application):
    app["session"] = aiohttp.ClientSession(
        timeout=aiohttp.ClientTimeout(total=TIMEOUT, sock_connect=10)
    )
    yield
    await app["session"].close()


async def _run() -> None:
    app = web.Application(client_max_size=50 * 1024 * 1024)
    app.cleanup_ctx.append(_session)
    app.cleanup_ctx.append(_warmer)
    app.router.add_get("/", tester)
    app.router.add_get("/health", health)
    app.router.add_get("/v1/models", models)
    app.router.add_post("/v1/audio/transcriptions", transcriptions)
    app.router.add_post("/v1/audio/speech", speech)
    app.router.add_get("/v1/audio/voices", voices)
    runner = web.AppRunner(app, access_log=None)
    await runner.setup()
    await web.TCPSite(runner, "0.0.0.0", int(os.environ.get("PORT", "8000"))).start()
    if STT_AUTO and WYOMING_PORT:
        server = AsyncServer.from_uri(f"tcp://0.0.0.0:{WYOMING_PORT}")
        _LOGGER.info("Wyoming STT auto on port %d", WYOMING_PORT)
        await server.run(partial(_WyomingAuto, _wyoming_info()))
    else:
        await asyncio.Event().wait()


def main() -> None:
    logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))
    asyncio.run(_run())


if __name__ == "__main__":
    main()
