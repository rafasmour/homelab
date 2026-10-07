# syntax=docker/dockerfile:1

FROM ubuntu:24.04 AS builder

ARG DEBIAN_FRONTEND=noninteractive
ARG LLAMA_REF=main
ARG LLAMA_REPO=https://github.com/ggml-org/llama.cpp
ARG MAX_JOBS=4

RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential \
        ca-certificates \
        cmake \
        git \
        glslc \
        libcurl4-openssl-dev \
        libssl-dev \
        libvulkan-dev \
        spirv-headers \
    && rm -rf /var/lib/apt/lists/*

RUN git clone --filter=blob:none "${LLAMA_REPO}" /llama.cpp \
    && cd /llama.cpp \
    && (git checkout "${LLAMA_REF}" 2>/dev/null || git checkout -b "${LLAMA_REF}")

# Backport XHToken's upstream spark2_5 support (PR #27868) onto trees that
# predate it, e.g. the MBZUAI-IFM K2Horizon branch. Automatically skipped
# when the patches do not apply (already merged upstream).
COPY patches/ /tmp/patches/

RUN cd /llama.cpp \
    && (git apply --check /tmp/patches/spark2_5-27868-clean.patch /tmp/patches/spark2_5-ifm-fixes.patch 2>/dev/null \
        && git apply /tmp/patches/spark2_5-27868-clean.patch /tmp/patches/spark2_5-ifm-fixes.patch \
        && echo "spark2_5 support patches applied (upstream PR #27868)" \
        || echo "spark2_5 patches skipped (already present or incompatible)")

WORKDIR /llama.cpp

RUN cmake -S . -B build \
        -DGGML_VULKAN=ON \
        -DGGML_CURL=ON \
        -DLLAMA_OPENSSL=ON \
        -DBUILD_SHARED_LIBS=OFF \
        -DCMAKE_BUILD_TYPE=Release \
    && cmake --build build --config Release --target llama-server -j "${MAX_JOBS}"

FROM ubuntu:24.04

ARG DEBIAN_FRONTEND=noninteractive

# 1. Create a non-root user
RUN groupadd -r llama && useradd -r -g llama -m -d /home/llama llama

RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates \
        libcurl4t64 \
        libgomp1 \
        libvulkan1 \
        mesa-vulkan-drivers \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /llama.cpp/build/bin/llama-server /usr/local/bin/llama-server

# 2. Set ownership of the directory where models will be mounted (if needed)
# Ensure the user has permissions to read the /models volume
RUN mkdir -p /models && chown llama:llama /models

# 3. Switch to the non-root user
USER llama

EXPOSE 8080

ENTRYPOINT ["/usr/local/bin/llama-server"]

CMD ["--host", "0.0.0.0", "--port", "8080"]
