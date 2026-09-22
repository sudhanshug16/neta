"""Render `tmux capture-pane -e -p` cells without dropping ANSI colors.

Requires Pillow. Usage: python3 scripts/render-tui-capture.py capture.ansi
Writes PNG + a JSON cell grid for deterministic color/placement assertions.
The output is a terminal-cell rendering, not a screenshot of a GUI terminal.
"""
import json
import re
import sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

PALETTE = ['#000000','#800000','#008000','#808000','#000080','#800080','#008080','#c0c0c0',
           '#808080','#ff0000','#00ff00','#ffff00','#0000ff','#ff00ff','#00ffff','#ffffff']

def color256(index):
    if index < 16: return PALETTE[index]
    if index >= 232:
        value=8+(index-232)*10
        return '#%02x%02x%02x' % (value,value,value)
    index-=16
    steps=[0,95,135,175,215,255]
    return '#%02x%02x%02x' % (steps[index//36],steps[(index//6)%6],steps[index%6])

def cells(source):
    fg,bg,bold,reverse='#e5e7eb','#111315',False,False
    rows=[]
    for line in source.splitlines():
        row=[]
        for part in re.split(r'(\x1b\[[0-9;:]*m)',line):
            if part.startswith('\x1b['):
                codes=[int(value or '0') for value in part[2:-1].replace(':',';').split(';')]
                index=0
                while index<len(codes):
                    code=codes[index];index+=1
                    if code==0: fg,bg,bold,reverse='#e5e7eb','#111315',False,False
                    elif code==1: bold=True
                    elif code==22: bold=False
                    elif code==7: reverse=True
                    elif code==27: reverse=False
                    elif code==39: fg='#e5e7eb'
                    elif code==49: bg='#111315'
                    elif 30<=code<=37: fg=PALETTE[code-30]
                    elif 40<=code<=47: bg=PALETTE[code-40]
                    elif 90<=code<=97: fg=PALETTE[code-90+8]
                    elif 100<=code<=107: bg=PALETTE[code-100+8]
                    elif code in (38,48):
                        mode=codes[index];index+=1
                        if mode==5: color=color256(codes[index]);index+=1
                        elif mode==2: color='#%02x%02x%02x'%tuple(codes[index:index+3]);index+=3
                        else: raise ValueError('Unsupported SGR color mode')
                        if code==38: fg=color
                        else: bg=color
                continue
            for char in part:
                if ord(char)<32: raise ValueError('Unexpected terminal control in pane capture')
                row.append({'text':char,'fg':bg if reverse else fg,'bg':fg if reverse else bg,'bold':bold})
        rows.append(row)
    return rows

if __name__=='__main__':
    # Fixed cell geometry makes before/after captures comparable. The terminal
    # chooses its font; Menlo is the portable local macOS verification font.
    normal=ImageFont.truetype('/System/Library/Fonts/Menlo.ttc',14,index=0)
    bold=ImageFont.truetype('/System/Library/Fonts/Menlo.ttc',14,index=1)
    for arg in sys.argv[1:]:
        path=Path(arg);rows=cells(path.read_text());width=max(map(len,rows))
        im=Image.new('RGB',(width*9,len(rows)*20),'#111315');draw=ImageDraw.Draw(im)
        for y,row in enumerate(rows):
            for x,cell in enumerate(row):
                draw.rectangle((x*9,y*20,(x+1)*9-1,(y+1)*20-1),fill=cell['bg'])
                draw.text((x*9,y*20+1),cell['text'],font=bold if cell['bold'] else normal,fill=cell['fg'])
        im.save(path.with_suffix('.png'));path.with_suffix('.cells.json').write_text(json.dumps(rows))
