"""Bounded PubChem candidate search; a formula is never a unique identity."""

import json
import re
from functools import lru_cache
from urllib.parse import quote

from .pubchem import _PUBCHEM_BASE, _rate_limited_get

MAX_RESULTS = 12


def normalize_formula(value: str) -> str:
    from rdkit import Chem

    compact = re.sub(r"\s+", "", value)
    tokens = re.findall(r"([A-Za-z][a-z]?)([0-9]*)", compact)
    if not tokens or "".join(symbol + count for symbol, count in tokens) != compact:
        raise ValueError("Enter an elemental formula such as C7H4 or C10H14N2")
    symbols = {Chem.GetPeriodicTable().GetElementSymbol(i) for i in range(1, 119)}
    normalized = []
    for symbol, count in tokens:
        symbol = symbol.capitalize()
        if symbol not in symbols or (count and not 1 <= int(count) <= 1000):
            raise ValueError("Invalid element or atom count in formula")
        normalized.append(symbol + (str(int(count)) if count else ""))
    return "".join(normalized)


def search_input(query: str, kind: str = "auto") -> tuple[str, str]:
    query = query.strip()
    if not 1 <= len(query) <= 180 or kind not in {"auto", "name", "formula"}:
        raise ValueError("Enter a compound name or formula (up to 180 characters)")
    if kind == "formula":
        return normalize_formula(query), "formula"
    if kind == "auto" and (any(ch.isdigit() for ch in query) or query[:1].isupper()):
        try:
            formula = normalize_formula(query)
            # Names such as Nicotine also happen to split into element symbols.
            if any(ch.isdigit() for ch in query) or formula == re.sub(r"\s+", "", query):
                return formula, "formula"
        except ValueError:
            pass
    return query, "name"


def _json(url):
    raw = _rate_limited_get(url)
    if not raw:
        # Existing PubChem transport returns None for both 404 and outages.
        # Do not negative-cache either: users must be able to retry.
        raise LookupError("No PubChem response or no matching compounds. Try another name or retry.")
    if len(raw) > 2_000_000:
        raise LookupError("PubChem returned too many results. Use a more specific query.")
    try:
        result = json.loads(raw)
        if not isinstance(result, dict):
            raise ValueError('Expected a PubChem response object')
        return result
    except (ValueError, TypeError) as exc:
        raise LookupError('Invalid PubChem response. Please retry.') from exc


@lru_cache(maxsize=128)
def _search(query: str, kind: str) -> dict:
    namespace = "fastformula" if kind == "formula" else "name"
    payload = _json(f"{_PUBCHEM_BASE}/compound/{namespace}/{quote(query, safe='')}/cids/JSON"
                    f"?MaxRecords={MAX_RESULTS + 1}&MaxSeconds=4")
    cids = list(dict.fromkeys(cid for cid in (payload.get("IdentifierList") or {}).get("CID", [])
                            if isinstance(cid, int) and not isinstance(cid, bool) and 0 < cid <= 2147483647))
    if not cids:
        return {"results": [], "truncated": False}
    selected = cids[:MAX_RESULTS]
    props = _json(f"{_PUBCHEM_BASE}/compound/cid/{','.join(map(str, selected))}"
                  "/property/Title,MolecularFormula,IUPACName/JSON")
    results = []
    for item in (props.get("PropertyTable") or {}).get("Properties", []):
        if item.get("CID") not in selected:
            continue
        results.append({"cid": item["CID"], "name": str(item.get("Title") or item.get("IUPACName") or f"CID {item['CID']}")[:300],
                        "formula": str(item.get("MolecularFormula") or "")[:180],
                        "iupac_name": str(item.get("IUPACName") or "")[:1000]})
    return {"results": results, "truncated": len(cids) > MAX_RESULTS}


def search_compounds(query: str, kind: str = "auto") -> dict:
    normalized, resolved_kind = search_input(query, kind)
    return {"query": normalized, "kind": resolved_kind, **_search(normalized, resolved_kind)}
