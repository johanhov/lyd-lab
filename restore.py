import json
import os

log_path = "/Users/johanhovda/.gemini/antigravity/brain/1a44d9b4-0673-4631-b052-daaba389b5a7/.system_generated/logs/overview.txt"
with open(log_path, 'r', encoding='utf-8') as f:
    lines = f.readlines()

content = ""
found = False
for i, line in enumerate(lines):
    if "TargetFile: /Users/johanhovda/Documents/monsteroppgaver.html" in line or "TargetFile: file:///Users/johanhovda/Documents/monsteroppgaver.html" in line or "monsteroppgaver.html" in line:
        pass # just to see

with open(log_path, 'r', encoding='utf-8') as f:
    full_text = f.read()

# Let's search for the big block of React code
idx = full_text.rfind('import React, { useState, useEffect, useLayoutEffect, useRef, useMemo } from \'react\';')
if idx != -1:
    print(f"Found code at idx {idx}")
    end_idx = full_text.find('export default App;', idx)
    if end_idx == -1:
        end_idx = full_text.find('// Render the app', idx)
    if end_idx == -1:
        # just grab the next 150000 chars
        end_idx = idx + 100000
    
    code = full_text[idx:end_idx]
    with open('/Users/johanhovda/Documents/monsteroppgaver_recovered.txt', 'w', encoding='utf-8') as out:
        out.write(code)
    print("Recovered!")
else:
    print("Could not find the start of the code.")
