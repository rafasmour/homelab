# Home Assistant

Assist for the phone: the Home Assistant Android Companion app listens for a wake word, Whisper transcribes the command, the Hermes `voice` profile answers (and does calendar, to-do and web-search work through its own tools), and Kokoro speaks the reply.

| Container | Network | Role |
| --- | --- | --- |
| `home-assistant` | `backend`, `webgateway` | `https://home-assistant.<DOMAIN>` through Traefik; reaches `hermes-api` directly on `webgateway` |
| `wyoming-whisper` | `backend` (internal) | Speech-to-text, Wyoming on port 10300, faster-whisper `base.en` on CPU, no internet |
| `wyoming-whisper-download` | `model-downloads` | One-shot job: downloads the Whisper model into `./whisper` and exits |
| `kokoro-tts` | `backend` (internal) | Kokoro-82M text-to-speech, OpenAI-compatible HTTP on port 8880, model baked into the image |
| `wyoming-kokoro` | `backend` (internal) | Wyoming front end for Kokoro on port 10300 ([wyoming_openai](https://github.com/roryeckel/wyoming_openai)), streams sentence by sentence |
| `wyoming-piper` | `backend`, `model-downloads` | Piper text-to-speech on port 10200 (fallback voice, lowest latency) |

No container publishes a host port. Only `home-assistant` is routed by Traefik.

## Requirements

- Docker Engine with Docker Compose
- The external `webgateway` network and Traefik routing `home-assistant.<DOMAIN>`
- The [`hermes`](../hermes/README.md) stack with `HERMES_VOICE_KEY` set (the `voice` profile)
- HACS in Home Assistant, for the Extended OpenAI Conversation integration (see below)
- WireGuard on the phone: Home Assistant is reached only over the VPN

## Configuration

```bash
cp .env.example .env
```

The speech settings (`WHISPER_*`, `KOKORO_*`, `PIPER_VOICE`) have safe defaults; see the comments in `.env.example`. This stack holds no secrets: the Hermes voice key is entered once in the Home Assistant UI.

## Start

```bash
docker compose --env-file home-assistant/.env \
  -f home-assistant/docker-compose.yml config --quiet
docker compose --env-file home-assistant/.env \
  -f home-assistant/docker-compose.yml up -d
```

`up` first runs `wyoming-whisper-download`, which downloads `WHISPER_MODEL` into `whisper/` (about 145 MB for `base.en`) and exits; `wyoming-whisper` starts only after it succeeded. After changing `WHISPER_MODEL`, run `up -d` again. If the download fails (no DNS yet, Hugging Face down), `up` reports the failed job and the old server keeps running; run `up -d` again later.

The first start creates `config/configuration.yaml` when missing. It does not create a user or disable login. Create the owner account in the onboarding screen at `https://home-assistant.<DOMAIN>`.

## Speech: choices and measurements

Measured on this host (AMD Ryzen 7 1800X, 16 threads, with llama-server using about two cores; CPU only, no GPU).

Speech-to-text (faster-whisper, 3.3 s and 5.3 s English commands):

| Model, settings | Time per command | Errors |
| --- | --- | --- |
| `tiny-int8` (old default) | not measured | lowest accuracy |
| `base-int8`, 4 threads, beam 5 | 1.3 s | "homelab" heard as "Home Love" |
| **`base.en`, int8, 8 threads, beam 1 (default)** | **1.0 s** | none |
| `small.en`, int8, 8 threads, beam 1 | 3.4 s | none |
| `small.en` / `small-int8` / `distil-small.en`, 4 threads, beam 5 | 4.2-5.6 s | distil-small.en: "At a reminder", "930" |

`small.en` is more robust with accents and noise; switch with `WHISPER_MODEL=small.en` if 3-4 s per command is acceptable. Parakeet TDT 0.6B (`WHISPER_STT_LIBRARY=sherpa`) was not measured: its 640 MB archive comes from GitHub releases, which downloaded at about 60 KB/s here.

Text-to-speech, first audio and real-time factor (RTF, synthesis time divided by audio length; below 1 is faster than real time):

| Engine, voice | 15-word sentence | 3-sentence reply |
| --- | --- | --- |
| **Kokoro-FastAPI v0.9.0 (PyTorch CPU) through `wyoming-kokoro`, `af_heart`, 8 cores (as deployed)** | **first audio 3.0 s, RTF 0.56** | **first audio 1.2 s, RTF 0.59** |
| Kokoro-FastAPI direct, `bf_emma` | 3.9 s, RTF 0.85 | 6.4 s (one chunk), RTF 0.57 |
| Kokoro-82M int8 ONNX (kokoro-onnx), 8 threads | 3.2 s, RTF 0.64 | first sentence 1.1 s, RTF 0.62 |
| Piper `en_US-lessac-medium`, 4 cores | 2.0 s, RTF 0.43 | first sentence 1.0 s, RTF 0.52 |
| Piper `en_US-lessac-high` / `ryan-high`, 4 cores | 5.9-9.2 s, RTF 1.2-2.1 | first sentence 3.2-4.7 s, RTF 1.3-2.0 |

`kokoro-tts` uses about 1.5 GiB of RAM after warm-up.

Kokoro sounds far more natural than Piper and, on this CPU, is faster than Piper's "high" voices, so it is the default. No engine reaches the ~400 ms first-audio target on this CPU: expect about 1-3 s before speech starts, depending on the length of the first sentence (`wyoming-kokoro` streams per sentence, and the Hermes SOUL keeps sentences short). Piper `lessac-medium` stays installed as the lower-latency fallback voice.

## Voice assistant (Android wake word)

Pipeline: phone wake word -> Home Assistant Assist -> Whisper -> Extended OpenAI Conversation -> Hermes `voice` profile -> Kokoro -> phone.

Home Assistant only passes text through. Hermes runs its own tools (Nextcloud calendar and to-dos without deletes, clock, web search); no Home Assistant entities are exposed to it. See [hermes/README.md](../hermes/README.md#voice-home-assistant) for the profile.

The pipeline lives in Home Assistant's UI storage (`config/.storage`), not in YAML: Assist pipelines, Wyoming and conversation integrations are UI config entries, and `config/` is runtime data that is not tracked. So it is set up once with the steps below.

### 1. Hermes

1. In `hermes/.env`, set `HERMES_VOICE_KEY` to a new value from `openssl rand -hex 32` (not `API_SERVER_KEY`).
2. Recreate the Hermes API container: `docker compose --env-file hermes/.env -f hermes/docker-compose.yml up -d api`. The log must not show `voice is not served`.

### 2. Home Assistant version and HACS

Extended OpenAI Conversation 2.0.3 needs Home Assistant 2026.10 or newer.

1. Update Home Assistant: `docker compose --env-file home-assistant/.env -f home-assistant/docker-compose.yml pull homeassistant`, then `up -d`.
2. Install HACS ([docs](https://hacs.xyz/docs/use/download/download/)): `docker exec -it home-assistant bash -c "wget -O - https://get.hacs.xyz | bash -"`, restart Home Assistant (`docker restart home-assistant`), then **Settings > Devices & services > Add integration > HACS** and finish the GitHub device login.

### 3. Speech integrations (Wyoming)

**Settings > Devices & services > Add integration > Wyoming Protocol**, once per service:

| Host | Port | Service |
| --- | --- | --- |
| `wyoming-whisper` | `10300` | Speech-to-text (faster-whisper) |
| `wyoming-kokoro` | `10300` | Text-to-speech (Kokoro voices) |
| `wyoming-piper` | `10200` | Text-to-speech (Piper fallback) |

### 4. Conversation agent: Extended OpenAI Conversation -> Hermes

The core OpenAI Conversation integration only talks to `api.openai.com` and has no base-URL field. [Extended OpenAI Conversation](https://github.com/jekalmin/extended_openai_conversation) is in the default HACS list, uses Chat Completions, and sends no tools when its function list is empty.

1. **HACS > search "Extended OpenAI Conversation" > Download**, then restart Home Assistant.
2. **Settings > Devices & services > Add integration > Extended OpenAI Conversation**:
   - Name: `Hermes`
   - API Key: the value of `HERMES_VOICE_KEY`
   - Base Url: `http://hermes-api:8642/p/voice/v1`
   - Api Provider: OpenAI; leave Skip Authentication off (the key is checked against `/p/voice/v1/models`)

   `hermes-api` is resolved on the shared `webgateway` Docker network, so the request goes container to container and never through Traefik or the internet.
3. Open the integration's conversation agent options:
   - Completion Model: `voice`
   - Prompt Template: replace the default (it lists exposed entities) with one plain line, for example `The user is speaking to you through Home Assistant voice.` Hermes' own SOUL defines the behaviour.
   - Functions: `[]` (no Home Assistant functions)
   - Maximum tokens: `1024`; Maximum function calls: `1`
4. Do not expose any entities to it (**Settings > Voice assistants > Expose** stays empty for this agent).

### 5. The Assist pipeline

1. **Settings > Voice assistants > Add assistant**:
   - Name: `Hermes`, Language: English
   - Conversation agent: `Hermes` (Extended OpenAI Conversation); turn **Prefer handling commands locally** off, so every utterance reaches Hermes
   - Speech-to-text: `faster-whisper`, English
   - Text-to-speech: Kokoro (`wyoming-kokoro`), English, Voice: `af_heart` (use **Try voice** to compare `af_bella`, `bf_emma`, `am_michael`, `bm_george`, or the Piper voice)
   - No wake word here: the phone detects it on the device.
2. Create it, open it again and choose **Set as preferred**.
3. Remove leftovers: in **Settings > Devices & services**, delete a stale **Hermes Conversation** entry if one is listed.

### 6. The phone (Android Companion app)

1. Connect the phone to WireGuard. Do not expose Home Assistant beyond the VPN; Home Assistant's own login is the only authentication on the route.
2. Install **Home Assistant** from Google Play (Companion app 2026.2.3 or newer) and sign in at `https://home-assistant.<DOMAIN>`.
3. **Settings > Companion app > Assist for Android > Set as default**, then pick **Home Assistant** in the system screen (equivalent: Android **Settings > Apps > Default apps > Digital assistant app**).
4. **Settings > Companion app > Assist for Android > Enable wake word detection** (experimental, needs the Microphone permission), and choose **Okay Nabu**, **Hey Jarvis** or **Hey Mycroft**. Use **Test wake word** to check it.
5. Keep the app's notifications allowed: it shows a persistent "Listening for wake word" notification while detection runs. If Android or the vendor's battery saver stops it, set the app's battery usage to **Unrestricted**.
6. In the Assist sheet, choose **Change assistant > Hermes** once (or leave it on the preferred assistant). The phone uses the last assistant you picked.

Battery: detection runs continuously on the main processor (third-party apps cannot use the low-power hardware "Ok Google" uses), so it costs noticeably more battery. Turn it off when not needed, or toggle it from an automation with `notify.mobile_app_<device>`, message `command_wake_word_detection`, data `command: turn_on` / `turn_off` (for example only on home Wi-Fi). Detection works offline; the command itself needs the VPN connection.

Known issue, "wake word works only once" ([forum](https://community.home-assistant.io/t/assist-on-android-with-2026-3-wake-word-only-works-once/994274), [android#6472](https://github.com/home-assistant/android/issues/6472), still open): after the first command the Assist overlay stays open with the microphone off and the next wake word is ignored. A fix in app 2026.4.1 did not help everyone. Workarounds reported there: close the Assist popup (back button) after each answer; revoke **Display over other apps** for the app; keep the app updated. Rebooting does not help.

To undo, change Android's **Digital assistant app** back; that also stops wake-word detection.

## Authentication and exposure

- Home Assistant is the only web UI on Traefik and has its own login. Keep it behind WireGuard.
- `kokoro-tts` serves an unauthenticated API, web player and `/docs`, and the Wyoming servers have no authentication. All of them are only on the internal `backend` network, never on `webgateway` or a host port.
- The `voice` key (`HERMES_VOICE_KEY`) opens only `/p/voice/v1`; it is stored in Home Assistant's integration settings (`config/.storage`).

## Networks and model downloads

`backend` is `internal: true`: no route to the internet and no external DNS. `model-downloads` is a normal outbound-only bridge (no published ports, not `webgateway`).

The old `Failed to resolve 'huggingface.co'` lines in the `wyoming-whisper` log appeared only in the first minute after host boots (2026-10-11 and 2026-10-21): Docker restored the container before the host resolver was up, and the server, which then sat on both networks, asked the hub for the `tiny-int8` tokenizer on every start. DNS through `model-downloads` itself works. Now only the one-shot `wyoming-whisper-download` job is on `model-downloads`; the long-running `wyoming-whisper` is on `backend` only with `--local-files-only` and `HF_HUB_OFFLINE=1`, so it never needs the internet and a boot without DNS no longer matters. Kokoro needs no download (the model is inside the pinned image). Piper keeps `model-downloads` for its voice download.

## Backup

Back up `home-assistant/config/` (including `.storage`: the pipeline, integrations and the Hermes key), and the local `.env`. `whisper/` and `piper/` are re-downloadable caches; Kokoro has no state.
