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
        libcurl4-openssl-dev \
        libssl-dev \
    && rm -rf /var/lib/apt/lists/*

RUN git clone --filter=blob:none "${LLAMA_REPO}" /llama.cpp \
    && cd /llama.cpp \
    && (git checkout "${LLAMA_REF}" 2>/dev/null || git checkout -b "${LLAMA_REF}")

WORKDIR /llama.cpp

RUN cmake -S . -B build \
        -DGGML_VULKAN=OFF \
        -DGGML_CUDA=OFF \
        -DGGML_CURL=ON \
        -DLLAMA_OPENSSL=ON \
        -DBUILD_SHARED_LIBS=OFF \
        -DCMAKE_BUILD_TYPE=Release \
    && cmake --build build --config Release --target llama-server -j "${MAX_JOBS}"

FROM ubuntu:24.04

ARG DEBIAN_FRONTEND=noninteractive

RUN groupadd -r llama && useradd -r -g llama -m -d /home/llama llama

RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates \
        libcurl4t64 \
        libgomp1 \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /llama.cpp/build/bin/llama-server /usr/local/bin/llama-server

RUN mkdir -p /models && chown llama:llama /models

USER llama

EXPOSE 8080

ENTRYPOINT ["/usr/local/bin/llama-server"]

CMD ["--host", "0.0.0.0", "--port", "8080"]
