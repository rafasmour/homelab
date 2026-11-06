# audio.cpp text-to-speech server, Vulkan "portable" build (the regular
# Vulkan build dies with "Illegal instruction" on this Zen 1 CPU). Mesa RADV
# drives the AMD GPU through /dev/dri; eSpeak-ng is Kokoro's phonemizer.
FROM ubuntu:24.04

ARG AUDIOCPP_VERSION=v0.9.3

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates curl libgomp1 libvulkan1 mesa-vulkan-drivers \
        libespeak-ng1 espeak-ng-data python3 \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /opt/audiocpp \
    && curl -fsSL "https://github.com/0xShug0/audio.cpp/releases/download/${AUDIOCPP_VERSION}/audio-${AUDIOCPP_VERSION}-bin-ubuntu-x64-vulkan-portable.tar.gz" \
        | tar xz -C /opt/audiocpp \
    && test -x /opt/audiocpp/audiocpp_server

ENV LD_LIBRARY_PATH=/opt/audiocpp \
    AUDIOCPP_ESPEAK_LIBRARY=/usr/lib/x86_64-linux-gnu/libespeak-ng.so.1 \
    AUDIOCPP_ESPEAK_DATA=/usr/lib/x86_64-linux-gnu/espeak-ng-data

COPY discover.py /opt/audiocpp/discover.py

# uid 1000 owns ./models on the host.
USER 1000:1000
EXPOSE 8080
# discover.py adds every text-to-speech model under /models to the config,
# then execs audiocpp_server with the generated /tmp/server.json.
ENTRYPOINT ["python3", "/opt/audiocpp/discover.py"]
CMD ["--config", "/config/server.json"]
