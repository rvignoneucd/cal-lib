"""Parser for Agilent ChemStation `acqmeth.txt` files.

Each `.D` folder Agilent ChemStation writes also drops a human-readable
copy of the acquisition method as `acqmeth.txt`. The file is sectioned
text with key:value lines and small tables. We extract the parameters
the Atmos3D Theatre viewer needs to render a methods-accurate playback:

  - Oven program: initial temp + hold, then list of (rate, final_temp,
    final_hold) ramps. Drives the animated heat envelope.
  - Solvent delay: detector dark until this RT.
  - Carrier gas + inlet temp + flow rate.
  - Column dimensions (length, ID, film thickness, stationary phase).
  - MS acquisition: low/high mass, threshold, data rate (Hz), tune.
  - Total run time (computed if not stated).

The parser is forgiving — every field is optional, every section is
optional. Returns a `MethodPlan` dict; missing fields fall through to
None / [].
"""
from __future__ import annotations

import re
from dataclasses import asdict, dataclass, field
from pathlib import Path


@dataclass
class OvenRamp:
    """One stage of the oven program. `rate` is °C/min; final_time is the
    hold-at-final-temp duration in minutes."""
    rate: float
    final_temp: float
    final_time: float


@dataclass
class MethodPlan:
    # Oven program — initial conditions + ordered list of subsequent ramps.
    oven_initial_temp_c: float | None = None
    oven_initial_time_min: float | None = None
    oven_max_temp_c: float | None = None
    oven_ramps: list[OvenRamp] = field(default_factory=list)
    oven_post_temp_c: float | None = None
    oven_post_time_min: float | None = None
    total_run_time_min: float | None = None

    # Inlet / carrier gas
    inlet_mode: str = ""
    inlet_temp_c: float | None = None
    inlet_pressure_psi: float | None = None
    carrier_gas: str = ""
    carrier_flow_ml_min: float | None = None
    flow_mode: str = ""   # e.g. "constant flow"

    # Column geometry
    column_model: str = ""
    column_phase: str = ""
    column_length_m: float | None = None
    column_id_um: float | None = None
    column_film_thickness_um: float | None = None
    column_inventory: str = ""
    column_max_temp_c: float | None = None

    # MS scan parameters
    acq_mode: str = ""
    solvent_delay_min: float | None = None
    scan_low_mass: float | None = None
    scan_high_mass: float | None = None
    scan_threshold: int | None = None
    scan_samples: int | None = None
    scan_a_d_samples: int | None = None
    em_voltage: float | None = None
    em_gain_factor: float | None = None
    tune_file: str = ""

    # Bookkeeping
    method_path: str = ""
    instrument_model: str = ""
    instrument_serial: str = ""
    source_file: str = ""


_TEMP_LINE = re.compile(r"Initial\s+temp:\s+(-?\d+(?:\.\d+)?)", re.IGNORECASE)
_INITIAL_TIME = re.compile(r"Initial\s+time:\s+(-?\d+(?:\.\d+)?)", re.IGNORECASE)
_MAX_TEMP = re.compile(r"Maximum\s+temp:\s+(-?\d+(?:\.\d+)?)", re.IGNORECASE)
_POST_TEMP = re.compile(r"Post\s+temp:\s+(-?\d+(?:\.\d+)?)", re.IGNORECASE)
_POST_TIME = re.compile(r"Post\s+time:\s+(-?\d+(?:\.\d+)?)", re.IGNORECASE)
_RUN_TIME = re.compile(r"Run\s+time:\s+(-?\d+(?:\.\d+)?)", re.IGNORECASE)
_SOLVENT_DELAY = re.compile(r"Solvent\s+Delay\s*:\s*(-?\d+(?:\.\d+)?)", re.IGNORECASE)
_LOW_MASS = re.compile(r"Low\s+Mass\s*:\s*(-?\d+(?:\.\d+)?)", re.IGNORECASE)
_HIGH_MASS = re.compile(r"High\s+Mass\s*:\s*(-?\d+(?:\.\d+)?)", re.IGNORECASE)
_THRESHOLD = re.compile(r"Threshold\s*:\s*(\d+)", re.IGNORECASE)
_TUNE_FILE = re.compile(r"Tune\s+File\s*:\s*(\S+)", re.IGNORECASE)
_ACQ_MODE = re.compile(r"Acquistion\s+Mode\s*:\s*(\S+)", re.IGNORECASE)  # NB: ChemStation typo
_ACQ_MODE_FALLBACK = re.compile(r"Acquisition\s+Mode\s*:\s*(\S+)", re.IGNORECASE)
_EMV = re.compile(r"Resulting\s+EM\s+Voltage\s*:\s*(-?\d+(?:\.\d+)?)", re.IGNORECASE)
_GAIN = re.compile(r"Gain\s+Factor\s*:\s*(-?\d+(?:\.\d+)?)", re.IGNORECASE)
# Inlet `Mode:` is the first whitespace-bounded token after the colon.
# The acqmeth.txt file glues FRONT INLET and BACK INLET columns side-by-
# side on the same line ("Mode:  Splitless    Mode:  Split"), so an
# unbounded `[A-Za-z /]+` capture would greedily slurp past the first
# value into the second one.
_INLET_MODE = re.compile(r"Mode\s*:\s+([A-Za-z][A-Za-z\-/]+)", re.IGNORECASE)
_INLET_TEMP = re.compile(r"Initial\s+temp:\s+(-?\d+(?:\.\d+)?)\s*'?[Cc]?\s*\(On\)", re.IGNORECASE)
_INLET_PRESSURE = re.compile(r"Pressure:\s+(-?\d+(?:\.\d+)?)\s*psi", re.IGNORECASE)
_GAS_TYPE = re.compile(r"Gas\s+type:\s+(\w+)", re.IGNORECASE)
_INIT_FLOW = re.compile(r"Initial\s+flow:\s+(-?\d+(?:\.\d+)?)", re.IGNORECASE)
_FLOW_MODE = re.compile(r"Mode:\s+(constant\s+\w+|ramped\s+\w+)", re.IGNORECASE)
_COL_LENGTH = re.compile(r"Nominal\s+length:\s+(-?\d+(?:\.\d+)?)\s*m", re.IGNORECASE)
_COL_ID = re.compile(r"Nominal\s+diameter:\s+(-?\d+(?:\.\d+)?)\s*um", re.IGNORECASE)
_COL_FILM = re.compile(r"Nominal\s+film\s+thickness:\s+(-?\d+(?:\.\d+)?)\s*um", re.IGNORECASE)
_COL_MAX = re.compile(r"Max\s+temperature:\s+(-?\d+(?:\.\d+)?)", re.IGNORECASE)
_COL_MODEL = re.compile(r"Model\s+Number:\s+(\S+)", re.IGNORECASE)
_COL_INVENTORY = re.compile(r"Inventory\s+Number\s*:\s+(\S+)", re.IGNORECASE)
_RAMP_ROW = re.compile(
    r"^\s*(\d+)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s*$"
)


def _coerce_float(match: re.Match | None) -> float | None:
    if not match:
        return None
    try:
        return float(match.group(1))
    except (TypeError, ValueError):
        return None


def parse_acqmeth(text: str) -> MethodPlan:
    """Parse the textual contents of an `acqmeth.txt` file.

    Walks the file in a single pass, identifies the GC oven block, GC
    inlet block, column block, and MS acquisition block by their text
    headers, and applies the appropriate regex inside each. Returns a
    fully-populated `MethodPlan` (missing fields → None).
    """
    plan = MethodPlan()
    lines = text.splitlines()

    # Track which section we're in so block-local regex aren't confused
    # by similar-looking lines elsewhere.
    section: str = ""

    # Oven ramps table — we detect rows by matching the
    # `<index> <rate> <final_temp> <final_time>` shape and only
    # collect inside the oven block.
    in_oven = False
    collecting_ramps = False

    for raw_line in lines:
        line = raw_line.rstrip()
        stripped = line.strip()
        upper = stripped.upper()

        if not plan.method_path and re.match(r'^[A-Za-z]:[\\/].+\.M$', stripped, re.IGNORECASE):
            plan.method_path = stripped
        model = re.fullmatch(r'(\d+\w*)\s+GC METHOD', stripped, re.IGNORECASE)
        if model and not plan.instrument_model:
            plan.instrument_model = model.group(1)
        serial = re.search(r'TUNE PARAMETERS for SN:\s*(\S+)', stripped, re.IGNORECASE)
        if serial and not plan.instrument_serial:
            plan.instrument_serial = serial.group(1)

        # Section markers
        if upper == "OVEN":
            section = "oven"
            in_oven = True
            collecting_ramps = False
            continue
        if "FRONT INLET" in upper and "SPLIT" in upper:
            section = "inlet"
            in_oven = False
            continue
        if upper.startswith("COLUMN 1"):
            section = "column"
            in_oven = False
            continue
        if re.match(r'^COLUMN\s+[2-9]\b', upper):
            section = 'other_column'
            in_oven = False
            continue
        if "MS ACQUISITION PARAMETERS" in upper:
            section = "ms"
            in_oven = False
            continue
        if "TUNE PARAMETERS" in upper:
            section = "tune"
            in_oven = False
            continue

        # Universal extractors (these appear once and the regex is
        # selective enough to avoid false positives).
        m = _SOLVENT_DELAY.search(line)
        if m and plan.solvent_delay_min is None:
            plan.solvent_delay_min = _coerce_float(m)
        m = _RUN_TIME.search(line)
        if m and plan.total_run_time_min is None:
            plan.total_run_time_min = _coerce_float(m)

        # Oven block ----------------------------------------------------
        if section == "oven":
            m = _TEMP_LINE.search(line)
            if m and plan.oven_initial_temp_c is None:
                plan.oven_initial_temp_c = _coerce_float(m)
            m = _INITIAL_TIME.search(line)
            if m and plan.oven_initial_time_min is None:
                plan.oven_initial_time_min = _coerce_float(m)
            m = _MAX_TEMP.search(line)
            if m and plan.oven_max_temp_c is None:
                plan.oven_max_temp_c = _coerce_float(m)
            m = _POST_TEMP.search(line)
            if m and plan.oven_post_temp_c is None:
                plan.oven_post_temp_c = _coerce_float(m)
            m = _POST_TIME.search(line)
            if m and plan.oven_post_time_min is None:
                plan.oven_post_time_min = _coerce_float(m)
            if "Ramps:" in stripped:
                collecting_ramps = True
                continue
            if collecting_ramps:
                row = _RAMP_ROW.match(stripped)
                if row:
                    rate = float(row.group(2))
                    final_temp = float(row.group(3))
                    final_time = float(row.group(4))
                    # ChemStation marks "(Off)" ramps in the table as
                    # zero rate. Stop collecting at the first one.
                    if rate <= 0:
                        collecting_ramps = False
                        continue
                    plan.oven_ramps.append(OvenRamp(rate=rate, final_temp=final_temp, final_time=final_time))
                    continue
                # Non-row line ends the ramp table.
                if stripped and "Rate" not in stripped and "Final" not in stripped:
                    collecting_ramps = False

        # Inlet block ----------------------------------------------------
        if section == "inlet":
            if plan.inlet_mode == "":
                m = _INLET_MODE.search(line)
                if m:
                    # First match captures the inlet mode like "Splitless".
                    candidate = m.group(1).strip().rstrip("/").strip()
                    if candidate.lower() not in {"constant flow", "ramped flow"}:
                        plan.inlet_mode = candidate
            m = _INLET_TEMP.search(line)
            if m and plan.inlet_temp_c is None:
                plan.inlet_temp_c = _coerce_float(m)
            m = _INLET_PRESSURE.search(line)
            if m and plan.inlet_pressure_psi is None:
                plan.inlet_pressure_psi = _coerce_float(m)
            m = _GAS_TYPE.search(line)
            if m and not plan.carrier_gas:
                plan.carrier_gas = m.group(1)
            m = _INIT_FLOW.search(line)
            if m and plan.carrier_flow_ml_min is None:
                plan.carrier_flow_ml_min = _coerce_float(m)
            m = _FLOW_MODE.search(line)
            if m and not plan.flow_mode:
                plan.flow_mode = m.group(1)

        # Column block ---------------------------------------------------
        # Carrier-flow params live HERE in ChemStation's layout (not in the
        # inlet block, despite what one would intuit) — so do the lookups
        # in this section.
        if section == "column":
            m = _INIT_FLOW.search(line)
            if m and plan.carrier_flow_ml_min is None:
                plan.carrier_flow_ml_min = _coerce_float(m)
            m = _FLOW_MODE.search(line)
            if m and not plan.flow_mode:
                plan.flow_mode = m.group(1)
            m = _COL_LENGTH.search(line)
            if m and plan.column_length_m is None:
                plan.column_length_m = _coerce_float(m)
            m = _COL_ID.search(line)
            if m and plan.column_id_um is None:
                plan.column_id_um = _coerce_float(m)
            m = _COL_FILM.search(line)
            if m and plan.column_film_thickness_um is None:
                plan.column_film_thickness_um = _coerce_float(m)
            m = _COL_MAX.search(line)
            if m and plan.column_max_temp_c is None:
                plan.column_max_temp_c = _coerce_float(m)
            m = _COL_MODEL.search(line)
            if m and not plan.column_model:
                plan.column_model = m.group(1)
            m = _COL_INVENTORY.search(line)
            if m and not plan.column_inventory:
                plan.column_inventory = m.group(1)
            # Stationary phase description usually appears on a line that
            # mentions HP-5MS / DB-5 / etc. Detect by keyword.
            if not plan.column_phase:
                low = stripped.lower()
                if any(k in low for k in ("phenyl methyl siloxane", "methylpolysiloxane", "polyethylene glycol", "wax")):
                    plan.column_phase = stripped

        # MS acquisition block ------------------------------------------
        if section == "ms":
            m = _ACQ_MODE.search(line) or _ACQ_MODE_FALLBACK.search(line)
            if m and not plan.acq_mode:
                plan.acq_mode = m.group(1)
            m = _LOW_MASS.search(line)
            if m and plan.scan_low_mass is None:
                plan.scan_low_mass = _coerce_float(m)
            m = _HIGH_MASS.search(line)
            if m and plan.scan_high_mass is None:
                plan.scan_high_mass = _coerce_float(m)
            m = _THRESHOLD.search(line)
            if m and plan.scan_threshold is None:
                plan.scan_threshold = int(m.group(1))
            m = _TUNE_FILE.search(line)
            if m and not plan.tune_file:
                plan.tune_file = m.group(1)
            m = _EMV.search(line)
            if m and plan.em_voltage is None:
                plan.em_voltage = _coerce_float(m)
            m = _GAIN.search(line)
            if m and plan.em_gain_factor is None:
                plan.em_gain_factor = _coerce_float(m)
            if "Sample #" in stripped:
                sample_match = re.search(r"Sample\s+#\s*:\s*(\d+)", stripped)
                ad_match = re.search(r"A/D\s+Samples\s+(\d+)", stripped)
                if sample_match and plan.scan_samples is None:
                    plan.scan_samples = int(sample_match.group(1))
                if ad_match and plan.scan_a_d_samples is None:
                    plan.scan_a_d_samples = int(ad_match.group(1))

    # If total run time wasn't explicitly given but we have the initial
    # hold + ramp + hold sequence, compute it from the program.
    if plan.total_run_time_min is None and plan.oven_initial_time_min is not None and plan.oven_initial_temp_c is not None and plan.oven_ramps:
        current_temp = plan.oven_initial_temp_c
        elapsed = plan.oven_initial_time_min
        for ramp in plan.oven_ramps:
            delta = abs(ramp.final_temp - current_temp)
            ramp_time = delta / ramp.rate if ramp.rate > 0 else 0
            elapsed += ramp_time + ramp.final_time
            current_temp = ramp.final_temp
        plan.total_run_time_min = round(elapsed, 4)

    return plan


def parse_acqmeth_file(path: str | Path) -> MethodPlan:
    """Parse an `acqmeth.txt` file at the given path."""
    path = Path(path)
    text = path.read_text(encoding="utf-8", errors="ignore")
    plan = parse_acqmeth(text)
    plan.source_file = str(path)
    if not plan.method_path:
        plan.method_path = str(path.parent)
    return plan


def temperature_at_minute(plan: MethodPlan, t_min: float) -> float | None:
    """Return the oven temperature at scene time `t_min` (minutes).

    Drives the Theatre viewer's oven envelope color. Walks the oven
    program stage by stage: initial hold → ramp 1 → hold 1 → ramp 2 → …
    Beyond the end of the program, returns the final final_temp (the
    oven stays at the last ramp temperature during post-run).
    """
    if plan.oven_initial_temp_c is None:
        return None
    if t_min < 0:
        return plan.oven_initial_temp_c
    current_temp = plan.oven_initial_temp_c
    elapsed = 0.0
    initial_hold = plan.oven_initial_time_min or 0.0
    if t_min <= initial_hold:
        return current_temp
    elapsed += initial_hold
    for ramp in plan.oven_ramps:
        if ramp.rate <= 0:
            continue
        delta = ramp.final_temp - current_temp
        ramp_time = abs(delta) / ramp.rate
        if t_min < elapsed + ramp_time:
            frac = (t_min - elapsed) / ramp_time
            return current_temp + delta * frac
        elapsed += ramp_time
        current_temp = ramp.final_temp
        if t_min < elapsed + ramp.final_time:
            return current_temp
        elapsed += ramp.final_time
    return current_temp


def plan_to_dict(plan: MethodPlan) -> dict:
    """Convert MethodPlan to a JSON-serializable dict (dataclasses.asdict
    handles the nested OvenRamp list automatically)."""
    return asdict(plan)


if __name__ == "__main__":
    import json
    import sys
    if len(sys.argv) < 2:
        print("usage: python chemstation_method.py <acqmeth.txt>")
        sys.exit(2)
    plan = parse_acqmeth_file(sys.argv[1])
    print(json.dumps(plan_to_dict(plan), indent=2))
