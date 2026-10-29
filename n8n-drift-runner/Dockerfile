ARG PYTHON_VERSION=3.13.17
FROM python:${PYTHON_VERSION}-alpine

# The drift script needs bash, curl, jq and GNU diff/cmp; the webhook server is
# plain standard-library Python.
RUN apk add --no-cache bash curl jq diffutils \
 && mkdir /app
COPY server.py /app/server.py
WORKDIR /app
USER 65534:65534
CMD ["python", "-u", "/app/server.py"]
