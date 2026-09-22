import { test, expect } from 'bun:test';
import { BoxRenderable, TextRenderable, TextareaRenderable, ScrollBoxRenderable, MarkdownRenderable, SyntaxStyle } from '@opentui/core';
import { createTestRenderer } from '@opentui/core/testing';

test('selection, input, markdown and scroll in published native package', async () => {
 const t = await createTestRenderer({width:80,height:24});
 const r=t.renderer;
 try {
 const left=new BoxRenderable(r,{id:'spine',width:20,height:15,position:'absolute',left:0,top:0});
 const chat=new BoxRenderable(r,{id:'chat',width:50,height:15,position:'absolute',left:25,top:0});
 const spine=new TextRenderable(r,{content:'SPINE PRIVATE',selectable:true});
 const text=new TextRenderable(r,{content:'Hello world\nSecond line',selectable:true});
 r.root.add(left);r.root.add(chat);left.add(spine);chat.add(text);
 await t.renderOnce();
 await t.mockMouse.drag(25,0,29,0);await t.renderOnce();
 expect(r.getSelection()?.getSelectedText()).toBe('Hello');
 r.clearSelection(); await t.mockMouse.drag(30,0,4,0);await t.renderOnce();
 console.log('cross-pane selection:',JSON.stringify(r.getSelection()?.getSelectedText()));
 expect(r.getSelection()?.getSelectedText()).toContain('PRIVATE');
 spine.selectable=false; r.clearSelection(); await t.renderOnce();
 await t.mockMouse.drag(32,0,4,0);await t.renderOnce();
 expect(r.getSelection()?.getSelectedText() ?? '').not.toContain('PRIVATE');
 r.clearSelection();
 const input=new TextareaRenderable(r,{position:'absolute',top:17,width:50,height:4,initialValue:'abc\ndef'});
 r.root.add(input);input.focus();input.cursorOffset=4;
 await t.mockInput.pressBackspace();await t.renderOnce();expect(input.plainText).toBe('abcdef');
 await t.mockInput.pasteBracketedText('X\nY');await t.renderOnce();expect(input.plainText).toBe('abcX\nYdef');
 const md=new MarkdownRenderable(r,{content:'**stream',syntaxStyle:SyntaxStyle.fromStyles({}),streaming:true,width:45});
 chat.add(md);await t.renderOnce();md.content='**streamed** text\n\n- one';await t.renderOnce();md.streaming=false;await t.renderOnce();expect(t.captureCharFrame()).toContain('streamed');
 const scroll=new ScrollBoxRenderable(r,{position:'absolute',top:5,left:25,width:45,height:5,stickyScroll:true,stickyStart:'bottom'});
 r.root.add(scroll);
 for(let i=0;i<30;i++)scroll.add(new TextRenderable(r,{content:`row ${i}`,height:1}));
 await t.renderOnce();await t.renderOnce();expect(scroll.scrollTop).toBeGreaterThan(0);
 const before=scroll.scrollTop;scroll.scrollTo(2);await t.renderOnce();scroll.add(new TextRenderable(r,{content:'new row',height:1}));await t.renderOnce();await t.renderOnce();expect(scroll.scrollTop).toBe(2);
 expect(scroll.getChildren().length).toBe(31);
 console.log('sticky initial top:',before,'manual after append:',scroll.scrollTop,'retained children:',scroll.getChildren().length);
 console.log('OSC52 local dispatch:',r.copyToClipboardOSC52('neta-evaluation'));
 } finally {r.destroy();}
});
