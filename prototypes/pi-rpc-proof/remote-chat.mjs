// Version-pinned composition of upstream components, driven only by RPC events.
import { spawn } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import { Container, Text, SelectList } from '@earendil-works/pi-tui';
import { createInteractiveTui } from '../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/tui-renderer.js';
import { CustomEditor } from '../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/custom-editor.js';
import { UserMessageComponent } from '../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/user-message.js';
import { AssistantMessageComponent } from '../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/assistant-message.js';
import { ToolExecutionComponent } from '../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/tool-execution.js';
import { KeybindingsManager } from '../../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js';
import { initTheme, getEditorTheme, getSelectListTheme } from '../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js';

const options = JSON.parse(process.argv[2]);
initTheme('dark');
class RemoteChatMode {
  constructor() {
    this.ui = createInteractiveTui({ tuiMode: 'main', showHardwareCursor: true, logDirectory: process.env.PI_CODING_AGENT_DIR });
    this.chat = new Container(); this.dialog = new Container(); this.tools = new Map(); this.busy = false;
    this.status = new Text('Connecting to headless Pi', 1, 0);
    this.editor = new CustomEditor(this.ui, getEditorTheme(), new KeybindingsManager());
    this.editor.onSubmit = (message) => {
      this.send({ type: this.busy ? 'steer' : 'prompt', message });
      this.editor.setText('');
      if (this.busy) this.status.setText(`Steering queued: ${message}`);
      this.ui.requestRender();
    };
    this.editor.onCtrlD = () => this.host.stdin.end();
    // Tab moves between the pending confirm and editor, permitting steering during a dialog.
    this.ui.addChild(this.chat); this.ui.addChild(this.status); this.ui.addChild(this.dialog); this.ui.addChild(this.editor);
    this.ui.setFocus({ handleInput: (data) => {
      if (data === '\t' && this.select) this.dialogFocus = !this.dialogFocus;
      else if (this.select && this.dialogFocus) this.select.handleInput(data);
      else this.editor.handleInput(data);
      this.ui.requestRender();
    }});
    this.host = spawn(process.execPath, options.args, { cwd: options.hostCwd, env: { ...process.env, PI_CODING_AGENT_DIR: options.hostConfig, PI_OFFLINE: '1', PROOF_HOST_MARKER: options.marker }, stdio: ['pipe','pipe','pipe'] });
    this.host.stderr.on('data', (data) => appendFileSync(options.log + '.stderr', data));
    let buffer = '';
    this.host.stdout.on('data', (chunk) => {
      buffer += chunk;
      for (;;) { const end = buffer.indexOf('\n'); if (end < 0) break;
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        if (line) { appendFileSync(options.log, line + '\n'); this.event(JSON.parse(line)); }
      }
    });
    this.host.on('error', (error) => { this.ui.stop(); console.error(error); process.exit(1); });
    process.on('exit', () => this.host.kill());
    this.host.on('exit', (code) => { this.ui.stop(); process.exit(code ?? 1); });
    process.on('SIGTERM', () => { this.host.kill(); this.ui.stop(); process.exit(0); });
    this.ui.start(); this.send({ type: 'get_messages', id: 'history' }); this.send({ type: 'get_state', id: 'state' });
  }
  send(command) { this.host.stdin.write(JSON.stringify(command) + '\n'); }
  message(message) {
    if (message.role === 'user') this.chat.addChild(new UserMessageComponent(typeof message.content === 'string' ? message.content : message.content.filter(c => c.type === 'text').map(c => c.text).join('\n')));
    if (message.role === 'assistant') { this.streamingMessage = structuredClone(message); this.assistant = new AssistantMessageComponent(message); this.chat.addChild(this.assistant); }
    if (message.role === 'toolResult') this.chat.addChild(new Text(message.content.filter(c => c.type === 'text').map(c => c.text).join('\n'), 1, 0));
  }
  event(event) {
    if (event.type === 'response' && event.id === 'history') {
      for (const message of event.data?.messages ?? []) this.message(message);
      this.status.setText(`Remote chat ready; restored ${event.data?.messages?.length ?? 0} messages`);
    }
    if (event.type === 'response' && event.id === 'state') writeFileSync(options.state, JSON.stringify(event.data));
    if (event.type === 'agent_start') this.busy = true;
    if (event.type === 'message_start') this.message(event.message);
    if (event.type === 'message_update') {
      const delta = event.assistantMessageEvent;
      if (event.message) this.streamingMessage = event.message;
      else if (delta.type === 'text_start') this.streamingMessage.content[delta.contentIndex] = {type:'text', text:''};
      else if (delta.type === 'text_delta') this.streamingMessage.content[delta.contentIndex].text += delta.delta;
      else if (delta.type === 'text_end') this.streamingMessage.content[delta.contentIndex] = {type:'text', text:delta.content};
      this.assistant?.updateContent(this.streamingMessage, true);
    }
    if (event.type === 'message_end' && event.message.role === 'assistant') this.assistant?.updateContent(event.message, false);
    if (event.type === 'tool_execution_start') {
      const component = new ToolExecutionComponent(event.toolName, event.toolCallId, event.args, {}, undefined, this.ui, process.cwd());
      component.markExecutionStarted(); component.setArgsComplete(); component.setExpanded(true); this.tools.set(event.toolCallId, component); this.chat.addChild(component);
    }
    if (event.type === 'tool_execution_update') this.tools.get(event.toolCallId)?.updateResult(event.partialResult, true);
    if (event.type === 'tool_execution_end') this.tools.get(event.toolCallId)?.updateResult({...event.result,isError:event.isError}, false);
    if (event.type === 'extension_ui_request') {
      if (event.method === 'confirm') {
        this.dialog.addChild(new Text(`${event.title}: ${event.message} (Tab: editor/dialog)`, 1, 0));
        this.select = new SelectList([{value:'yes',label:'Yes'}, {value:'no',label:'No'}], 2, getSelectListTheme());
        const finish = (confirmed) => { this.send({type:'extension_ui_response',id:event.id,confirmed}); this.dialog.clear(); this.select = undefined; this.dialogFocus = false; };
        this.select.onSelect = (item) => finish(item.value === 'yes'); this.select.onCancel = () => finish(false);
        this.dialog.addChild(this.select); this.dialogFocus = true;
      } else if (event.method === 'notify') this.status.setText(event.message);
    }
    if (event.type === 'agent_settled') { this.busy = false; this.status.setText('Remote turn complete'); this.send({type:'get_state', id:'state'}); }
    this.ui.requestRender();
  }
}
new RemoteChatMode();
