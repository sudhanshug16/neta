use agent_client_protocol_schema::v1::SessionUpdate;
use bitrouter_tui::{editor::Editor, journal::{Journal, Entry}, render::{self, Registry, ToolContext}};
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use ratatui::{Terminal, backend::TestBackend, layout::{Rect, Size}, widgets::{Paragraph, Wrap}};
fn main() -> Result<(), Box<dyn std::error::Error>> {
 let mut journal=Journal::default();
 let updates=std::fs::read_to_string("/private/tmp/neta-acp-eval/updates.ndjson")?;
 for line in updates.lines() { journal.apply(serde_json::from_str::<SessionUpdate>(line)?); }
 journal.finish_stream();
 let entries=journal.entries().count(); assert!(entries>=4);
 let registry=Registry::default();
 for width in [1u16,2,7,20,40,80] {
  let mut terminal=Terminal::new(TestBackend::new(width+20,80))?;
  terminal.draw(|frame| { frame.render_widget(Paragraph::new("SPINE SENTINEL\nunchanged"),Rect::new(0,0,20,80)); })?;
  let baseline=terminal.backend().buffer().clone();
  terminal.draw(|frame| {
   frame.render_widget(Paragraph::new("SPINE SENTINEL\nunchanged"),Rect::new(0,0,20,80));
   let mut lines=Vec::new();
   for item in journal.entries() { lines.extend(match item.entry {
    Entry::Message(m)=>render::message(m,width),
    Entry::Tool(t)=>registry.render(&ToolContext::new(t,Size::new(width,24))),
    Entry::Plan(p)=>render::session::plan(p),
   }); }
   lines.extend(render::markdown::render("# Unicode\n界界 👨‍👩‍👧‍👦 é\n```rust\nlet x = 1;\n```",width));
   frame.render_widget(Paragraph::new(lines).wrap(Wrap {trim:false}),Rect::new(20,0,width,80));
  })?;
  let buffer=terminal.backend().buffer();
  for y in 0..80 { for x in 0..20 { assert_eq!(buffer[(x,y)],baseline[(x,y)],"spill at {x},{y}, width {width}"); } }
  if width==80 {
   let visible=(0..80).map(|y|(20..100).map(|x|buffer[(x,y)].symbol()).collect::<String>()).collect::<Vec<_>>().join("\n");
   for expected in ["First paragraph continues.","Edit config.json","cancelled"] { assert!(visible.contains(expected),"missing {expected}: {visible}"); }
  }
  if width==40 {std::fs::write("/private/tmp/neta-acp-eval/render.txt",format!("{buffer:?}"))?;}
 }
 let mut editor=Editor::default(); editor.paste("first\n界👨‍👩‍👧‍👦");
 editor.apply(KeyEvent::new(KeyCode::Backspace,KeyModifiers::NONE));
 assert_eq!(editor.text(),"first\n界");
 editor.apply(KeyEvent::new(KeyCode::Backspace,KeyModifiers::NONE));
 assert_eq!(editor.text(),"first\n");
 println!("PASS: {} fake ACP updates, {entries} entries, 6 offset Rect widths, left spine intact, multiline paste and grapheme backspace", updates.lines().count());
 Ok(())
}
