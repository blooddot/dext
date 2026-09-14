import { monaco } from '../../src/webview/monacoEnvironment';
import { DextCodeEditor } from '../../src/webview/codeEditor';
import { DextLanguageService } from '../../src/core/languageService';
import { MethodRegistry } from '../../src/core/registry';
import { BUILTIN_METHODS } from '../../src/core/builtins';
import type { LanguageRequestBroker } from '../../src/webview/languageClient';
import type { ClipboardClient } from '../../src/webview/clipboardClient';
import type { FileSearchClient } from '../../src/webview/fileSearchClient';
import './style.css';
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
Object.assign(globalThis, { MonacoEnvironment: { getWorker: () => new Worker('/assets/editor.worker.js', { type: 'module' }) } });
const sample = 'agent(input="请检查 @src/features/workflow/components/main.ts#L12,5-L20,6 和 @src/界面/任务.ts 后继续")\n'
  + 'ui.form(title="任务详情", description="截图 @.dext-global/attachments/example-screenshot.png")\n'
  + '# 两个相邻引用：@src/a.ts @src/b.ts\n';

const registry = new MethodRegistry(); registry.registerMany(BUILTIN_METHODS, 'builtin');
const language = new DextLanguageService(registry);
const assistance = { hold: false, calls: [] as string[], pending: [] as Array<()=>void>, runs: 0 };
const broker = { request: async (source: string, cursor: number, _token: unknown, purpose: string) => {
  assistance.calls.push(purpose);
  const result = { type:'language' as const, inputKind:'workflow' as const,
    completions: purpose==='completion'?language.documentCompletions(source,cursor):[],
    diagnostics: purpose==='diagnostics'?language.documentDiagnostics(source):[],
    signature: language.documentSignature(source,cursor), hover:language.documentHover(source,cursor) };
  if(assistance.hold && purpose==='signature') await new Promise<void>(resolve=>assistance.pending.push(resolve));
  return result;
}, definition: async()=>undefined } as unknown as LanguageRequestBroker;
const production = new DextCodeEditor({parent:$('editor'), workerUri:'/assets/editor.worker.js',broker,
 clipboard:{write:async(text:string)=>{await navigator.clipboard.writeText(text);return true;},read:async()=>({text:await navigator.clipboard.readText(),contextAttached:false})} as unknown as ClipboardClient,
 files:{search:async()=>['src/a.ts','src/nested/a.ts']} as unknown as FileSearchClient,resolveDroppedFiles:async paths=>paths.map(path=>'@'+path),
 onRun:()=>{assistance.runs++;},onOpenReference:ref=>log('打开目标：'+ref.payload),onDiagnosticsChanged(){},onInputKindChanged(){},onError:console.error});
const projection=production.projection,model=production.model,editor=production.view;
editor.updateOptions({wordWrap:'on'});
const events:string[]=[];
const source=()=>production.source;
const refs=()=>projection.references(model.getValue());
const log=(text:string)=>{events.unshift(text);$('events').textContent=events.slice(0,12).join('\n');};
function render(){$('source').textContent=source();$('ref-count').textContent=refs().length+' 个引用';
  const selection=editor.getSelection()!;$('selection').textContent=JSON.stringify({selected:projection.decode(model.getValueInRange(selection)),sourceCursor:projection.toSource(model.getValue(),model.getOffsetAt(selection.getPosition()))},null,2);}
function reset(value=sample){production.setValue(value);editor.setPosition({lineNumber:1,column:1});render();editor.focus();}
function remove(index:number){const ref=refs()[index];if(!ref)return;const from=model.getPositionAt(ref.viewFrom),to=model.getPositionAt(ref.viewTo);
 editor.pushUndoStop();editor.executeEdits('ref.remove',[{range:monaco.Range.fromPositions(from,to),text:''}]);editor.pushUndoStop();editor.focus();}
model.onDidChangeContent(render);editor.onDidChangeCursorSelection(render);

$('wrap').addEventListener('change',()=>editor.updateOptions({wordWrap:$<HTMLInputElement>('wrap').checked?'on':'off'}));
$('width').addEventListener('change',()=>{document.documentElement.style.setProperty('--editor-width',$<HTMLSelectElement>('width').value+'px');editor.layout();});
$('theme').addEventListener('change',()=>{document.documentElement.dataset.theme=$<HTMLSelectElement>('theme').value;document.body.className=$<HTMLSelectElement>('theme').value==='vs'?'vscode-light':$<HTMLSelectElement>('theme').value==='hc-black'?'vscode-high-contrast':$<HTMLSelectElement>('theme').value==='hc-light'?'vscode-high-contrast-light':'vscode-dark';});
$('reset').addEventListener('click',()=>reset());reset();
Object.assign(window,{lab:{model,editor,projection,source,refs,reset,remove,events,sample,monaco,production,assistance,
 position(offset:number){editor.setPosition(model.getPositionAt(projection.toView(model.getValue(),offset)));editor.focus();},
 select(from:number,to:number){editor.setSelection(monaco.Selection.fromPositions(model.getPositionAt(projection.toView(model.getValue(),from)),model.getPositionAt(projection.toView(model.getValue(),to,'right'))));editor.focus();}}});


