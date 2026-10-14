"""Optional IPv6 transport for PubChem; never changes process-wide DNS rules."""

from http.client import HTTPSConnection
import socket
import ssl
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPSHandler, ProxyHandler, build_opener, urlopen

_IPV6_RETRY_AT = 0.0


def ipv6_connection(address, timeout=socket._GLOBAL_DEFAULT_TIMEOUT, source_address=None):
    host, port = address
    failure = None
    for family, kind, protocol, _, endpoint in socket.getaddrinfo(
        host, port, socket.AF_INET6, socket.SOCK_STREAM
    ):
        connection = socket.socket(family, kind, protocol)
        try:
            if timeout is not socket._GLOBAL_DEFAULT_TIMEOUT:
                connection.settimeout(timeout)
            if source_address:
                connection.bind(source_address)
            connection.connect(endpoint)
            return connection
        except OSError as exc:
            failure = exc
            connection.close()
    raise failure or OSError("No IPv6 address available for PubChem")


class PubChemIPv6Connection(HTTPSConnection):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._create_connection = ipv6_connection


class PubChemIPv6Handler(HTTPSHandler):
    def https_open(self, request):
        target = urlsplit(request.full_url)
        if target.hostname != "pubchem.ncbi.nlm.nih.gov" or target.port not in (None, 443):
            raise OSError("PubChem transport refuses an unexpected destination")
        return self.do_open(PubChemIPv6Connection, request, context=ssl.create_default_context())


def open_ipv6(request, timeout):
    target = urlsplit(request.full_url)
    if target.scheme != "https" or target.hostname != "pubchem.ncbi.nlm.nih.gov":
        raise OSError("PubChem IPv6 transport requires its HTTPS API")
    # Explicit deployment opt-in uses direct IPv6, not a potentially IPv4 proxy.
    return build_opener(ProxyHandler({}), PubChemIPv6Handler()).open(request, timeout=timeout)


def open_pubchem(request, timeout):
    """Prefer opted-in IPv6, temporarily fall back when that route is unhealthy."""
    global _IPV6_RETRY_AT
    target = urlsplit(request.full_url)
    if target.scheme != 'https' or target.hostname != 'pubchem.ncbi.nlm.nih.gov' or target.port not in (None, 443):
        raise OSError('PubChem transport requires its HTTPS API')
    if time.monotonic() < _IPV6_RETRY_AT:
        return urlopen(request, timeout=timeout)
    try:
        return open_ipv6(request, timeout)
    except HTTPError as exc:
        if exc.code < 500:
            raise
        exc.close()
    except (URLError, TimeoutError, ConnectionError, OSError):
        pass
    _IPV6_RETRY_AT = time.monotonic() + 60
    return urlopen(request, timeout=timeout)
