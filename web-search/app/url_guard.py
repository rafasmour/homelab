from abc import ABC, abstractmethod
from dataclasses import dataclass
import ipaddress
import socket
from typing import Optional
from urllib.parse import urlsplit


class UrlRefused(Exception):
    pass


@dataclass(frozen=True)
class Target:
    host: str
    port: int
    address: Optional[str] = None

    def curl_resolve(self) -> Optional[str]:
        if self.address is None:
            return None
        address = f"[{self.address}]" if ":" in self.address else self.address
        return f"{self.host}:{self.port}:{address}"


class UrlGuard(ABC):
    @abstractmethod
    def check(self, url: str) -> Target:
        raise NotImplementedError


def _split(url: str) -> tuple[str, int]:
    parts = urlsplit(url)
    if parts.scheme not in {"http", "https"}:
        raise UrlRefused(f"refusing non-http URL: {url}")
    if not parts.hostname:
        raise UrlRefused(f"refusing URL without host: {url}")
    try:
        port = parts.port or (443 if parts.scheme == "https" else 80)
    except ValueError as exc:
        raise UrlRefused(f"refusing URL with invalid port: {url}") from exc
    return parts.hostname, port


class AllowPrivateGuard(UrlGuard):
    def check(self, url: str) -> Target:
        host, port = _split(url)
        return Target(host=host, port=port)


class PublicOnlyGuard(UrlGuard):
    def check(self, url: str) -> Target:
        host, port = _split(url)
        try:
            infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
        except (socket.gaierror, UnicodeError) as exc:
            raise UrlRefused(f"cannot resolve {host}: {exc}") from exc
        addresses = list(dict.fromkeys(info[4][0].split("%", 1)[0] for info in infos))
        if not addresses:
            raise UrlRefused(f"cannot resolve {host}")
        for address in addresses:
            ip = ipaddress.ip_address(address)
            mapped = getattr(ip, "ipv4_mapped", None)
            if mapped is not None:
                ip = mapped
            if not ip.is_global or ip.is_multicast:
                raise UrlRefused(f"refusing {host}: resolves to non-public address {ip}")
        if _is_ip_literal(host):
            return Target(host=host, port=port)
        return Target(host=host, port=port, address=addresses[0])


def _is_ip_literal(host: str) -> bool:
    try:
        ipaddress.ip_address(host)
    except ValueError:
        return False
    return True
