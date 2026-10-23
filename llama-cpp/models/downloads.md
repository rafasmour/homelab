# Model downloads

Run these from the `llama-cpp/` folder. Each command downloads only the file a
router preset in `router-config.ini` uses, into `models/<family>/<alias>/`.
`--local-dir` writes the file in place; afterwards remove the small
`models/**/.cache/huggingface` metadata folders if you like. Add `--dry-run`
to inspect a transfer first. The complete set is about 150 GB.

```bash
# Default model (Hermes)
hf download bartowski/Mellum2.1-12B-A2.5B-Thinking-GGUF Mellum2.1-12B-A2.5B-Thinking-Q6_K.gguf --local-dir models/mellum/mellum-2.1-12b-a2.5b

hf download unsloth/flint-GGUF flint-UD-Q3_K_XL.gguf --local-dir models/flint/flint-40b-a2.5b
hf download unsloth/gemma-4-12B-it-qat-GGUF gemma-4-12B-it-qat-UD-Q4_K_XL.gguf mmproj-F16.gguf --local-dir models/gemma/gemma-4-12b-it-qat
hf download ggml-org/gemma-4-26B-A4B-it-GGUF gemma-4-26B-A4B-it-Q4_0.gguf mmproj-gemma-4-26B-A4B-it-Q8_0.gguf --local-dir models/gemma/gemma-4-26b-a4b
hf download unsloth/gemma-4-31B-it-GGUF gemma-4-31B-it-UD-IQ3_XXS.gguf mmproj-F16.gguf --local-dir models/gemma/gemma-4-31b-it
hf download tencent/Hy-Memory-30B-A3B-GGUF Hy-Memory-30B-A3B-Q3_K_M.gguf --local-dir models/hy/hy-memory-30b-a3b
hf download LiquidAI/LFM2.5-8B-A1B-GGUF LFM2.5-8B-A1B-Q4_K_M.gguf --local-dir models/lfm/lfm-2.5-8b-a1b
hf download LiquidAI/LFM2.5-24B-A2B-GGUF LFM2.5-24B-A2B-Q4_K_M.gguf --local-dir models/lfm/lfm-2.5-24b-a2b
hf download Abiray/MiniCPM5-2B-GGUF MiniCPM5-2B-Q8_0.gguf --local-dir models/minicpm/minicpm5-2b
hf download unsloth/Qwen3.6-35B-A3B-MTP-GGUF Qwen3.6-35B-A3B-UD-IQ4_XS.gguf --local-dir models/qwen/qwen-3.6-35b-a3b
hf download unsloth/Qwen3.8-27B-GGUF Qwen3.8-27B-Q4_0.gguf MTP/mtp-Qwen3.8-27B-Q4_0.gguf --local-dir models/qwen/qwen-3.8-27b
hf download incoai/Qwen3.8-27B-DFlash2-GGUF Qwen3.8-27B-DFlash2-Q4_K_M.gguf --local-dir models/qwen/qwen-3.8-27b
hf download XHToken/Spark-X2.6-4B-GGUF Spark-X2.6-4B-Q8_0.gguf --local-dir models/spark/spark-x2.6-4b
```

## Uno diffusion adapters (not served by llama.cpp)

Uno adapters are PEFT LoRA diffusion adapters, not GGUF drafts, so there is
no router preset for them. Serving Uno requires the
[`ifm-ai/uno`](https://github.com/ifm-ai/uno) nano-vLLM stack on a CUDA host
with torch 2.11 + FlashAttention. This host has an AMD RX 7900 XT running
ROCm, without CUDA, so it cannot run them, and the files are not kept here.
