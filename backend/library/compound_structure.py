"""Crisp, theme-specific 2D depictions of an identified PubChem compound."""

from functools import lru_cache
import math
import re

from .pubchem import _PUBCHEM_BASE, _rate_limited_get


class StructureUnavailable(ValueError):
    pass


def draw_structure(mol_block: str, weight=1.0, element_colors=True, color=None) -> dict[str, str]:
    from rdkit import Chem
    from rdkit.Chem.Draw import rdMolDraw2D

    if isinstance(weight, bool) or not isinstance(weight, (int, float)) or not math.isfinite(weight) or not 0.5 <= weight <= 3:
        raise StructureUnavailable("Invalid structure weight")
    if type(element_colors) is not bool or (color is not None and not re.fullmatch(r'#[0-9a-fA-F]{6}', str(color))):
        raise StructureUnavailable("Invalid structure palette")
    mol = Chem.MolFromMolBlock(mol_block, sanitize=True, removeHs=True)
    if mol is None or not 1 <= mol.GetNumAtoms() <= 512:
        raise StructureUnavailable("No supported 2D molecular structure")

    # Rotate coordinates, not the SVG, so atom labels remain upright.
    if mol.GetNumConformers():
        conformer = mol.GetConformer()
        points = [conformer.GetAtomPosition(i) for i in range(mol.GetNumAtoms())]
        width = max(p.x for p in points) - min(p.x for p in points)
        height = max(p.y for p in points) - min(p.y for p in points)
        if height > width + 1e-6:
            for i, point in enumerate(points):
                conformer.SetAtomPosition(i, (-point.y, point.x, point.z))

    # Only molecular geometry is drawn; do not copy remote SDF properties/HTML.
    result = {}
    for theme in ("light", "dark"):
        drawer = rdMolDraw2D.MolDraw2DSVG(640, 480)
        options = drawer.drawOptions()
        if theme == "dark":
            rdMolDraw2D.SetDarkMode(options)
            options.updateAtomPalette({7: (0.50, 0.72, 1.0), 8: (1.0, 0.36, 0.36)})
        else:
            options.updateAtomPalette({7: (0.08, 0.22, 0.65), 8: (0.70, 0.08, 0.08)})
        ink = tuple(int(color[i:i + 2], 16) / 255 for i in (1, 3, 5)) if color else ((0.9, 0.9, 0.9) if theme == 'dark' else (0, 0, 0))
        if not element_colors:
            options.updateAtomPalette({number: ink for number in range(-1, 119)})
        elif color:
            options.updateAtomPalette({6: ink})
        options.clearBackground = False
        options.padding = 0.08
        options.fixedFontSize = round(28 * weight)
        options.bondLineWidth = 2.4 * weight
        options.scaleBondWidth = False
        options.includeMetadata = False
        rdMolDraw2D.PrepareAndDrawMolecule(drawer, mol)
        drawer.FinishDrawing()
        result[theme] = drawer.GetDrawingText()
    return result


@lru_cache(maxsize=128)
def molecule_block(cid: int) -> str:
    if isinstance(cid, bool) or not isinstance(cid, int) or not 1 <= cid <= 2147483647:
        raise StructureUnavailable("Invalid PubChem compound ID")
    raw = _rate_limited_get(f"{_PUBCHEM_BASE}/compound/cid/{cid}/SDF?record_type=2d")
    if not raw or len(raw) > 2_000_000:
        raise StructureUnavailable("PubChem structure unavailable")
    # Exceptions are intentionally not cached, so transient failures can retry.
    return raw.decode("utf-8")


@lru_cache(maxsize=128)
def compound_structure(cid: int, weight=1.0, element_colors=True, color=None) -> dict[str, str]:
    return draw_structure(molecule_block(cid), weight, element_colors, color)
