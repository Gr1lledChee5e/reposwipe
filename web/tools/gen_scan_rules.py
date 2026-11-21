#!/usr/bin/env python3
"""Editable source of the Skill Swipe safety-scan rules. Writes ../scan_rules.json.

One rule set, two engines: scan.py (the scouts, in the hourly job) and the app (src.html, on demand before a
fork or an AI send). Every pattern must be valid in BOTH Python `re` and JavaScript RegExp:
no lookbehind, no named groups, no inline flags, no [\\s\\S] tricks that differ. Flags are given separately.

Levels: 2 = danger (kept out of the feed; fork / AI-send blocked unless the person overrides)
        1 = caution (shown with an amber badge and the reason)
This is a heuristic check of a handful of key files. It can miss things and it can be wrong.
Usage: python3 tools/gen_scan_rules.py
"""
import json, os, re

LEVELS = {
    # danger
    "hook-exec": 2, "config-pipe-shell": 2, "encoded-exec": 2, "reverse-shell": 2, "stealer": 2,
    "inject-stealth-exfil": 2, "hidden-text": 2, "clone-cluster": 2,
    # caution
    "hook-net": 1, "pipe-shell": 1, "ps-download-exec": 1, "cred-read": 1, "exfil-chan": 1, "miner": 1, "secret-leak": 1,
    "inject-override": 1, "inject-secrecy": 1, "inject-exfil": 1, "bidi-control": 1, "zero-width": 1,
    "setup-net": 1, "obfuscated": 1, "tree-exe": 1, "tree-env": 1, "tree-key": 1, "tree-dump": 1, "meta-abuse": 1,
}

# which files get read (matched against the lower-cased repo path); "max" caps how many per class
FILES = [
    {"cls": "pkg", "re": r"^(package\.json|setup\.py)$", "max": 2},
    {"cls": "config", "re": r"^(\.claude/settings(\.local)?\.json|\.mcp\.json|mcp\.json|\.claude-plugin/plugin\.json|hooks/hooks\.json|\.cursor/mcp\.json)$", "max": 4},
    {"cls": "skill", "re": r"^(claude|agents|gemini)\.md$|^\.cursorrules$|^\.github/copilot-instructions\.md$", "max": 3},
    {"cls": "skill", "re": r"(^|/)skill\.md$", "max": 4},
    {"cls": "skill", "re": r"^\.claude/(commands|agents|skills)/.+\.md$|^\.cursor/rules/[^/]+\.mdc?$", "max": 3},
    {"cls": "install", "re": r"^([^/]+/)?(install|setup|bootstrap|postinstall|preinstall)[\w.-]*\.(sh|bash|ps1|js|cjs|mjs|py)$", "max": 3},
    {"cls": "code", "re": r"^(src/)?(index|main|cli|server|app)\.(js|mjs|cjs|ts|py)$", "max": 3},
    {"cls": "code", "re": r"^(scripts|hooks|bin)/[^/]+\.(sh|py|js|mjs)$", "max": 3},
]
# when the file list can't be fetched (API quota spent), these well-known paths are tried directly instead
FALLBACK_PATHS = ["package.json", "setup.py", "SKILL.md", "CLAUDE.md", "AGENTS.md", ".cursorrules", ".mcp.json", ".claude/settings.json",
                  ".claude-plugin/plugin.json", "hooks/hooks.json", "install.sh", "setup.sh", "index.js", "main.py", "src/index.js", "src/index.ts"]
MAX_FILES = 14
MAX_BYTES = 200000      # read at most this much of each file
MAX_FILE_SIZE = 400000  # skip files the tree says are bigger than this

ALL = ["pkg", "install", "skill", "code", "config"]
EXEC = ["pkg", "install", "code", "config"]

KNOWN_INSTALLERS = r"sh\.rustup\.rs|astral\.sh|bun\.sh|get\.docker\.com|deno\.land|ollama\.com|get\.pnpm\.io|install\.python-poetry\.org|fnm\.vercel\.app|claude\.ai/install|mise\.run|brew\.sh|Homebrew/install|nvm-sh/nvm|get\.helm\.sh|tailscale\.com/install"

CONTENT = [
    # a remote script piped straight into a shell. Not checked inside install scripts themselves (their own usage line
    # "curl …/install.sh | sh" is noise) and not for the famous installers everyone uses.
    {"code": "pipe-shell", "in": ["skill", "pkg"], "flags": "i",
     "re": r"\b(curl|wget)\b(?![^\n|]{0,200}(" + KNOWN_INSTALLERS + r"))[^\n|;&]{0,200}\|\s*(sudo\s+)?(ba|z|da)?sh\b"},
    {"code": "config-pipe-shell", "in": ["config"], "flags": "i",
     "re": r"\b(curl|wget)\b[^\n|;&]{0,200}\|\s*(sudo\s+)?(ba|z|da)?sh\b"},
    {"code": "ps-download-exec", "in": ["skill", "pkg", "config"], "flags": "i",
     "re": r"\b(iwr|irm|invoke-webrequest|invoke-restmethod|downloadstring|downloadfile)\b(?![^\n|]{0,200}(" + KNOWN_INSTALLERS + r"))[^\n]{0,200}\b(iex|invoke-expression|start-process)\b|\biex\s*\(\s*\(?\s*(iwr|irm|new-object)\b"},
    # code that decodes a hidden payload and runs it
    {"code": "encoded-exec", "in": ALL, "flags": "i",
     "re": r"\beval\s*\(\s*(atob|unescape)\s*\(|\beval\s*\(\s*Buffer\.from\s*\([^)\n]{0,400}base64|\bnew\s+Function\s*\(\s*atob\s*\("},
    {"code": "encoded-exec", "in": ALL, "flags": "i",
     "re": r"\bexec\s*\(\s*(base64\.b64decode|zlib\.decompress|marshal\.loads|bytes\.fromhex|codecs\.decode|compile\s*\(\s*(base64|zlib|marshal)\.|__import__\s*\(\s*['\"](base64|zlib|marshal)['\"]\s*\))"},
    {"code": "encoded-exec", "in": ALL, "flags": "i",
     "re": r"\bbase64\s+(-d|--decode)\b[^\n|]{0,120}\|\s*(sudo\s+)?(ba|z)?sh\b"},
    {"code": "reverse-shell", "in": ALL, "flags": "i",
     # an interactive shell wired to a socket. A bare /dev/tcp/host/port is only a port check and is not flagged.
     "re": r"\b(ba)?sh\s+-i\b[^\n]{0,80}/dev/(tcp|udp)/|/dev/(tcp|udp)/\S+\s+0>&1|\bnc(at)?\s+(-\w+\s+){0,3}-e\s+/bin/(ba)?sh\b|\bexec\s+\d+<>\s*/dev/tcp/(?!127\.|localhost)[\w.-]+/\d+"},
    # credential stores + places stolen data is usually sent
    {"code": "cred-read", "in": EXEC, "flags": "i",
     "re": r"\.ssh/id_(rsa|ed25519|ecdsa|dsa)(?!\.pub)\b|\.aws/credentials\b|\bwallet\.dat\b|/Login Data\b|\.git-credentials\b|\.docker/config\.json|\.config/gcloud/(credentials|application_default)|Library/Keychains"},
    {"code": "exfil-chan", "in": ALL, "flags": "i",
     "re": r"discord(app)?\.com/api/webhooks/\d+/[\w-]{20,}|api\.telegram\.org/bot\d{6,}:[\w-]{20,}|webhook\.site/[\w-]{8,}|\b[\w-]+\.requestcatcher\.com|\b[\w-]+\.m\.pipedream\.net|\binteract\.sh\b|burpcollaborator\.net|transfer\.sh/|pastebin\.com/raw/|\b[\w-]+\.ngrok(-free)?\.(io|app|dev)\b"},
    {"code": "miner", "in": EXEC, "flags": "i",
     "re": r"stratum\+(tcp|ssl)://|\bxmrig\b|\bcoinhive\b|\bcryptonight\b|--donate-level\b"},
    # secrets committed to the repo (case-sensitive)
    {"code": "secret-leak", "in": ALL, "flags": "",
     "re": r"\bAKIA(?!IOSFODNN7EXAMPLE)[0-9A-Z]{16}\b|-----BEGIN (RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----|\bghp_[A-Za-z0-9]{36}\b|\bgithub_pat_[A-Za-z0-9_]{50,}|\bsk-ant-[A-Za-z0-9_-]{40,}|\bxox[bap]-[0-9A-Za-z-]{24,}|\bAIza[0-9A-Za-z_-]{35}\b|\bsk_live_[0-9A-Za-z]{20,}"},
    # instructions aimed at the AI that reads the file (skills, agent rules, commands)
    {"code": "inject-override", "in": ["skill"], "flags": "i",
     "re": r"\b(ignore|disregard|forget|override)\s+(all\s+|any\s+|the\s+|your\s+)?(previous|prior|above|earlier|preceding|system|original)\s+(instructions?|prompts?|rules|guidelines|directives)\b"},
    {"code": "inject-secrecy", "in": ["skill"], "flags": "i",
     "re": r"\b(do\s+not|don't|never)\s+(tell|inform|mention|reveal|disclose|notify|alert)\b[^\n.]{0,30}\bthe\s+user\b|\bwithout\s+(telling|informing|notifying|alerting)\s+the\s+user\b|\b(hide|conceal)\s+(this|it|these|that)\s+from\s+the\s+user\b"},
    {"code": "inject-exfil", "in": ["skill", "config"], "flags": "i",
     "re": r"\b(send|post|upload|forward|exfiltrate|transmit|email)\b[^\n]{0,100}\b(api[ _-]?keys?|access[ _-]?tokens?|passwords?|credentials|secrets|\.env|ssh[ _-]?keys?|private[ _-]?keys?|session[ _-]?cookies?|environment\s+variables)\b[^\n]{0,100}\b(to|at|via)\s+(https?://|[\w.+-]+@[\w-]+\.[\w.-]+)"},
    # install-time network access in setup.py
    {"code": "setup-net", "in": ["pkg"], "path": r"^setup\.py$", "flags": "",
     "re": r"\burlopen\s*\(|\brequests\.(get|post)\s*\(|\bsocket\.socket\s*\(|\burlretrieve\s*\("},
    # machine-obfuscated source
    {"code": "obfuscated", "in": ["install", "code", "pkg"], "flags": "", "min": 25, "re": r"\b_0x[a-f0-9]{4,6}\b"},
    {"code": "obfuscated", "in": ["install", "code", "pkg"], "flags": "", "re": r"(chr\(\d{2,3}\)\s*\+\s*){6,}"},
]

# install hooks in package.json — these run on `npm install`, before anyone reads the code.
# danger (hook-exec): the hook pipes something into a shell, decodes a payload, or opens a remote socket.
# caution (hook-net): the hook reaches the network. Plain `node -e "…"` version checks and git-hook installers are
# everywhere in legitimate packages (letta-code, hermes-agent, MCPJam inspector…) and must NOT trip either rule.
HOOK_KEYS = ["preinstall", "install", "postinstall", "prepare"]
HOOK_RE = r"\|\s*(sudo\s+)?(ba|z|da)?sh\b|\bbase64\s+(-d|--decode)\b|\b(iex|invoke-expression)\b|\batob\s*\(|Buffer\.from\([^)]{0,200}base64|/dev/tcp/(?!127\.|localhost)[\w.-]+/\d+"
HOOK_NET_RE = r"\b(curl|wget|powershell|pwsh)\b|https?://|\bfetch\s*\(|require\(\s*['\"]https?['\"]\s*\)"
HOOK_SCRIPT_RE = r"\b(?:node|sh|bash|python3?)\s+(\.?/?[\w./-]+\.(?:js|cjs|mjs|sh|py))\b"

# two caution signals in the same file that together are a known-bad pattern
COMBOS = [
    {"code": "stealer", "all": ["cred-read", "exfil-chan"]},
    {"code": "inject-stealth-exfil", "all": ["inject-secrecy", "inject-exfil"]},
]

TREE = [
    {"code": "tree-exe", "re": r"\.(exe|scr|pif|msi|vbs|hta|lnk)$"},
    {"code": "tree-env", "re": r"^\.env(\.local|\.production|\.prod)?$"},   # repo root only — nested ones are almost always test fixtures
    {"code": "tree-key", "re": r"(^|/)(id_rsa|id_ed25519|id_ecdsa)$|\.(p12|pfx|keystore|jks)$|(^|/)service[-_]account[\w.-]*\.json$"},
    {"code": "tree-dump", "re": r"\.(sql|sqlite|sqlite3|bak|dump|mdb)$", "minSize": 5000000},
]

META = [
    {"code": "meta-abuse", "flags": "i",
     "re": r"\b(stealer|keylogger|ransomware|botnet|crypter|aimbot|wallhack|keygen|booter|stresser|token[ -]?grabber|wallet[ -]?drainer|free robux|cracked|phishing (kit|page|template)|ddos (tool|script|attack tool)|hwid (spoofer|bypass)|game cheat|cheat (engine|menu|loader)|account (checker|generator))\b"},
]

# clone campaigns: near-identical repos published together by different accounts with matching star counts
# (a fake-star / malware-distribution pattern). Needs a population, so it runs on lists, not on single repos.
CLUSTER = {"minTokens": 3, "jaccard": 0.6, "days": 3, "starRatio": 0.85, "minStars": 30, "minSize": 3}

# hidden characters: counted in code, not by regex (astral ranges differ between the two engines)
UNICODE = {"tagMin": 10, "zeroWidthMin": 20, "bidiIn": ["skill", "code", "config", "install", "pkg"], "zeroWidthIn": ["skill", "config"]}

out = {"version": 1, "levels": LEVELS, "files": FILES, "maxFiles": MAX_FILES, "maxBytes": MAX_BYTES, "maxFileSize": MAX_FILE_SIZE,
       "content": CONTENT, "hookKeys": HOOK_KEYS, "hookRe": HOOK_RE, "hookNetRe": HOOK_NET_RE, "hookScriptRe": HOOK_SCRIPT_RE, "combos": COMBOS,
       "tree": TREE, "meta": META, "unicode": UNICODE, "fallbackPaths": FALLBACK_PATHS, "cluster": CLUSTER}

for r in CONTENT + TREE + META + FILES: re.compile(r["re"])          # must compile in Python…
re.compile(HOOK_RE); re.compile(HOOK_NET_RE); re.compile(HOOK_SCRIPT_RE)
for r in CONTENT + TREE + META: assert r["code"] in LEVELS, r["code"]
for c in COMBOS: assert c["code"] in LEVELS
dst = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "scan_rules.json")
json.dump(out, open(dst, "w", encoding="utf-8"), indent=1)
print("wrote scan_rules.json:", len(CONTENT), "content rules,", len(TREE), "tree rules,", len(META), "meta rules")
