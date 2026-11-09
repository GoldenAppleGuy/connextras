#!/usr/bin/env python3
"""Package extension/ for Firefox and for Chrome/Edge, at the repo root.

Usage: python build.py
Output, next to this script:
  connextras-<version>.xpi         Firefox (addons.mozilla.org)
  connextras-<version>-chrome.zip  Chrome Web Store / Edge Add-ons: the same
                                   files, minus the Firefox-only manifest
                                   section (browser_specific_settings)

Code between `// @dev-only:start` and `// @dev-only:end` lines in .js files
(e.g. the test bridge used by dev/wf.mjs) is left out of the package; it
only exists when the source folder is loaded directly.
"""
import json
import os
import re
import zipfile

ROOT = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(ROOT, "extension")
DEV_BLOCK = re.compile(r"^[ \t]*// @dev-only:start.*?^[ \t]*// @dev-only:end[^\n]*\n", re.S | re.M)


def strip_dev(name, text):
    out = DEV_BLOCK.sub("", text)
    if "@dev-only" in out:
        raise SystemExit(f"{name}: unbalanced @dev-only markers")
    return out


with open(os.path.join(SRC, "manifest.json"), encoding="utf-8") as f:
    version = json.load(f)["version"]


def package(out, manifest_text):
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for name in sorted(os.listdir(SRC)):
            path = os.path.join(SRC, name)
            if name == "manifest.json":
                z.writestr(name, manifest_text)
            elif name.endswith(".js"):
                with open(path, encoding="utf-8") as f:
                    z.writestr(name, strip_dev(name, f.read()))
            else:
                z.write(path, name)
    print(f"wrote {out}")


with open(os.path.join(SRC, "manifest.json"), encoding="utf-8") as f:
    manifest_text = f.read()
manifest = json.loads(manifest_text)
package(os.path.join(ROOT, f"connextras-{version}.xpi"), manifest_text)
chrome = {k: v for k, v in manifest.items() if k != "browser_specific_settings"}
chrome_text = json.dumps(chrome, indent=2, ensure_ascii=False) + "\n"
package(os.path.join(ROOT, f"connextras-{version}-chrome.zip"), chrome_text)
