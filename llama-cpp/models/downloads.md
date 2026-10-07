# Model downloads

These commands intentionally download no quantization ladders or unlisted
projectors.

```bash
hf download AtomicChat/Ornith-1.5-35B-A3B-GGUF Ornith-1.5-35B-A3B-IQ4_XS.gguf --local-dir models/ornith/ornith-1.5-35b-a3b
hf download AtomicChat/Ornith-1.5-9B-GGUF Ornith-1.5-9B-AD-Q5_K-Q4_K.gguf --local-dir models/ornith/ornith-1.5-9b
hf download unsloth/Qwen3.6-35B-A3B-MTP-GGUF Qwen3.6-35B-A3B-UD-IQ4_XS.gguf --local-dir models/qwen/qwen-3.6-35b-a3b
hf download ggml-org/gemma-4-26B-A4B-it-GGUF gemma-4-26B-A4B-it-Q4_0.gguf --local-dir models/gemma/gemma-4-26b-a4b
hf download unsloth/gemma-4-12B-it-qat-GGUF gemma-4-12B-it-qat-UD-Q4_K_XL.gguf --local-dir models/gemma/gemma-4-12b-it-qat
hf download unsloth/gemma-4-12B-it-qat-GGUF mmproj-F16.gguf --local-dir models/gemma/gemma-4-12b-it-qat
hf download unsloth/gemma-4-E4B-it-GGUF gemma-4-E4B-it-IQ4_XS.gguf --local-dir models/gemma/gemma-4-e4b-it
hf download unsloth/gemma-4-E4B-it-GGUF mmproj-F16.gguf --local-dir models/gemma/gemma-4-e4b-it
hf download peculiar-ragdoll/Tiel-Coder-35B-A3B-GGUF Tiel-Coder-35B-A3B-UD-IQ4_XS.gguf --local-dir models/tiel/tiel-coder-35b-a3b
hf download bartowski/Ling-3.0-tiny-GGUF Ling-3.0-tiny-Q5_K_M.gguf --local-dir models/ling/ling-3-tiny
hf download bartowski/granite-4.2-8b-GGUF granite-4.2-8b-Q4_K_M.gguf --local-dir models/granite/granite-4.2-8b
hf download bartowski/google_gemma-4-E2B-it-GGUF google_gemma-4-E2B-it-Q4_K_M.gguf --local-dir models/gemma/gemma-4-e2b-it
hf download sahilchachra/Unlimited-OCR-GGUF Unlimited-OCR-Q4_K_M.gguf --local-dir models/ocr/unlimited-ocr
hf download sahilchachra/Unlimited-OCR-GGUF mmproj-Unlimited-OCR-F16.gguf --local-dir models/ocr/unlimited-ocr
hf download eugene-kamenev/KAT-Coder-V2.5-Dev-Q4_K_M-GGUF kat-coder-v2.5-dev-q4_k_m.gguf --local-dir models/kat-coder/kat-coder-v2.5-dev
hf download bartowski/Kwaipilot_KAT-Coder-V2.5-Dev-GGUF Kwaipilot_KAT-Coder-V2.5-Dev-IQ3_XXS.gguf --local-dir models/kat-coder/kat-coder-v2.5-dev
hf download XHToken/Spark-X2.5-4B-GGUF Spark-X2.5-4B-Q4_K_M.gguf --local-dir models/spark/spark-x2.5-4b
hf download XHToken/Spark-X2.5-1.7B-GGUF Spark-X2.5-1.7B-Q4_K_M.gguf --local-dir models/spark/spark-x2.5-1.7b
hf download Abiray/MiniCPM5-2B-GGUF MiniCPM5-2B-Q4_K_M.gguf --local-dir models/minicpm/minicpm5-2b
hf download NANI-Nithin/K2-Horizon-MoVA-36B-A4B-GGUF K2-Horizon-MoVA-36B-A4B-IQ4_XS.gguf --local-dir models/k2/k2-mova-36b-a4b
hf download NANI-Nithin/K2-Horizon-7B-GGUF K2-Horizon-7B-Q4_K_M.gguf --local-dir models/k2/k2-7b
hf download NANI-Nithin/K2-Horizon-3.7B-GGUF K2-Horizon-3.7B-Q4_K_M.gguf --local-dir models/k2/k2-3.7b
hf download LiquidAI/LFM2.5-8B-A1B-GGUF LFM2.5-8B-A1B-Q4_K_M.gguf --local-dir models/lfm/lfm-2.5-8b-a1b
hf download LiquidAI/LFM2.5-2.6B-GGUF LFM2.5-2.6B-Q4_K_M.gguf --local-dir models/lfm/lfm-2.5-2.6b
```

## Uno diffusion adapters (not served by llama.cpp)

Each Uno adapter is a PEFT LoRA diffusion adapter, not a GGUF MTP draft,
so there is intentionally no router preset for them. Serving Uno requires
the [`ifm-ai/uno`](https://github.com/ifm-ai/uno) nano-vLLM stack on a CUDA
host with torch 2.11 + FlashAttention; this AMD (Polaris, no CUDA) host
cannot run it. The base + adapter pairs below are stored complete so they
are ready to serve on CUDA hardware:

```bash
hf download IFM/K2-Horizon-7B --local-dir models/k2/k2-7b-base --exclude "assets/*"
hf download IFM/K2-Horizon-7B-Uno --local-dir models/k2/k2-7b-uno --exclude "*.png"
hf download IFM/K2-Horizon-0.9B --local-dir models/k2/k2-0.9b --exclude "assets/*"
hf download IFM/K2-Horizon-0.9B-Uno --local-dir models/k2/k2-0.9b-uno --exclude "*.png"
```

Run on a CUDA host per the upstream recipes, e.g.
`bash examples/uno_8B/run_inference.sh --prompt "..."` (7B pair) or
`bash examples/uno_1B/run_inference.sh --prompt "..."` (0.9B pair).
