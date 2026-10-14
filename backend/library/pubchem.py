"""PubChem PUG REST lookup helper.

NIST/AMDIS libraries store compounds under their CAS Index name (e.g.
"Resorcinol, 2-p-mentha-1,8-dien-3-yl-5-pentyl-, (-)-(E)-"), which is
authoritative but unreadable. PubChem stores the same molecules under their
common names (Cannabidiol, Δ9-THC, Cannabigerol, ...) plus thousands of
synonyms. This module resolves CAS Registry Numbers (which are present in
every NIST entry) to PubChem Compound IDs and pulls the most useful
trivial/common name back, then caches everything to disk so each compound
is only fetched from the network once.

Design notes:
- We use the public PUG REST endpoint (no API key required, ~5 req/s rate
  limit). https://pubchem.ncbi.nlm.nih.gov/docs/pug-rest
- Lookups are LAZY: we only resolve the CAS numbers that actually appear in
  user search results, not the entire library at index time. Most compounds
  in NISTDRUG/NISTTOX never appear in a typical workflow; pre-fetching them
  all would be wasteful.
- Cache lives at `server-state/pubchem_cache.json`. Negative results are
  cached too (with `pubchem_cid: None`) so we don't keep retrying compounds
  PubChem doesn't know about.
- Network failures are silent — `lookup_by_cas` returns None and the
  caller falls back to displaying the CAS Index name. No hard dependency
  on internet connectivity.
"""

from __future__ import annotations

import json
import os
import re
import threading
import time
import math
from contextlib import contextmanager
from contextvars import ContextVar
from email.utils import parsedate_to_datetime
from dataclasses import dataclass
from pathlib import Path
from typing import Optional
from urllib.parse import quote
from urllib.request import Request, urlopen
from urllib.error import URLError, HTTPError


_PUBCHEM_BASE = "https://pubchem.ncbi.nlm.nih.gov/rest/pug"
_USER_AGENT = "Atmos-LabApp/1.0 (research; per-user lookup)"
_REQUEST_TIMEOUT = 6.0    # seconds per request
_MIN_INTERVAL = 0.22      # ~4.5 req/s, under PubChem's 5 req/s limit


_CAS_PATTERN = re.compile(r"^\s*\d{1,7}-\d{2}-\d\s*$")


@dataclass
class PubChemRecord:
    cas: str
    pubchem_cid: Optional[int]
    common_name: str          # best human-readable name we found, "" if none
    iupac_name: str = ""
    synonyms_sample: list[str] = None  # type: ignore[assignment]


_CACHE_LOCK = threading.Lock()
_CACHE: Optional[dict[str, dict]] = None
_LAST_REQUEST = 0.0
_RATE_LIMIT_LOCK = threading.Lock()
_RETRY_AFTER = 0.0
_REPORT_UNAVAILABLE = ContextVar('pubchem_report_unavailable', default=False)


class PubChemUnavailable(LookupError):
    def __init__(self, retry_after=30):
        self.retry_after = max(1, math.ceil(retry_after))
        super().__init__(f'PubChem is temporarily unavailable or limiting requests. Wait at least {self.retry_after} seconds before retrying; recovery may take longer. Reloading Atmos will not fix this.')


@contextmanager
def report_unavailable():
    """Interactive lookups distinguish an outage from an unidentified compound."""
    token = _REPORT_UNAVAILABLE.set(True)
    try:
        yield
    finally:
        _REPORT_UNAVAILABLE.reset(token)


def _retry_seconds(value):
    try:
        seconds = float(value)
    except (TypeError, ValueError):
        try:
            seconds = parsedate_to_datetime(value).timestamp() - time.time()
        except (TypeError, ValueError, OverflowError):
            seconds = 30
    return max(1, math.ceil(seconds)) if math.isfinite(seconds) else 30


def _unavailable(seconds=30):
    if _REPORT_UNAVAILABLE.get():
        raise PubChemUnavailable(seconds)
    return None

# In-memory cache for the richer "compound info" popover summaries (keyed by
# CID). Separate from the on-disk CAS->name cache because these carry a free-
# text description we don't want to bloat the disk cache with; re-fetching
# after a process restart is cheap and rare.
_SUMMARY_CACHE: dict[int, dict] = {}
_SUMMARY_CACHE_LOCK = threading.Lock()


def _cache_path() -> Path:
    # Mirror the convention used elsewhere in the backend: a `server-state/`
    # directory at the repo root, gitignored, holds runtime mutable state.
    repo_root = Path(__file__).resolve().parents[2]
    state_dir = Path(os.environ.get("ATMOS_LOCAL_STATE_ROOT") or repo_root / "server-state")
    state_dir.mkdir(parents=True, exist_ok=True)
    return state_dir / "pubchem_cache.json"


def _load_cache() -> dict[str, dict]:
    global _CACHE
    if _CACHE is not None:
        return _CACHE
    path = _cache_path()
    if not path.exists():
        _CACHE = {}
        return _CACHE
    try:
        with path.open("r", encoding="utf-8") as handle:
            _CACHE = json.load(handle)
    except Exception:
        _CACHE = {}
    if not isinstance(_CACHE, dict):
        _CACHE = {}
    return _CACHE


def _save_cache() -> None:
    if _CACHE is None:
        return
    path = _cache_path()
    tmp = path.with_suffix(".tmp")
    try:
        with tmp.open("w", encoding="utf-8") as handle:
            json.dump(_CACHE, handle, indent=2, sort_keys=True)
        tmp.replace(path)
    except Exception:
        # Best-effort: a write failure shouldn't break a search request.
        try:
            tmp.unlink()
        except Exception:
            pass


def _normalize_cas(cas: str) -> str:
    if not cas:
        return ""
    cleaned = str(cas).strip()
    if cleaned.isascii() and cleaned.isdigit() and 5 <= len(cleaned) <= 10:
        cleaned = f"{cleaned[:-3]}-{cleaned[-3:-1]}-{cleaned[-1]}"
    if not _CAS_PATTERN.fullmatch(cleaned):
        return ""
    digits = cleaned.replace("-", "")
    checksum = sum(int(digit) * weight for weight, digit in enumerate(reversed(digits[:-1]), 1)) % 10
    return cleaned if checksum == int(digits[-1]) else ""


def _rate_limited_get(url: str) -> Optional[bytes]:
    """Single-threaded request with a small inter-request delay so we stay
    under PubChem's published rate limit (5 req/s)."""
    global _LAST_REQUEST, _RETRY_AFTER
    with _RATE_LIMIT_LOCK:
        now = time.monotonic()
        if now < _RETRY_AFTER:
            return _unavailable(_RETRY_AFTER - now)
        wait = (_LAST_REQUEST + _MIN_INTERVAL) - now
        if wait > 0:
            time.sleep(wait)
        try:
            req = Request(url, headers={"User-Agent": _USER_AGENT, "Accept": "application/json"})
            request_open = urlopen
            if os.environ.get("ATMOS_PUBCHEM_IPV6") == "1":
                from .pubchem_transport import open_pubchem
                request_open = open_pubchem
            with request_open(req, timeout=_REQUEST_TIMEOUT) as response:
                if response.status != 200:
                    return None
                return response.read()
        except HTTPError as exc:
            if exc.code == 404:
                return None
            seconds = _retry_seconds(exc.headers.get('Retry-After') if exc.headers else None)
            if exc.code == 429 or exc.code >= 500:
                _RETRY_AFTER = time.monotonic() + seconds
            return _unavailable(seconds)
        except (URLError, TimeoutError, ConnectionError, OSError):
            _RETRY_AFTER = time.monotonic() + 30
            return _unavailable()
        finally:
            _LAST_REQUEST = time.monotonic()


def _resolve_cid_from_cas(cas: str) -> Optional[int]:
    # PUG REST: get CID(s) registered against this CAS RN.
    url = f"{_PUBCHEM_BASE}/compound/name/{quote(cas)}/cids/JSON"
    raw = _rate_limited_get(url)
    if not raw:
        return None
    try:
        payload = json.loads(raw.decode("utf-8"))
    except Exception:
        return None
    cids = (payload.get("IdentifierList") or {}).get("CID") or []
    if not cids:
        return None
    # An ambiguous identifier must not silently rename a different isomer.
    unique = set(cids)
    return int(cids[0]) if len(unique) == 1 else None


def _fetch_synonyms_and_iupac(cid: int) -> tuple[list[str], str]:
    syn_url = f"{_PUBCHEM_BASE}/compound/cid/{cid}/synonyms/JSON"
    iupac_url = f"{_PUBCHEM_BASE}/compound/cid/{cid}/property/IUPACName/JSON"
    raw = _rate_limited_get(syn_url)
    synonyms: list[str] = []
    if raw:
        try:
            payload = json.loads(raw.decode("utf-8"))
            entries = (payload.get("InformationList") or {}).get("Information") or []
            if entries:
                synonyms = list(entries[0].get("Synonym") or [])
        except Exception:
            synonyms = []
    iupac = ""
    raw_iupac = _rate_limited_get(iupac_url)
    if raw_iupac:
        try:
            payload = json.loads(raw_iupac.decode("utf-8"))
            props = (payload.get("PropertyTable") or {}).get("Properties") or []
            if props:
                iupac = str(props[0].get("IUPACName") or "")
        except Exception:
            iupac = ""
    return synonyms, iupac


def readable_common_name(value: str) -> str:
    name = str(value or '').strip()
    if re.match(r'^(?:GLYTOUCAN|CHEBI|PUBCHEM|HMDB|KEGG|DTXSID|SCHEMBL|CHEMBL|ZINC|UNII)(?:[:\s-]|\d)', name, re.I):
        return ''
    return name


def _looks_like_database_id(name: str) -> bool:
    upper = name.upper()
    prefixes = ("CHEBI:", "CHEMBL", "DTXSID", "SCHEMBL", "DB", "AKOS", "MFCD",
                "EINECS", "UNII-", "NSC ", "NSC-", "BRN ", "HSDB", "WLN:",
                "NCGC", "BIDD:", "PUBCHEM", "ZINC", "EC ", "CCRIS", "GLYTOUCAN:")
    if any(upper.startswith(prefix) for prefix in prefixes):
        return True
    # Pure CAS-style numbers ("123-45-6")
    if _CAS_PATTERN.match(name):
        return True
    # Mostly digits / hyphens (catalog numbers)
    digit_ratio = sum(ch.isdigit() for ch in name) / max(len(name), 1)
    if digit_ratio >= 0.3:
        return True
    # UNII-style codes: 10 chars, all uppercase alnum, mix of letters and digits.
    # PubChem lists the bare UNII code as a synonym (without a "UNII-" prefix)
    # for many compounds. Same shape catches FDA codes, CAS catalog tags, etc.
    compact = name.replace(" ", "").replace("-", "")
    if (
        5 <= len(compact) <= 12
        and compact.isalnum()
        and compact.isupper()
        and any(ch.isdigit() for ch in compact)
        and any(ch.isalpha() for ch in compact)
        and " " not in name
    ):
        return True
    return False

def _looks_like_systematic(name: str) -> bool:
    # CAS Index style: starts with a parent ring name, comma, then substituents.
    # Or has lots of brackets/locants/parens.
    if "," in name and len(name) > 25:
        return True
    if name.count("(") >= 3 or name.count("-") >= 4:
        return True
    return False


def _pick_common_name(synonyms: list[str], cas: str) -> str:
    """PubChem's synonym list is ranked roughly by usage frequency, but the
    very first entries are often trade codes (e.g. "CHEBI:69478"), CAS RNs,
    or vendor catalog numbers. Filter those out and prefer something a human
    would actually recognize: short, alphabetic, no commas/parens/dashes
    suggesting a systematic name."""
    if not synonyms:
        return ""

    candidates = [
        s.strip() for s in synonyms
        if s and s.strip() and not _looks_like_database_id(s.strip())
    ]
    if not candidates:
        return ""
    # PubChem's synonym list is roughly ranked by source authority/usage —
    # for the compounds we care about, the FIRST non-junk entry is almost
    # always the canonical trivial name ("cannabidiol", "acetic acid",
    # "sucrose"). So we preserve PubChem's natural ordering and just walk
    # past obvious noise. Earlier I sorted by length and got "ACY" beating
    # "acetic acid" — never doing that again.
    for candidate in candidates:
        if not _looks_like_systematic(candidate):
            return _normalize_display(candidate)
    # Every survivor is systematic-looking. Take the shortest as a last resort.
    return _normalize_display(min(candidates, key=len))


def _normalize_display(name: str) -> str:
    """Make a PubChem synonym display-ready.

    Three cases handled:
    - Short acronyms ('CBD', 'THC', 'ATP'): leave them alone, they're correct.
    - All/mostly UPPERCASE chemical names ('CANNABICHROMENE', '1,4-DIOXANE'):
      lowercase the body and capitalize the first alphabetic character →
      'Cannabichromene', '1,4-Dioxane'.
    - Already mixed/lowercase ('cannabidiol', 'D-glucose'): just ensure the
      first alphabetic char is uppercase.
    """
    if not name:
        return name
    name = name.strip()
    alpha_chars = [c for c in name if c.isalpha()]
    if not alpha_chars:
        return name
    # Short all-uppercase code → likely an acronym (CBD/THC/ATP/DNA). Keep.
    if len(alpha_chars) <= 5 and all(c.isupper() for c in alpha_chars):
        return name
    upper_ratio = sum(1 for c in alpha_chars if c.isupper()) / len(alpha_chars)
    if upper_ratio > 0.7:
        # Mostly uppercase — render as sentence case.
        lowered = name.lower()
        for i, ch in enumerate(lowered):
            if ch.isalpha():
                return lowered[:i] + ch.upper() + lowered[i + 1:]
        return lowered
    # Mixed case already → trust it.
    if any(c.isupper() for c in name[:5]):
        return name
    # All-lowercase → capitalize the first alphabetic char.
    for i, ch in enumerate(name):
        if ch.isalpha():
            return name[:i] + ch.upper() + name[i + 1:]
    return name


def lookup_by_cas(cas: str, allow_network: bool = True) -> Optional[PubChemRecord]:
    """Resolve a CAS RN to a PubChem record. Cache-first; only hits the
    network on a miss (and only if `allow_network` is True). Returns None if
    the CAS is malformed or no match is found and we couldn't or wouldn't
    look it up online."""
    normalized = _normalize_cas(cas)
    if not normalized:
        return None

    with _CACHE_LOCK:
        cache = _load_cache()
        cached = cache.get(normalized)
        if cached is not None and (cached.get("common_name") or not allow_network):
            return PubChemRecord(
                cas=normalized,
                pubchem_cid=cached.get("pubchem_cid"),
                common_name=readable_common_name(cached.get("common_name")) or _pick_common_name(cached.get("synonyms_sample") or [], normalized),
                iupac_name=cached.get("iupac_name") or "",
                synonyms_sample=cached.get("synonyms_sample") or [],
            )
        if not allow_network:
            return None

    # Out-of-cache lookup. We hold the cache lock only during the read/write
    # bookends so concurrent searches can fan out network calls in parallel.
    cid = (cached or {}).get("pubchem_cid") or _resolve_cid_from_cas(normalized)
    record_dict: dict
    if cid is None:
        record_dict = {"pubchem_cid": None, "common_name": "", "iupac_name": "", "synonyms_sample": []}
    else:
        synonyms, iupac = _fetch_synonyms_and_iupac(cid)
        common_name = _pick_common_name(synonyms, normalized)
        record_dict = {
            "pubchem_cid": cid,
            "common_name": common_name,
            "iupac_name": iupac,
            "synonyms_sample": synonyms[:10],  # keep it small on disk
        }

    with _CACHE_LOCK:
        cache = _load_cache()
        # A transient PubChem failure must not permanently suppress names.
        if record_dict.get("common_name"):
            cache[normalized] = record_dict
            _save_cache()

    return PubChemRecord(
        cas=normalized,
        pubchem_cid=record_dict["pubchem_cid"],
        common_name=record_dict["common_name"],
        iupac_name=record_dict["iupac_name"],
        synonyms_sample=record_dict["synonyms_sample"],
    )


def common_name_choices(cas: str = "", cid: Optional[int] = None, name: str = "", limit: int = 12) -> dict:
    """Readable PubChem synonyms for the user's common-name picker, in
    PubChem's ranking with trivial names before systematic ones. Only called
    on an explicit user request; the pick is saved as a custom label."""
    normalized = _normalize_cas(cas) if cas else ""
    resolved_cid = cid
    if not resolved_cid and normalized:
        record = lookup_by_cas(normalized, allow_network=True)
        resolved_cid = record.pubchem_cid if record else None
    if not resolved_cid and name:
        resolved_cid = _resolve_cid_from_name(name)
    if not resolved_cid:
        return {"pubchem_cid": None, "choices": []}
    synonyms, _iupac = _fetch_synonyms_and_iupac(int(resolved_cid))
    readable = [s.strip() for s in synonyms if s and s.strip() and not _looks_like_database_id(s.strip())]
    ordered = [s for s in readable if not _looks_like_systematic(s)] + [s for s in readable if _looks_like_systematic(s)]
    choices: list[str] = []
    seen: set[str] = set()
    for synonym in ordered:
        display = _normalize_display(synonym)
        key = display.lower()
        if display and key not in seen:
            seen.add(key)
            choices.append(display)
        if len(choices) >= limit:
            break
    return {"pubchem_cid": int(resolved_cid), "choices": choices}


def warm_cache(cas_list: list[str], allow_network: bool = True) -> dict[str, Optional[PubChemRecord]]:
    """Resolve a batch of CAS numbers, returning a dict keyed by the input CAS.
    Mostly a convenience for callers that want to enrich a list of search hits."""
    out: dict[str, Optional[PubChemRecord]] = {}
    for cas in cas_list:
        out[cas] = lookup_by_cas(cas, allow_network=allow_network)
    return out


def _resolve_cid_from_name(name: str) -> Optional[int]:
    """Best-effort name -> CID. Same PUG REST name endpoint used for CAS
    (CAS RNs are just registered as names), so common/trivial names resolve
    too. Returns the first (parent) CID or None."""
    if not name or not name.strip():
        return None
    url = f"{_PUBCHEM_BASE}/compound/name/{quote(name.strip())}/cids/JSON"
    raw = _rate_limited_get(url)
    if not raw:
        return None
    try:
        payload = json.loads(raw.decode("utf-8"))
    except Exception:
        return None
    cids = (payload.get("IdentifierList") or {}).get("CID") or []
    if not cids:
        return None
    return int(cids[0])


def _fetch_description(cid: int) -> tuple[str, str, str]:
    """Return (description_text, source_name, source_url) for a CID, picking
    the first Information entry that actually carries a Description (the first
    entry is often just the title with no text)."""
    url = f"{_PUBCHEM_BASE}/compound/cid/{cid}/description/JSON"
    raw = _rate_limited_get(url)
    if not raw:
        return "", "", ""
    try:
        payload = json.loads(raw.decode("utf-8"))
    except Exception:
        return "", "", ""
    entries = (payload.get("InformationList") or {}).get("Information") or []
    for entry in entries:
        desc = (entry.get("Description") or "").strip()
        if desc:
            return (
                desc,
                str(entry.get("DescriptionSourceName") or ""),
                str(entry.get("DescriptionURL") or ""),
            )
    return "", "", ""


def _fetch_basic_properties(cid: int) -> dict:
    url = f"{_PUBCHEM_BASE}/compound/cid/{cid}/property/MolecularFormula,MolecularWeight,IUPACName/JSON"
    raw = _rate_limited_get(url)
    if not raw:
        return {}
    try:
        payload = json.loads(raw.decode("utf-8"))
    except Exception:
        return {}
    props = (payload.get("PropertyTable") or {}).get("Properties") or []
    return props[0] if props else {}


def compound_summary(
    cid: Optional[int] = None,
    cas: str = "",
    name: str = "",
    allow_network: bool = True,
) -> Optional[dict]:
    """Build the 'Compound info' popover payload for a library match. Resolves
    a CID (preferring an explicit cid, then CAS, then name), then pulls a
    free-text description + key properties from PubChem. Cached in-memory per
    CID for the life of the process. Returns None only when no CID can be
    resolved at all; network hiccups degrade to a partial summary."""
    resolved_cid: Optional[int] = None
    if cid:
        try:
            resolved_cid = int(cid)
        except (TypeError, ValueError):
            resolved_cid = None
    if resolved_cid is None:
        normalized = _normalize_cas(cas)
        if normalized:
            record = lookup_by_cas(normalized, allow_network=allow_network)
            if record and record.pubchem_cid:
                resolved_cid = int(record.pubchem_cid)
    if resolved_cid is None and name and allow_network:
        resolved_cid = _resolve_cid_from_name(name)
    if resolved_cid is None:
        return None

    with _SUMMARY_CACHE_LOCK:
        cached = _SUMMARY_CACHE.get(resolved_cid)
        if cached is not None:
            return cached
    if not allow_network:
        return None

    description, source_name, source_url = _fetch_description(resolved_cid)
    props = _fetch_basic_properties(resolved_cid)
    summary = {
        "pubchem_cid": resolved_cid,
        "title": _normalize_display(name) if name else "",
        "iupac_name": str(props.get("IUPACName") or ""),
        "formula": str(props.get("MolecularFormula") or ""),
        "mol_weight": str(props.get("MolecularWeight") or ""),
        "description": description,
        "source_name": source_name,
        "source_url": source_url or f"https://pubchem.ncbi.nlm.nih.gov/compound/{resolved_cid}",
        "pubchem_url": f"https://pubchem.ncbi.nlm.nih.gov/compound/{resolved_cid}",
    }
    with _SUMMARY_CACHE_LOCK:
        _SUMMARY_CACHE[resolved_cid] = summary
    return summary


def cache_stats() -> dict:
    with _CACHE_LOCK:
        cache = _load_cache()
        total = len(cache)
        with_cid = sum(1 for v in cache.values() if v.get("pubchem_cid"))
        with_name = sum(1 for v in cache.values() if v.get("common_name"))
        return {
            "entries": total,
            "with_pubchem_cid": with_cid,
            "with_common_name": with_name,
            "path": str(_cache_path()),
        }
