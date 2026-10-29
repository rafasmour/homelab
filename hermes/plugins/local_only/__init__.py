"""Local-only LLM traffic for Hermes.

Hermes' auxiliary client (session titles, compression, vision, web extract,
...) walks a built-in provider chain after a timeout or payment error:
OpenRouter (a PAID default model), Nous, local/custom, then any API-key
provider. That chain ignores the per-task provider settings, so config alone
cannot keep traffic local. This plugin replaces the cloud steps with stubs
that report "not available", leaving only the local llama.cpp endpoint.
"""

from __future__ import annotations

import logging

logger = logging.getLogger(__name__)

_CLOUD_CHAIN_LABELS = frozenset({"openrouter", "nous", "api-key"})


def _unavailable(*_args, **_kwargs):
    return None, None


def register(ctx) -> None:
    from agent import auxiliary_client as aux

    if getattr(aux, "_homelab_local_only", False):
        return
    original_chain = aux._get_provider_chain

    def local_chain():
        return [(label, fn) for label, fn in original_chain() if label not in _CLOUD_CHAIN_LABELS]

    aux._get_provider_chain = local_chain
    aux._try_openrouter = _unavailable
    aux._try_nous = _unavailable
    aux._resolve_api_key_provider = _unavailable
    aux._homelab_local_only = True
    logger.debug("local_only: cloud auxiliary providers disabled")
