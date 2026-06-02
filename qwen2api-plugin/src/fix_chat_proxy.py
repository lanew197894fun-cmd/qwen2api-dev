import re, sys

path = r'D:\Tools\opencode\opencode-manager\projects\independent\qwen2api-dev\qwen2api-plugin\src\chat-proxy.js'
with open(path, 'r', encoding='utf-8') as f:
    lines = f.readlines()

fixed = False
for i, line in enumerate(lines):
    stripped = line.lstrip()
    if 'errors' in stripped and 'cooldown' in stripped and '\u8ff4\u8def\u65b7\u8def\u5668\u89e6\u767c' in stripped:
        indent = line[:len(line) - len(stripped)]
        inner = stripped.rstrip().rstrip(',')
        # inner is like: "..."
        fixed_line = indent + '`' + inner[1:-1] + '`' + ',\n'
        lines[i] = fixed_line
        fixed = True
        print(f'Fixed line {i+1}')
        break

if not fixed:
    print(f'Trying broader match...')
    for i, line in enumerate(lines):
        stripped = line.lstrip()
        if stripped.startswith('"') and 'errors' in stripped and 'cooldown' in stripped:
            indent = line[:len(line) - len(stripped)]
            inner = stripped.rstrip().rstrip(',')
            fixed_line = indent + '`' + inner[1:-1] + '`' + ',\n'
            lines[i] = fixed_line
            fixed = True
            print(f'Fixed line {i+1} (broad match)')
            break

if not fixed:
    print('ERROR: Could not find the problematic line')
    for i, line in enumerate(lines):
        if 'errors' in line:
            print(f'  Line {i+1}: {repr(line[:80])}')
    sys.exit(1)

with open(path, 'w', encoding='utf-8') as f:
    f.writelines(lines)
print('Done - file updated')
