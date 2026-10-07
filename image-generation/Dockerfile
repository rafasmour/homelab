FROM ubuntu:24.04 AS build

ARG SD_CPP_REF=master

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential ca-certificates cmake curl git glslc gnupg libvulkan-dev \
    spirv-headers && \
    mkdir -p /etc/apt/keyrings && \
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
      -o /tmp/nodesource-repo.gpg.key && \
    gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg /tmp/nodesource-repo.gpg.key && \
    rm /tmp/nodesource-repo.gpg.key && \
    echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main" \
      > /etc/apt/sources.list.d/nodesource.list && \
    apt-get update && apt-get install -y --no-install-recommends nodejs && \
    npm install -g pnpm@10.15.1 && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /src
RUN git clone --depth 1 --branch "${SD_CPP_REF}" --recurse-submodules \
    https://github.com/leejet/stable-diffusion.cpp.git .

RUN cmake -S . -B build \
      -DSD_VULKAN=ON \
      -DSD_SERVER_BUILD_FRONTEND=ON \
      -DGGML_NATIVE=OFF \
      -DCMAKE_BUILD_TYPE=Release && \
    cmake --build build --parallel

FROM ubuntu:24.04

RUN apt-get update && apt-get install -y --no-install-recommends \
    libgomp1 libvulkan1 mesa-vulkan-drivers && \
    rm -rf /var/lib/apt/lists/*

COPY --from=build /src/build/bin /sd.cpp/bin
COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod 0755 /docker-entrypoint.sh

EXPOSE 1234
ENTRYPOINT ["/docker-entrypoint.sh"]
