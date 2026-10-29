# Model downloads

These commands download only the GGUF used by a router preset.

```bash
hf download ggml-org/Laya-GGUF Laya-Q8_0.gguf --local-dir models/laya
hf download ggml-org/embeddinggemma-2-GGUF embeddinggemma-2-Q8_0.gguf --local-dir models/embeddinggemma-2
```

`Laya-Q8_0.gguf` is the 0.4B Q8_0 decision model from
[ggml-org/Laya-GGUF](https://huggingface.co/ggml-org/Laya-GGUF). Add another
classifier by downloading its GGUF under `models/` and adding a section to
`models/router-config.ini`.

`embeddinggemma-2-Q8_0.gguf` (0.29 GiB, Apache-2.0) is Google's EmbeddingGemma 2
text embedding model from
[ggml-org/embeddinggemma-2-GGUF](https://huggingface.co/ggml-org/embeddinggemma-2-GGUF).
Its `gemma-embedding2` architecture needs llama.cpp newer than the GPU router's
b10666 build; this image (b11476) loads it.
