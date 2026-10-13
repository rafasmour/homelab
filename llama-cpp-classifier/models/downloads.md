# Model downloads

These commands download only the GGUF used by a router preset.

```bash
hf download ggml-org/Laya-GGUF Laya-Q8_0.gguf --local-dir models/laya
```

`Laya-Q8_0.gguf` is the 0.4B Q8_0 decision model from
[ggml-org/Laya-GGUF](https://huggingface.co/ggml-org/Laya-GGUF). Add another
classifier by downloading its GGUF under `models/` and adding a section to
`models/router-config.ini`.
