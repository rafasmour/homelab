# syntax=docker/dockerfile:1

# ROCm/HIP build for RDNA3 (gfx1100: RX 7900 XT/XTX/GRE).
# ROCm 10.x images come from AMD's TheRock packaging: one "-full" image per
# release (the whole user space under /opt/rocm: compilers, HIP, rocBLAS,
# hipBLAS, hipBLASLt), no separate "-complete" builder or slim runtime image
# as in the 7.2 line, so both stages start from it. Up to 7.2.4 use
# ROCM_IMAGE=rocm/dev-ubuntu-24.04:7.2.4-complete (and that line's runtime).
ARG ROCM_IMAGE=rocm/dev-ubuntu-24.04:10.1.0-full

FROM ${ROCM_IMAGE} AS builder

ARG DEBIAN_FRONTEND=noninteractive
ARG LLAMA_REF=main
ARG LLAMA_REPO=https://github.com/ggml-org/llama.cpp
# Empty uses every CPU thread.
ARG MAX_JOBS=
# gfx1100 = Navi 31, gfx1101 = Navi 32, gfx1102 = Navi 33.
ARG AMDGPU_TARGETS=gfx1100
# K-V cache type pairs compiled for flash attention (GGML_CUDA_FA_QUANTS also
# covers HIP). Upstream default plus q8_0-q4_0 (K q8_0, V q4_0); a pair that is
# not compiled cannot run on the GPU. "all" compiles every pair (much slower build).
ARG FA_QUANTS="q4_0-q4_0;q8_0-q8_0;f16-f16;bf16-bf16;q8_0-q4_0"

RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential \
        ca-certificates \
        cmake \
        git \
        libcurl4-openssl-dev \
        libssl-dev \
    && rm -rf /var/lib/apt/lists/*

# LLAMA_REPO/LLAMA_REF select the source tree (e.g. a fork). An empty LLAMA_REF, or "main" on a
# repository without a main branch (upstream uses master), builds the
# repository's default branch.
RUN git clone --filter=blob:none "${LLAMA_REPO}" /llama.cpp \
    && cd /llama.cpp \
    && ref="${LLAMA_REF}" \
    && if [ -z "$ref" ] || { [ "$ref" = "main" ] && ! git rev-parse -q --verify origin/main >/dev/null; }; then \
           ref="$(git symbolic-ref --short refs/remotes/origin/HEAD | sed 's@^origin/@@')"; \
       fi \
    && git checkout "$ref" \
    && git log -1 --format='llama.cpp source: %H %cd'

WORKDIR /llama.cpp

# Upstream removed rocWMMA flash attention (#26046) and uses its own RDNA3
# WMMA kernels, so neither rocwmma-dev nor GGML_HIP_ROCWMMA_FATTN is needed
# (forks with an older base, e.g. K2-Horizon, would need both back).
RUN HIPCXX="$(hipconfig -l)/clang" HIP_PATH="$(hipconfig -R)" \
    cmake -S . -B build \
        -DGGML_HIP=ON \
        -DGGML_CUDA_FA_QUANTS="${FA_QUANTS}" \
        -DGGML_HIP_GRAPHS=ON \
        -DGGML_NATIVE=ON \
        -DAMDGPU_TARGETS="${AMDGPU_TARGETS}" \
        -DGGML_CURL=ON \
        -DLLAMA_OPENSSL=ON \
        -DBUILD_SHARED_LIBS=OFF \
        -DCMAKE_POSITION_INDEPENDENT_CODE=ON \
        -DLLAMA_BUILD_TESTS=OFF \
        -DCMAKE_BUILD_TYPE=Release \
    && cmake --build build --config Release -j "${MAX_JOBS:-$(nproc)}"

FROM ${ROCM_IMAGE}

ARG DEBIAN_FRONTEND=noninteractive

# 1. Create a non-root user
RUN groupadd -r llama && useradd -r -g llama -m -d /home/llama llama

# rocBLAS, hipBLAS and hipBLASLt are part of the -full image (/opt/rocm).
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        libcurl4t64 \
        libgomp1 \
    && rm -rf /var/lib/apt/lists/*

# Every llama.cpp tool (llama-cli, llama-bench, llama-quantize, ...) is installed;
# llama-server stays the entrypoint.
COPY --from=builder /llama.cpp/build/bin/ /usr/local/bin/

# Kernel arguments in device memory cut per-launch latency, which bounds
# small-MoE token generation; hipBLASLt speeds up large prompt matmuls.
ENV HIP_FORCE_DEV_KERNARG=1 \
    ROCBLAS_USE_HIPBLASLT=1

# 2. Set ownership of the directory where models will be mounted (if needed)
# Ensure the user has permissions to read the /models volume
RUN mkdir -p /models && chown llama:llama /models

# 3. Switch to the non-root user
USER llama

EXPOSE 8080

ENTRYPOINT ["/usr/local/bin/llama-server"]

CMD ["--host", "0.0.0.0", "--port", "8080"]
