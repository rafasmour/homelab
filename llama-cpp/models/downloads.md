# Model downloads

Run these from the `llama-cpp/` folder. Each command downloads only the file a
router preset in `router-config.ini` uses, into `models/<family>/<alias>/`.
`--local-dir` writes the file in place; afterwards remove the small
`models/**/.cache/huggingface` metadata folders if you like. Add `--dry-run`
to inspect a transfer first. The complete set is about 120 GB.

```bash
# Default model (Hermes)
hf download unsloth/Qwen3.6-35B-A3B-MTP-GGUF Qwen3.6-35B-A3B-UD-IQ4_XS.gguf --local-dir models/qwen/qwen-3.6-35b-a3b

hf download unsloth/gemma-4-31B-it-GGUF gemma-4-31B-it-UD-IQ3_XXS.gguf mmproj-F16.gguf --local-dir models/gemma/gemma-4-31b-it
hf download unsloth/Qwen3.8-27B-GGUF Qwen3.8-27B-Q4_0.gguf MTP/mtp-Qwen3.8-27B-Q4_0.gguf --local-dir models/qwen/qwen-3.8-27b
hf download incoai/Qwen3.8-27B-DFlash2-GGUF Qwen3.8-27B-DFlash2-Q4_K_M.gguf --local-dir models/qwen/qwen-3.8-27b

# Concurrency candidates (October 2026 evaluation, see models/model-eval.md)
hf download ornith-ai/Ornith-1.5-9B-GGUF Ornith-1.5-9B-Q6_K.gguf --local-dir models/ornith/ornith-1.5-9b
hf download abenzerps/Ornith-1.5-9B-DFlash-GGUF Ornith-1.5-9B-DFlash-Q8_0.gguf --local-dir models/ornith/ornith-1.5-9b

# Ornith 1.5 9B Q4_K_M (5.38 GiB) + official DFlash drafter Q8_0 (1.29 GiB), preset ornith-1.5-9b-q4-dflash (benchmark candidate, 2026-11-06)
hf download ornith-ai/Ornith-1.5-9B-GGUF Ornith-1.5-9B-Q4_K_M.gguf --local-dir models/ornith/ornith-1.5-9b-q4
hf download abenzerps/Ornith-1.5-9B-DFlash-GGUF Ornith-1.5-9B-DFlash-Q8_0.gguf --local-dir models/ornith/ornith-1.5-9b-q4

# JetBrains Mellum 2.1 Thinking (presets mellum-2.1-thinking and -mtp; combined file with the MTP head, 9.47 GiB)
hf download bartowski/Mellum2.1-12B-A2.5B-Thinking-MTP-GGUF Mellum2.1-12B-A2.5B-Thinking-MTP-Q5_K_M.gguf --local-dir models/mellum/mellum-2.1-thinking

# OCR for paperless-gpt (preset ocr-xiaomi-0)
hf download prithivMLmods/Xiaomi-OCR-0-GGUF Xiaomi-OCR-0.Q6_K.gguf Xiaomi-OCR-0.mmproj-bf16.gguf --local-dir models/ocr/xiaomi-ocr-0
```

## Uno diffusion adapters (not served by llama.cpp)

Uno adapters are PEFT LoRA diffusion adapters, not GGUF drafts, so there is
no router preset for them. Serving Uno requires the
[`ifm-ai/uno`](https://github.com/ifm-ai/uno) nano-vLLM stack on a CUDA host
with torch 2.11 + FlashAttention. This host has an AMD RX 7900 XT running
ROCm, without CUDA, so it cannot run them, and the files are not kept here.

## Notes on the October 2026 additions

- The Ornith 1.5 9B and Qwen3.5-9B Q6_K files contain their MTP layer, which
  the `-mtp` presets draft with; no extra file is needed.
- Removed 2026-11-03 to free disk (presets and files): Flint 40B-A2.5B,
  Gemma 4 12B QAT and 26B-A4B (and their `-vision` presets), Qwen3.5-9B with
  its MTP and DFlash drafters, the `ornith-1.5-9b-mtp` preset, Ling-3.0-tiny
  and Spark-X2.6-4B. Their measurements stay in README.md and model-eval.md.
- EmbeddingGemma 2 runs on the CPU router instead
  (`llama-cpp-classifier`). Ornith 1.5 35B-A3B (planned:
  `bartowski/Ornith-1.5-35B-A3B-GGUF` IQ4_XS, 17.95 GiB) is on hold until
  swap is enlarged.
- OCR candidates tested and not kept (deleted after the test): Surya OCR 2,
  PaddleOCR-VL-1.6, Chandra OCR 2. See `models/model-eval.md`.
