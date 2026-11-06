"""Spoken-language identification with a Whisper int8 ONNX model (k2-fsa /
csukuangfj sherpa-onnx-whisper-*), on the CPU with onnxruntime.

Whisper's decoder predicts the language token right after <|startoftranscript|>;
this reads that one step's logits and returns a softmax over the requested
language codes only (so Greek mislabelled as another language still counts for
"el" or "en"). No transcription is decoded.
"""

import math
import os

import numpy as np
import onnxruntime as ort

SAMPLE_RATE = 16000
N_FFT, HOP, N_MELS = 400, 160, 80
CHUNK_S = 30


def _hz_to_mel(f):
    f = np.asarray(f, dtype=np.float64)
    mel = f / (200.0 / 3)
    log_t, step = 1000.0 / (200.0 / 3), math.log(6.4) / 27.0
    return np.where(f >= 1000.0, log_t + np.log(np.maximum(f, 1e-9) / 1000.0) / step, mel)


def _mel_to_hz(m):
    m = np.asarray(m, dtype=np.float64)
    log_t, step = 1000.0 / (200.0 / 3), math.log(6.4) / 27.0
    return np.where(m >= log_t, 1000.0 * np.exp(step * (m - log_t)), m * (200.0 / 3))


def _mel_filters() -> np.ndarray:
    """Slaney-scale, slaney-normalised triangular filters (as librosa/Whisper)."""
    fft_freqs = np.linspace(0, SAMPLE_RATE / 2, N_FFT // 2 + 1)
    pts = _mel_to_hz(np.linspace(_hz_to_mel(0.0), _hz_to_mel(SAMPLE_RATE / 2), N_MELS + 2))
    fb = np.zeros((N_MELS, len(fft_freqs)))
    for i in range(N_MELS):
        lo, mid, hi = pts[i], pts[i + 1], pts[i + 2]
        up = (fft_freqs - lo) / (mid - lo)
        down = (hi - fft_freqs) / (hi - mid)
        fb[i] = np.maximum(0, np.minimum(up, down)) * (2.0 / (hi - lo))
    return fb.astype(np.float32)


class LanguageID:
    def __init__(self, model_dir: str, threads: int = 2) -> None:
        name = os.path.basename(os.path.normpath(model_dir))
        opts = ort.SessionOptions()
        opts.intra_op_num_threads = threads
        opts.inter_op_num_threads = 1
        kw = dict(sess_options=opts, providers=["CPUExecutionProvider"])
        self.encoder = ort.InferenceSession(f"{model_dir}/{name}-encoder.int8.onnx", **kw)
        self.decoder = ort.InferenceSession(f"{model_dir}/{name}-decoder.int8.onnx", **kw)
        meta = self.encoder.get_modelmeta().custom_metadata_map
        self.sot = int(meta["sot"])
        self.layers, self.state = int(meta["n_text_layer"]), int(meta["n_text_state"])
        self.ctx = int(meta["n_text_ctx"])
        codes = meta["all_language_codes"].split(",")
        tokens = [int(t) for t in meta["all_language_tokens"].split(",")]
        self.lang_token = dict(zip(codes, tokens))
        self.filters = _mel_filters()
        self.window = np.hanning(N_FFT + 1)[:-1].astype(np.float32)

    def _mel(self, audio: np.ndarray) -> np.ndarray:
        n = CHUNK_S * SAMPLE_RATE
        audio = audio[:n]
        audio = np.pad(audio, (0, n - len(audio)))
        padded = np.pad(audio, (N_FFT // 2, N_FFT // 2), mode="reflect")
        frames = np.lib.stride_tricks.sliding_window_view(padded, N_FFT)[::HOP][:-1]
        spec = np.abs(np.fft.rfft(frames * self.window, axis=1)) ** 2
        mel = self.filters @ spec.T.astype(np.float32)
        log = np.log10(np.maximum(mel, 1e-10))
        log = np.maximum(log, log.max() - 8.0)
        return ((log + 4.0) / 4.0).astype(np.float32)

    def scores(self, pcm: bytes, seconds: float = 15.0) -> dict:
        """Log-probabilities of every language token (Whisper's own softmax
        over all its languages) for 16 kHz s16le mono PCM."""
        audio = np.frombuffer(pcm, dtype="<i2")[: int(seconds * SAMPLE_RATE)]
        audio = audio.astype(np.float32) / 32768.0
        mel = self._mel(audio)[None]
        cross_k, cross_v = self.encoder.run(None, {"mel": mel})
        cache = np.zeros((self.layers, 1, self.ctx, self.state), dtype=np.float32)
        logits = self.decoder.run(["logits"], {
            "tokens": np.array([[self.sot]], dtype=np.int64),
            "in_n_layer_self_k_cache": cache, "in_n_layer_self_v_cache": cache,
            "n_layer_cross_k": cross_k, "n_layer_cross_v": cross_v,
            "offset": np.array([0], dtype=np.int64),
        })[0][0, -1].astype(np.float64)
        sel = np.array([logits[t] for t in self.lang_token.values()])
        sel = sel - sel.max()
        sel = sel - np.log(np.exp(sel).sum())
        return dict(zip(self.lang_token, sel.tolist()))

    def detect(self, pcm: bytes, languages: list[str], seconds: float = 15.0,
               el_bias: float = 0.0) -> dict:
        """Probabilities over `languages` only (renormalised); `el_bias` is
        added to the el log-probability before the softmax."""
        full = self.scores(pcm, seconds)
        sel = np.array([full[c] + (el_bias if c == "el" else 0.0) for c in languages])
        sel = np.exp(sel - sel.max())
        sel /= sel.sum()
        return {c: float(p) for c, p in zip(languages, sel)}
