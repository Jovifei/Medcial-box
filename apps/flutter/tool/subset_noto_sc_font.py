"""Create the bundled static Simplified Chinese PDF font from Noto Sans SC.

Run with fontTools installed:
  python tool/subset_noto_sc_font.py INPUT.ttf OUTPUT.ttf
The input is the official Noto Sans SC variable TTF. The output remains under
the upstream SIL Open Font License; keep the bundled license file alongside it.
"""

import sys
from pathlib import Path

from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont


def main() -> None:
    if len(sys.argv) != 3:
        raise SystemExit("Usage: subset_noto_sc_font.py INPUT.ttf OUTPUT.ttf")
    source = Path(sys.argv[1])
    target = Path(sys.argv[2])
    font = TTFont(source)
    axes = {axis.axisTag: axis.defaultValue for axis in font["fvar"].axes}
    if "wght" in axes:
        axes["wght"] = 400
    font = instantiateVariableFont(font, axes, inplace=False)
    ranges = (
        (0x0020, 0x024F), (0x0370, 0x052F), (0x2000, 0x206F), (0x20A0, 0x20CF),
        (0x2100, 0x214F), (0x2190, 0x22FF), (0x2600, 0x26FF),
        (0x3000, 0x303F), (0x3040, 0x30FF), (0x3400, 0x4DBF),
        (0x4E00, 0x9FFF), (0xF900, 0xFAFF), (0xFE30, 0xFE4F),
        (0xFF00, 0xFFEF),
    )
    codepoints = [
        value for value in font.getBestCmap()
        if any(start <= value <= end for start, end in ranges)
    ]
    options = subset.Options()
    options.name_IDs = [0, 1, 2, 3, 4, 5, 6, 8, 13, 14, 16, 17]
    options.name_legacy = True
    options.notdef_glyph = True
    options.notdef_outline = True
    subsetter = subset.Subsetter(options=options)
    subsetter.populate(unicodes=codepoints)
    subsetter.subset(font)
    renamed = {
        1: "MedBox Sans SC", 2: "Regular", 4: "MedBox Sans SC",
        6: "MedBoxSansSC-Regular", 16: "MedBox Sans SC", 17: "Regular",
    }
    for record in font["name"].names:
        value = renamed.get(record.nameID)
        if value is not None:
            record.string = value.encode(record.getEncoding(), errors="replace")
    font.flavor = None
    target.parent.mkdir(parents=True, exist_ok=True)
    font.save(target)
    print(f"Wrote {target} ({target.stat().st_size} bytes; {len(font.getBestCmap())} codepoints)")


if __name__ == "__main__":
    main()
