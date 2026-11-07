# Speech

CPU speech-to-text and GPU text-to-speech for Hermes and Open WebUI, plus a voice tester. Home Assistant and its Assist pipeline were retired on 2026-11-03, with the old CPU text-to-speech engines and the Whisper and Qwen3-ASR servers; text-to-speech now runs on [audio.cpp](https://github.com/0xShug0/audio.cpp) with Vulkan on the RX 7900 XT.

| Container | Network | Role |
| --- | --- | --- |
| `wyoming-parakeet` | `speech` (internal) | Speech-to-text: NVIDIA Parakeet TDT 0.6B v3 int8 (sherpa-onnx, 25 European languages incl. Greek, detects the language itself), Wyoming on port 10300, no internet |
| `audiocpp-tts` | `speech` (internal) | Text-to-speech: audio.cpp v0.9.3 server (Vulkan portable build, `/dev/dri`) on port 8080, OpenAI-shaped `/v1/audio/speech`, models lazy-loaded from `audiocpp/models` (built from `audiocpp/`, config `audiocpp/server.json`) |
| `speech-gateway` | `speech` (internal), `webgateway` | OpenAI-compatible gateway on port 8000 (built from `gateway/`): `model` picks the engine; serves the [voice tester](#voice-tester) at `speech.${DOMAIN}` |

No container publishes a host port. Only `speech-gateway` is routed by Traefik. Open WebUI joins the `speech` network (created here, `internal: true`) and reaches the gateway by container name.

## Start

This stack creates the `speech` network, so start it before Open WebUI. Download the models first (see [Models](#models)).

```bash
cp speech/.env.example speech/.env
docker compose --env-file speech/.env -f speech/docker-compose.yml config --quiet
docker compose --env-file speech/.env -f speech/docker-compose.yml up -d --build
```

## Automatic English/Greek speech-to-text

**Current mode (since 2026-11-07): Parakeet Ultra alone, Cohere as fallback.** `STT_AUTO` is `{"engine": "parakeet-ultra", "fallback": "cohere"}`. `parakeet-ultra` is [moondream/parakeet-ultra](https://huggingface.co/moondream/parakeet-ultra) (CC-BY-4.0, a Parakeet-TDT 0.6B v3 successor: same architecture, 25 European languages incl. Greek) as a Q6_K GGUF in `audiocpp/models/parakeet-ultra-gguf/parakeet-ultra-q6_k.gguf` (598 MiB), served by `audiocpp-tts` (family `parakeet_tdt`, task `asr`, GPU) and kept loaded by the warmer (`WARM_STT`). It detects the language itself and has no language option (the `parakeet_tdt` spec has none), so the CPU language detector is dropped: it could not steer this model anyway, and on the 100 Greek benchmark clips it wrote Greek letters on 99. If it errors, Cohere answers (backend default `language` `el`, which also keeps English intact); Cohere is no longer resident, so that first fallback request waits for its load (a few seconds). A client `language` is passed through to Ultra and ignored.

**Greek accuracy caveat (owner's decision, 2026-11-07).** Ultra's Greek WER is 33.1% against Cohere's 8.6% (see the table below), about four times worse, with English about equal (4.9% against 4.5%) and about 8 times faster. Typical errors are dropped letters and endings (`λαμβάνεται συμβουλέ από τι αρχέ`); a TTS round trip of a Greek sentence even came back partly transliterated into Latin letters. To get Cohere's Greek back without giving up Ultra's English speed, set `STT_AUTO` to the previous detector mode below (language detector, then Cohere) and recreate `speech-gateway`.

Conversion (2026-11-07, one-off): `model.safetensors` (1.25 GB, F16/F32), `config.json` and `tokenizer.json` of the moondream repo plus `processor_config.json` of `nvidia/parakeet-tdt-0.6b-v3` (the converter requires it; the moondream `config.json` is identical to NVIDIA's) went into a temporary folder and through audio.cpp's own converter, run in a throwaway container of the `audiocpp-tts` image (its `/models` mount is read-only): `audiocpp_gguf --input model.safetensors --root <dir> --family parakeet_tdt --model-spec /opt/audiocpp/model_specs/parakeet_tdt.json --type q6_k --output parakeet-ultra-q6_k.gguf` (729 tensors, embedded sidecars and model spec). The source files were deleted afterwards.

Measured 2026-11-07 (benchmark report `benchmark/reports/2026-11-07_13-37`, FLEURS 100 clips per language, Q6_K, GPU shared with the production LLM):

| Language | model | WER % | CER % | s/clip mean | clips passed (WER <= 25%) |
|---|---|---|---|---|---|
| el | cohere-transcribe-03-2026-q6_k | 8.56 | 3.32 | 0.97 | 95/100 |
| el | parakeet-ultra-q6_k | 33.06 | 9.70 | 0.13 | 30/100 |
| en | cohere-transcribe-03-2026-q6_k | 4.54 | 2.32 | 0.78 | 100/100 |
| en | parakeet-ultra-q6_k | 4.87 | 2.36 | 0.09 | 100/100 |

Through the gateway, `auto` answers a 5 s clip in 0.2-0.4 s (no detection step; the detector mode took 1.3 s more).

### Previous mode: language detector, then Cohere (2026-11-04 to 2026-11-07)

`STT_AUTO` was `{"detector": "whisper-lid", "model": "base", "engine": "cohere", "languages": ["el", "en"], "fallback": "parakeet", "seconds": 15, "threads": 2, "el_bias": 4}`; the code and `./lid/base` remain. How it worked:

1. A small CPU spoken-language-ID model decides `el` or `en` from the first 15 s of audio. It is `csukuangfj/sherpa-onnx-whisper-base` (`base-encoder.int8.onnx` 29 MB, `base-decoder.int8.onnx` 131 MB, `base-tokens.txt`; int8 only) in `./lid/base`, mounted read-only at `/lid`, run with onnxruntime inside `speech-gateway` (`gateway/lid.py`, thread executor, one detection at a time). sherpa-onnx's own Python API returns only the top language, so `lid.py` runs Whisper's first decoder step itself and reads the logits of the language tokens.
2. Only `el` against `en` is compared (Whisper labels Greek as Bulgarian, Portuguese, Finnish... fairly often, so the top label alone is not usable: top-label rule "en else el" scored 99.5% full / 100% short, but depends on the label of accented English). The decision is `en - el` log-probability margin above `el_bias` (4): on FLEURS English clips the margin is at least +5.7, Greek clips at most +2.0, so 4 sits in the gap.
3. Cohere Transcribe (audio.cpp, GPU) then transcribes with exactly that language. Cohere translates into whatever language it is told, so it never gets a guess. A client `language` skips the detector.
4. Fallback: if detection fails, the previous Parakeet-plus-Cohere logic runs; if Cohere fails, Parakeet alone answers. `wyoming-parakeet` therefore keeps running. The older modes (`{"primary", "greek"}` and `{"engine", "language"}`) still work: set `STT_AUTO` back to `{"primary": "parakeet", "greek": "cohere"}` and recreate `speech-gateway` to return to the previous behaviour.
5. One log line per request: `STT auto: en (detector, el=0.04 en=0.96) detect 1297 ms, cohere 127 ms: '...'`.

Measured 2026-11-04 on the 200 FLEURS clips (100 el, 100 en), int8 models, 2 threads on the busy Ryzen 7 1800X:

| model (int8) | full clips, el vs en | 2.5 s cuts (20+20) | with el_bias 4: full / cuts | detection median / p90 |
|---|---|---|---|---|
| whisper-tiny (99 MB) | 94.0% (12 Greek wrong) | 82.5% | 100% / 100% (gap only 3.7 to 6.7) | 0.60 / 0.64 s |
| whisper-base (154 MB) | 97.5% (5 Greek wrong, English 100/100) | 87.5% | 100% / 100% (gap 2.0 to 5.7) | 1.29 / 1.32 s |
| whisper-small (359 MB) | not run on full clips | 95.0% | 100% (cuts) | about 5 s |

Base was chosen: its margin gap is wider than tiny's and small is too slow. `./lid/tiny` and `./lid/small` are also on disk (`"model": "tiny"` switches; delete them if unwanted). End to end through `/v1/audio/transcriptions` with model `auto` and no language (WER with NFKC, lowercase, punctuation removed; Greek also without accents, ς=σ):

| mode | Greek WER | English WER | mean time per clip |
|---|---|---|---|
| detector then Cohere | 8.40% | 4.54% | 2.3 s (detection 1.3 s + Cohere 0.1-0.9 s) |
| previous (Parakeet + Cohere) | 9.26% | 8.70% | 1.3 s |

The detector costs about 1 s more per request and needs about 0.55 GB in `speech-gateway` (`mem_limit` raised from 256m to 768m). The thresholds are from read-aloud FLEURS speech; real phone speech is the open question, hence the recording capture below.

**Recording capture (`STT_SAVE_DIR`, `STT_SAVE_MAX`).** With `STT_SAVE_DIR=/recordings` (`./recordings`, ignored by Git, mode 2770 owned by the host user, `speech-gateway` writes through the supplementary group `RECORDINGS_GID`, default 1000) the gateway keeps the first `STT_SAVE_MAX` (10) `auto` requests as `<time>.wav` (16 kHz mono) and `<time>.json` (detected language, probabilities, transcript, timings, engine). It stops saving when the folder holds that many WAV files. This stores your voice locally, unencrypted. Read them with `ls speech/recordings; cat speech/recordings/*.json`, play the WAVs, then turn it off by setting `STT_SAVE_DIR: ""` (or removing the line) in `docker-compose.yml` and running `docker compose up -d --no-deps speech-gateway`, and delete them with `rm speech/recordings/*`. Deleting the files also re-opens the 10 slots.

### Previous mode (kept as fallback and for reference)

Tried and reverted on 2026-11-04: Cohere alone, always told `el` (it kept English intact on the read-aloud FLEURS clips, 5.2% WER), translated real English phone speech into Greek ("what's the time here" came out as "Τι είναι η ώρα…"). Cohere cannot be trusted to keep the spoken language without the right hint, so Parakeet stays as the language detector. The single-engine mode (`STT_AUTO {"engine", "language", "english_rerun"}`) remains in the code.

The gateway's default engine `auto` (`STT_AUTO`, served over Wyoming too when `WYOMING_PORT` is set, with the same logic) uses two engines at once:

1. CPU Parakeet (`primary`) and Cohere Transcribe (`greek`, Q6_K GGUF in `audiocpp-tts`, GPU, task `asr`, called over HTTP with `language` `el`) start together. Cohere defaults to English and invents English text on Greek audio, so the language is always passed.
2. When Parakeet finishes: clear English (at least 20% common English function words) is returned at once and the Cohere call is cancelled; Greek letters, or Latin text that is not English (Parakeet often spells Greek speech as Spanish- or Finnish-looking words), wait for Cohere, whose answer is used when it is in Greek, else Parakeet's text.
3. A client `language` of `el` runs Cohere only, `en` (or any other) Parakeet only.
4. Fallback: if Cohere errors, is unloaded and cannot load (host RAM or VRAM guard), or takes longer than `STT_GREEK_TIMEOUT_S` (8 s), Parakeet's own text is returned (Greek at about 36% WER instead of 8.6%). The Greek Parakeet container (`wyoming-parakeet-greek`, myned-ai int8 ONNX) that used to be this fallback was retired on 2026-11-04 to free about 2 GB of host RAM and swap; its model files stay in `./parakeet-greek`, and `STT_AUTO` still accepts `greek_fallback` if it is brought back.

`STT_BACKENDS` values: a string is a Wyoming `host:port`; an object `{"url", "model", "language"}` is an OpenAI-style HTTP `/audio/transcriptions` endpoint (so `model=cohere` also works directly). Measured 2026-11-04 on FLEURS clips of 4-13 s through the gateway: Greek 1.0-1.8 s (mean 1.6 s, WER about 7% on 12 clips; old path Parakeet then Greek Parakeet: 1.2 + 2.5 s on average, WER 18-25% on the same clips), English 0.7-1.6 s (mean 1.1 s, Parakeet answered all 12, as before), explicit `el` 0.4-0.9 s, Cohere down: 2.6-4.2 s via the fallback. The Greek time is Parakeet's: Cohere itself needs about 0.5 s for the same clip and is already done when Parakeet finishes. Cohere costs about 2.1 GiB of VRAM (with Bolt and Jarvis loaded: 15.7 of 20 GiB) and about 1 GiB of host RAM in `audiocpp-tts`. Load Jarvis before Cohere after a restart (the warmer does): audio.cpp refuses a load that leaves under 1 GiB of host RAM free, and Jarvis (2.9 GiB estimated) did not fit beside a loaded Cohere when only ~3.8 GiB were available.

audio.cpp runs one request per model at a time (a request that waits longer than `--busy-timeout-ms`, default 300 s, gets 503); different loaded models run in parallel. Measured: transcriptions during a 24 s Jarvis synthesis took 1.1-1.6 s, the same as idle, so a spoken answer does not delay speech recognition. Concurrent Greek requests queue behind each other on Cohere, and a request after the warmer parked audio.cpp falls back to Greek Parakeet.

## Text-to-speech (audio.cpp on the GPU)

`audiocpp-tts` serves the models in `audiocpp/server.json`. The gateway discovers them (every `tts` model becomes an engine, with the voices embedded in its GGUF and the voice library for clone-capable models), so a model added to `server.json` appears in the tester after a restart of `audiocpp-tts` and a page reload; for Supertonic and OmniVoice it sets `language` to `el` when the text is mostly Greek letters, otherwise `en` (`auto_language`), so one voice speaks both languages. Measured 2026-11-03 through the gateway, warm, "Hello Raphael, what would you like to do today?" and its Greek version, each transcribed back by Parakeet `auto`:

| Engine | Voices | English | Greek | VRAM |
| --- | --- | --- | --- | --- |
| `supertonic` (Supertonic 3, 454 MB Q8_0, OpenRAIL-M) | `M1`-`M5`, `F1`-`F5` | 0.11 s | 0.12 s | ~0.4 GB |
| `omnivoice` (OmniVoice, 1.35 GB Q8_0, CC BY-NC) | voice design: `british-male`, `british-male-young`, `british-female`, `greek-male` (fixed `instruct` and `seed`) | 0.81 s | 1.30 s | ~1.25 GB |
| `kokoro` (Kokoro 82M, Q8_0, Apache-2.0) | `bm_george`, `bm_lewis`, `bm_daniel`, `bm_fable`, `bf_*`, `af_heart`, `am_michael` | 1.35 s | English only | ~0.45 GB |
| `phonon` (Phonon 31M, Q8_0, Apache-2.0) | `default` | 0.54 s | English only | ~0.16 GB |

| `jarvis` (VoxCPM2 Q4_K + [FuturePresentLabs/tts-jarvis](https://huggingface.co/FuturePresentLabs/tts-jarvis) LoRA, Apache-2.0) | `jarvis` (with the card's "Forward" ffmpeg filter), `jarvis-raw` | 2.3-3.6 s | 1.7-2.3 s, accented | ~2.9 GB |
| `voxcpm2` (VoxCPM2 Q8_0, Apache-2.0) | voice design: `british-man`, `british-woman`, `greek-man`, `greek-woman`, `narrator`; library clone `jarvis` | 1.4-1.9 s | 1.6-2.0 s | ~2.9 GB |
| `pocket-greek` (Pocket TTS Greek, safetensors, CC-BY-4.0) | 8 library voices: `spyros`, `kostas`, `nikos`, `giorgos` (male), `eleni`, `athina`, `katerina`, `sophia` (female) | n/a | RTF ~0.5 on Vulkan | - |
| `voxcpm2-q4_k`, `voxcpm2-q5_k` (community VoxCPM2 quants, `models/VoxCPM2-GGUF-NANI`) | library clone voices | not measured | not measured | smaller than Q8 |
| `audio8-air` (Audio8-TTS-Realistic-Air Q8_0, `models/Audio8-TTS-Realistic-Air-GGUF`, `audio8_tts`, clone model) | library clones (`jarvis`, ...) | 1.2 s (5 s of audio) | 1.2 s (5 s of audio) | ~1.9 GiB with Parakeet Ultra beside it (total 17.8 GiB with the LLM) |
| `assistant` (virtual, `TTS_ROUTES`) | `assistant` | `audio8-air` / `jarvis` clone (since 2026-11-07; before: `jarvis` / `jarvis`) | `audio8-air` / `jarvis` clone | that of the engine used |

**Jarvis.** The adapter was trained against a reference recording that is not published; without a reference VoxCPM2 invents a new speaker per text and language (measured: female English, male Greek). The voice library therefore holds `audiocpp/voices/jarvis.wav`, the card's own `preview-dialogue.wav` sample (7.2 s, 24 kHz, median pitch 129 Hz), and the `jarvis` voice combines that clone reference, the description "(a calm, middle-aged British man with a low voice)" and seed 42 (`server.json`). Measured 2026-11-03: English male 131-148 Hz and exact on three sentences; Greek male but accented, one of three sentences not recognised by Parakeet. Use it for English; `voxcpm2` `british-man` or `greek-man` speak better Greek. Do not use it to imitate a real person.

**Jarvis runs on Q4_K (since 2026-11-03).** `audiocpp/server.json` points `jarvis` at `/models/VoxCPM2-GGUF-NANI/voxcpm2-Q4_K.gguf` (same LoRA, `lora_scale` 1, steps 6, guidance 2.4, seed 42). The earlier Q8_0 path was `/models/VoxCPM2-GGUF/voxcpm2-q8_0.gguf` (4.35 GiB estimated with the LoRA; it does not fit beside Ornith, whereas Q4_K with the LoRA needs ~2.86 GiB + the 1 GiB guard). It loads beside `ornith-1.5-9b-dflash` (now 3 slots, ~15.9 GB VRAM in use alone, ~18.0 of 21.5 GB with Jarvis) with `--min-free-memory-mb 1024` unchanged. Because the engine `jarvis` now owns that file, auto-discovery skips the `voxcpm2-q4_k` engine; to compare against the plain quant add a temporary entry with the same path and no `session_options`. Measured 2026-11-03 through the gateway (`jarvis`/`jarvis`, median pitch by a crude autocorrelation estimator that reads lower than the 131-148 Hz measured earlier for the same voice, transcript by Parakeet `auto`):

| Sentence | Time | Median pitch | Transcript |
|---|---|---|---|
| EN "The quick brown fox ... river bank." | 3.6 s (first, incl. warm-up) | 96 Hz | exact |
| EN "Good evening, sir. All systems ..." | 2.4 s | 101 Hz | exact |
| EN "Please remind me to water the plants ..." | 2.3 s | 98 Hz | exact ("8" for "eight") |
| EL "Καλημέρα, σήμερα ο καιρός στην Αθήνα ..." | 2.3 s | 129 Hz | exact |
| EL "Θα ήθελα να κλείσω ένα τραπέζι ..." | 1.7 s | 107 Hz | exact |

LoRA applied: with the same seed and text, the raw engine output of `jarvis` and of a plain Q4_K entry differ (different audio bytes, same length). The raw (no clone reference) output of both is ~200 Hz, so the male voice comes from the gateway's `jarvis` library voice (clone reference), as before.

**Voice library.** `audiocpp/voices/` (`voice_dir` in `server.json`) holds reference clips `<name>.wav` and `prompt_text` with one `<name>|<transcript>` line per clip. Every clone-capable model (VoxCPM2, OmniVoice, Pocket Greek) offers each clip as a voice, except engines with `"library": false` in `TTS_BACKENDS`: `jarvis` offers only `jarvis` and `jarvis-raw`. `GET /v1/audio/voices?model=<unknown>` returns an empty list. Add a clip and its transcript, then restart `audiocpp-tts`.

Two models are loaded at most (`max_loaded_models` 2 in `server.json`: since 2026-11-07 Audio8 Air plus Parakeet Ultra, earlier Jarvis plus Cohere Transcribe; loading a third unloads the least recently used one, and the first request on it waits for its load) and nothing unloads it on a timer (there is no idle unload; the gateway's warmer, see below, decides what stays loaded and parks audio.cpp on Phonon and Kokoro while another llama.cpp model needs the card); Jarvis and VoxCPM2 need about 3 GB of VRAM each, the small models 0.2-1.3 GB. The container uses about 0.3 GB of RAM. The first request after a start or an unload loads its model (a few seconds). Responses are always WAV. OmniVoice designs a voice from an `instruct` text and VoxCPM2 from a `(description)` in front of the text; the `voice_options` in `docker-compose.yml` map each voice name to such fields (plus a fixed `seed`), so a voice sounds the same every time. Add a design by adding an entry there.

The stock Vulkan build stops with "Illegal instruction" on this Zen 1 CPU, so the image uses the `vulkan-portable` release. Models come from the [audio-cpp/audio.cpp-gguf](https://huggingface.co/audio-cpp/audio.cpp-gguf) packages, installed with audio.cpp's `tools/model_manager_v2.py install <id> --models-root speech/audiocpp/models` (ids `supertonic_3_q8_0`, `omnivoice_q8_0`, `kokoro_82m_q8_0`, `gradium_phonon_31m_en_q8_0`); keep the folder names that `server.json` points at.

## The `assistant` voice (per-language routing)

`assistant` is a virtual engine (`TTS_ROUTES` in `docker-compose.yml`, also `TTS_DEFAULT`) with the single voice `assistant`. For each request the gateway looks at the text: more Greek than Latin letters means `el`, otherwise `en` (the whole request, so mixed text goes by majority), and forwards it to that entry's engine and voice, with the usual `TTS_FALLBACK` on failure:

**Input cleanup.** `POST /v1/audio/speech` first runs the text through `_speakable()` (`gateway/server.py`), before language detection, routing and sentence splitting, so every path (WAV, streamed PCM, Open WebUI, Hermes-Relay) speaks the same cleaned text: Markdown is flattened (emphasis, backticks and code fences, heading and blockquote markers, links to their text, bare URLs and table pipes removed; list items, headings and table rows become separate sentences ending in a period) and letters of scripts other than Latin and Greek (Cyrillic, Arabic, Hebrew, CJK, ...) plus emoji are dropped without inserting spaces, so a stray `يا` inside a Greek word disappears. If nothing speakable is left, the original text is sent. Edit `server.py` then `docker compose up -d --build speech-gateway` (the file is baked into the image).

**Streamed PCM (`response_format: "pcm"`).** The reply is split into sentences (merged to at least 25 characters, long ones cut at commas or 300 characters), each is synthesized in turn by the same route, voice and post filter (route and language decided once for the whole text), converted by ffmpeg to raw s16le 24 kHz mono and written to the response (`Content-Type: audio/pcm`, no WAV header) as soon as it is ready; the next sentence synthesizes while the previous one is sent. `TTS_FALLBACK` applies per sentence. Other formats are unchanged: the whole clip, WAV for engines with a post filter (Jarvis). One log line per reply: `TTS pcm stream: N pieces, first chunk X s, total Y s`. Used by Hermes-Relay voice output (see `hermes/README.md`). Measured 2026-11-04 with Jarvis (4 sentences, 10.4 s of audio): first audio 1.5-2.5 s, total 5-8 s, against 3.2 s before the first byte of a WAV request for the same text.

```yaml
TTS_ROUTES: '{"assistant": {"en": {"model": "audio8-air", "voice": "jarvis"},
                            "el": {"model": "audio8-air", "voice": "jarvis"}}}'
```

Both languages go to Audio8-TTS-Realistic-Air cloning the library voice `jarvis` (owner's choice, 2026-11-07; Hermes' `voice_output` asks for model and voice `assistant`, so nothing changes there). The `audio8_tts` family is in `CLONE_FAMILIES` (compose) so the gateway offers the voice library on it. Benchmark 2026-11-06: English WER 11.0% (Jarvis 12.1%), Greek 23.5% (Jarvis 16.8%), same speed. `jarvis` and `voxcpm2` stay configured as engines (selectable, not warmed); `HEAVY_TTS` lists `audio8-air` so the warmer parks it like the others. Measured 2026-11-07 through `assistant`, warm: English and Greek short sentences 1.1-1.2 s each for 5 s of audio, first request 3.1 s including the load (7.4 s when the model was cold). It appears in `/v1/models`, `/v1/audio/voices?model=assistant` (`["assistant"]`) and in the tester. **Change the Greek voice** by editing the `el` entry: `voice` is one of the `pocket-greek` library voices (`spyros`, `kostas`, `nikos`, `giorgos`, `eleni`, `athina`, `katerina`, `sophia`) or another engine (`"model": "voxcpm2", "voice": "greek-man"`), then `docker compose --env-file speech/.env -f speech/docker-compose.yml up -d speech-gateway`. Both languages use the same model, so alternating them costs no reload.

Measured 2026-11-03 through `assistant` with Ornith loaded (so English could not use Jarvis and was answered by the Supertonic fallback), each transcribed by `auto`: Greek (Pocket Greek `spyros`) 0.8-1.6 s, transcripts exact apart from punctuation; English (fallback Supertonic) 1.2-2.4 s including the switch back from Pocket Greek, exact. Jarvis itself through `assistant` could not be timed beside Ornith; its load alone is ~9 s (see below), so expect that on the first English request after a Greek one once the card has room.

## Warm models and the GPU safety net

- **Memory guard:** `audiocpp-tts` runs with `--min-free-memory-mb 1024` and refuses a load that would leave less than 1 GiB of VRAM or host RAM free (HTTP 503 `insufficient_memory`) instead of pushing llama.cpp out of memory. The gateway then answers with `TTS_FALLBACK` (Supertonic `M1`, ~0.4 GB).
- **Warmer** (in `speech-gateway`, every 15 s): while no other llama.cpp model is loaded it keeps `WARM_LLM` (`ornith-1.5-9b-dflash`, Hermes' model) loaded in the router; the preset itself also has `load-on-startup = true` and `sleep-idle-seconds = -1` (`llama-cpp/models/router-config.ini`). After `WARM_TTS_IDLE` (600 s) without speech requests it loads `WARM_TTS` (`audio8-air`, since 2026-11-07; `jarvis` before) in audio.cpp. While another llama.cpp model is loaded it replaces Jarvis/VoxCPM2/OmniVoice and Cohere in audio.cpp with `PARK_TTS` (`phonon,kokoro`, one small model per audio.cpp slot) so that model has the card; Greek speech-to-text then uses the Greek Parakeet fallback. `WARM_STT` (`parakeet-ultra`, since 2026-11-07; `cohere` before) is loaded like `WARM_TTS`, right away, and again after parking. A load the guard refused is retried only after the router's state changes.
- **Pausing the warmer** (benchmark runs): `docker exec speech-gateway touch /tmp/warmer.pause` stops it from loading or parking anything; `docker exec speech-gateway rm /tmp/warmer.pause` resumes it. A container restart also resumes it (the file lives in the container's `/tmp`; path configurable with `WARM_PAUSE_FILE`).
- **Measured 2026-11-03:** Ornith loads in 5.7-7.9 s (router log) and a cold Hermes request then also re-reads its 5-6k-token prompt at 1,200-1,500 tokens/s (~4 s); warm, the prompt cache leaves only the new tokens. Jarvis loads in ~9 s, Supertonic in ~1.5 s. With Ornith DFlash (3 slots, 64k each) loaded, about 3.5 GiB of VRAM is free and Jarvis Q4_K (~2.9 GiB) fits with the 1 GiB guard, so `WARM_TTS` is `jarvis` and Jarvis stays resident beside Ornith. Another llama.cpp model still gets the card (the warmer parks audio.cpp on Phonon).

## Voice tester

`https://speech.${DOMAIN}` (Homepage group AI):

- **Speech to text:** pick an engine (`auto` by default) and a language, press **Start speaking**, then **Stop**; the clip is transcribed by that engine. **Last clip on every engine** compares them on the same recording.
- **Text to speech:** pick an engine and voice and press **Speak** ("Hello Raphael, what would you like to do today?", the Greek version for Greek voices). Pick **Phrase** English or Greek; Supertonic and OmniVoice switch language by themselves.

Text-to-speech engines go in `TTS_BACKENDS` (OpenAI-compatible HTTP, `{"name": {"url": ".../v1", "model": "..."}}`) or `WYOMING_TTS_BACKENDS` (`{"name": {"address": "host:port", "languages": ["en", "el"]}}`) in `docker-compose.yml`.

## Open WebUI

In **Admin Panel > Settings > Audio**: Speech-to-Text engine `OpenAI`, API base URL `http://speech-gateway:8000/v1`, any API key, model `auto` (or `parakeet`, `cohere`). Text-to-Speech engine `OpenAI`, same base URL, model `supertonic` (voice `M1`-`M5`/`F1`-`F5`, English and Greek) or `omnivoice` (voice `british-male` etc.). Unknown speech-to-text model names fall back to `auto`.

**Discovery and OpenAI aliases.** `audiocpp/discover.py` adds every text-to-speech *and* speech-to-text GGUF under `audiocpp/models` to audio.cpp (task from the model spec's category; folders starting with `_` or `.` such as `_archive` and `_asr-eval` are skipped). The gateway offers each audio.cpp `tts` model as a TTS engine and each `asr` model as an STT engine of the same name (HTTP, with `language` passed through), next to the static `STT_BACKENDS`; `GET /v1/models` lists them all. `auto` still uses only the engines in `STT_AUTO`. OpenAI names that some clients hard-code (Hermes' dashboard offers only these) are aliases: `whisper-1`, `gpt-4o-mini-transcribe`, `gpt-4o-transcribe`, `gpt-transcribe` -> `auto`; `tts-1`, `tts-1-hd`, `gpt-4o-mini-tts` -> `assistant` (override with `STT_ALIASES` / `TTS_ALIASES` JSON). Selecting a discovered STT model by name lazy-loads it in audio.cpp (`max_loaded_models` 2), which can evict Jarvis or Cohere until the warmer restores them.

## Models

Both models are downloaded beforehand, so their servers never need the internet:

```bash
hf download csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8 --exclude 'test_wavs/*' \
  --local-dir speech/parakeet/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8
# Language-ID model (int8 files only; the fp32 .onnx files are not needed):
hf download csukuangfj/sherpa-onnx-whisper-base base-encoder.int8.onnx base-decoder.int8.onnx base-tokens.txt \
  --local-dir speech/lid/base
hf download myned-ai/parakeet-tdt-0.6b-v3-greek encoder-model.int8.onnx decoder_joint-model.int8.onnx \
  vocab.txt config.json nemo128.onnx \
  --local-dir speech/parakeet-greek/myned-ai_parakeet-tdt-0.6b-v3-greek
```

Only the int8 files of the Greek model are downloaded (0.65 GB instead of the 2.5 GB fp32 encoder). Its int8 encoder stores convolution weights as signed int8, which ONNX Runtime's CPU `ConvInteger` kernel rejects (`NOT_IMPLEMENTED ... ConvInteger(10)`). [`tools/fix_convinteger.py`](tools/fix_convinteger.py) shifts those weights and their zero points by 128 to uint8, which gives the same result. Run it once after the download, and keep no other `*int8*.onnx` file in that folder (onnx-asr picks files by pattern):

```bash
cd speech/parakeet-greek/myned-ai_parakeet-tdt-0.6b-v3-greek
docker run --rm -v "$PWD:/m" -v "$PWD/../../tools:/s:ro" python:3.12-slim sh -c \
  'pip install -q onnx==1.19.1 numpy && python -I /s/fix_convinteger.py /m/encoder-model.int8.onnx /m/fixed.onnx && mv /m/fixed.onnx /m/encoder-model.int8.onnx && chown 1000:1000 /m/encoder-model.int8.onnx'
```

Measured 2026-10-30: `parakeet` 0.65 s per English command ("Home Lab backups at 930"), Greek with one letter dropped; `parakeet-greek` 1.3-1.9 s and exact on two Greek sentences. RAM after warm-up: Parakeet 0.9 GiB, Greek Parakeet 1.3 GiB, gateway under 0.1 GiB. Whisper `base.en` (English only) and Qwen3-ASR 0.6B (garbled Greek unless told the language) were removed for being slower and less accurate.

## Added models

`parakeet-ultra-gguf/parakeet-ultra-q6_k.gguf` (STT, converted 2026-11-07, see the STT section) and `Audio8-TTS-Realistic-Air-GGUF` (TTS) are in `server.json`.

## Benchmark candidates (not in `server.json`)

Three more multilingual (Greek + English) TTS models are downloaded as quantized GGUFs under `audiocpp/models/` for the
[speech benchmarks](../benchmark/README.md#speech-benchmarks-stt-tts); they are not served by `audiocpp-tts` unless you add them
to `server.json`: `Chatterbox-GGUF/chatterbox-q6_k.gguf` (MIT, 1.6 GB), `MOSS-TTS-Nano-100M-GGUF/moss-tts-nano-100m-q6_k.gguf`
(Apache-2.0, 0.15 GB) and `MOSS-TTS-Local-v1.5-GGUF/moss-tts-local-v1.5-q6_k.gguf` (Apache-2.0, about 5.8 GB). All three are
clone models: they need a reference clip from `audiocpp/voices` (`--voice-ref`). Also there: `pocket-tts-greek/pocket-tts-greek-q6_k.gguf`
(Q6_K conversion of the Greek Pocket TTS, 0.12 GB). The sources came from `audio-cpp/audio.cpp-gguf` (Q8_0) and were re-quantized with
`audiocpp_gguf --type q6_k`; the benchmarks use only quantized GGUFs, never float variants.

## Authentication and exposure

The Wyoming servers and `audiocpp-tts` have no authentication and are only on the internal `speech` network. `speech-gateway` has no authentication either and is the one container on `webgateway`: the voice tester and its API (`/v1/audio/*`) are open to anyone on the WireGuard VPN, who can use the engines' CPU but cannot reach the engines directly.

## Backup

Nothing here needs a backup: `parakeet/`, `parakeet-greek/` and `audiocpp/models/` are re-downloadable model caches (re-run the patch after downloading the Greek model). Model caches of the removed engines (`whisper/`, `piper/`, `phonon/`, `supertonic/`, `qwen3-asr/`) are no longer used and can be deleted. Keep the local `.env` if you changed it.
