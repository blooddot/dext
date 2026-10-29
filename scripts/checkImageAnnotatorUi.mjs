import { readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { runLabChecks } from './monaco-ref-lab/check.mjs';

// The annotation tab is where somebody points at a detail in a screenshot, so the
// picture has to behave like a picture viewer before any mark is useful: it fits
// the window, Ctrl+wheel zooms around the pointer, and a mark stays on the pixel
// it was drawn on while the stage scrolls. This check drives the shipped bundle
// and measures the geometry instead of trusting the CSS.
await runLabChecks(async ({ send, evaluate, settle, artifacts }) => {
  await send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 820, deviceScaleFactor: 1, mobile: false });
  // The annotator is its own Webview document: a body class, two meta tags, the
  // bytes as a data URL, and no composer bundle.
  await evaluate(`lab.production.destroy();document.querySelectorAll('link[rel="stylesheet"],style').forEach(el=>el.remove());
    document.body.className='image-page';document.body.innerHTML='';
    // The lab has no VS Code theme, so the tokens this page reads are set to their
    // Dark+ values here: without them no overlay colour resolves at all.
    for (const [name,value] of Object.entries({
      '--vscode-foreground':'#cccccc','--vscode-editor-background':'#1e1e1e','--vscode-descriptionForeground':'#9d9d9d',
      '--vscode-focusBorder':'#0078d4','--vscode-editorWarning-foreground':'#cca700','--vscode-panel-border':'#3c3c3c',
      '--vscode-widget-border':'#3c3c3c','--vscode-toolbar-hoverBackground':'#5a5d5e50','--vscode-list-hoverBackground':'#2a2d2e',
      '--vscode-button-background':'#0e639c','--vscode-button-foreground':'#ffffff','--vscode-button-border':'transparent',
      '--vscode-button-secondaryBackground':'#3a3d41','--vscode-button-secondaryForeground':'#ffffff','--vscode-errorForeground':'#f48771',
      '--vscode-inputOption-activeBackground':'#2489db', '--vscode-inputOption-activeBorder':'#2489db','--vscode-inputOption-activeForeground':'#ffffff'
    })) document.documentElement.style.setProperty(name,value);
    for (const [name,content] of [['dext-image-path','.dext/attachments/shot.png'],['dext-image-name','shot.png']]) {
      const meta=document.createElement('meta');meta.name=name;meta.content=content;document.head.append(meta);
    }
    window.acquireVsCodeApi=()=>({postMessage:m=>{if(m.type==='imageData')queueMicrotask(()=>window.dispatchEvent(new MessageEvent('message',{data:{type:'imageDataResult',dataUrl:window.shot}})));},getState:()=>({}),setState:()=>{}});
    {
      const canvas=document.createElement('canvas');canvas.width=1600;canvas.height=1000;
      const c=canvas.getContext('2d');
      c.fillStyle='#1e1e1e';c.fillRect(0,0,1600,1000);
      c.fillStyle='#252526';c.fillRect(60,60,1480,880);
      c.fillStyle='#2d2d30';for(let row=0;row<7;row++)c.fillRect(100,120+row*110,520,36);
      c.fillStyle='#3c3c3c';c.fillRect(100,860,300,40);
      c.fillStyle='#0e639c';c.fillRect(1360,860,150,44);
      window.shot=canvas.toDataURL('image/png');
    }`);
  await evaluate(`{const style=document.createElement('style');style.textContent=${JSON.stringify(await readFile('dist/webview/main.css', 'utf8'))};document.head.append(style);}`);
  await evaluate(await readFile('dist/webview/imageAnnotator.js', 'utf8'));
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await evaluate(`(document.querySelector('.image-annotator-image')?.naturalWidth ?? 0) > 0`)) break;
    await new Promise(done => setTimeout(done, 50));
  }
  await settle();

  const geometry = () => evaluate(`{const image=document.querySelector('.image-annotator-image'),stage=document.querySelector('.image-annotator-stage');
    const i=image.getBoundingClientRect(),s=stage.getBoundingClientRect();
    ({natural:[image.naturalWidth,image.naturalHeight],image:[i.left,i.top,i.width,i.height],stage:[s.left,s.top,s.width,s.height],
      scroll:[stage.scrollLeft,stage.scrollTop],zoom:document.querySelector('.image-annotator-zoom').textContent})}`);
  const fractions = () => evaluate(`{const i=document.querySelector('.image-annotator-image').getBoundingClientRect();
    [...document.querySelectorAll('.image-annotator-mark')].map(m=>{const r=m.getBoundingClientRect();
      return [(r.left-i.left)/i.width,(r.top-i.top)/i.height,r.width/i.width]})}`);
  const labels = () => evaluate(`[...document.querySelectorAll('.image-annotator-row-label')].map(n=>n.textContent)`);
  const wheel = async (x, y, deltaY, modifiers = 0) => {
    await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY, modifiers });
    await settle();
  };
  const press = async ([x, y]) => {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    await settle();
  };
  const drag = async (from, to) => {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from[0], y: from[1], button: 'left', clickCount: 1, buttons: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: to[0], y: to[1], button: 'left', buttons: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to[0], y: to[1], button: 'left', clickCount: 1 });
    await settle();
  };
  const close = (actual, expected, tolerance, message) => assert.ok(Math.abs(actual - expected) <= tolerance,
    `${message}: expected ${expected}, got ${actual}`);

  // Opening a screenshot fits it to the tab; it is the state every mark starts from.
  const fit = await geometry();
  assert.ok(fit.image[2] <= fit.stage[2] + 1 && fit.image[3] <= fit.stage[3] + 1, `the picture fits the window: ${JSON.stringify(fit)}`);
  close(Number.parseFloat(fit.zoom), (fit.image[2] / fit.natural[0]) * 100, 1.5, 'the zoom label reports the fit scale');
  console.log(`PASS fit on open ${fit.zoom}`);

  // Ctrl+wheel keeps the pixel under the pointer where the pointer is. Both axes
  // are checked once the picture overflows them, since a picture smaller than the
  // stage is centred and has no scroll of its own to spend on the anchor.
  const anchor = [fit.image[0] + fit.image[2] * 0.3, fit.image[1] + fit.image[3] * 0.4];
  for (let step = 0; step < 4; step++) await wheel(anchor[0], anchor[1], -120, 2);
  const zoomed = await geometry();
  assert.ok(zoomed.image[2] > fit.image[2] * 1.3, `Ctrl+wheel zooms in: ${fit.image[2]} -> ${zoomed.image[2]}`);
  assert.ok(zoomed.image[2] > zoomed.stage[2] && zoomed.image[3] > zoomed.stage[3], 'the zoomed picture overflows both axes');
  // From here the picture can spend its scroll on the anchor, so the pixel under
  // the pointer must not move at all.
  const held = [zoomed.image[0] + zoomed.image[2] * 0.42, zoomed.image[1] + zoomed.image[3] * 0.31];
  await wheel(held[0], held[1], -120, 2);
  const heldAfter = await geometry();
  close((held[0] - heldAfter.image[0]) / heldAfter.image[2], (held[0] - zoomed.image[0]) / zoomed.image[2], 0.01, 'the pointer keeps its horizontal pixel');
  close((held[1] - heldAfter.image[1]) / heldAfter.image[3], (held[1] - zoomed.image[1]) / zoomed.image[3], 0.01, 'the pointer keeps its vertical pixel');
  close((anchor[0] - zoomed.image[0]) / zoomed.image[2], (anchor[0] - fit.image[0]) / fit.image[2], 0.02, 'the pointer roughly keeps its horizontal pixel through a whole gesture');
  console.log(`PASS Ctrl+wheel zooms around the pointer ${fit.zoom} -> ${zoomed.zoom}`);

  // A plain wheel is the stage's own pan, not a second zoom.
  const beforePan = await geometry();
  await wheel(beforePan.stage[0] + beforePan.stage[2] / 2, beforePan.stage[1] + beforePan.stage[3] / 2, 120);
  const panned = await geometry();
  assert.ok(panned.scroll[1] > beforePan.scroll[1], `a plain wheel scrolls the picture: ${beforePan.scroll[1]} -> ${panned.scroll[1]}`);
  assert.equal(panned.zoom, beforePan.zoom, 'a plain wheel leaves the zoom alone');
  console.log(`PASS plain wheel pans to ${panned.scroll.join(',')}`);

  // Draw a box over a block: it records the image pixels the pointer covered.
  const view = await geometry();
  const from = [view.stage[0] + view.stage[2] * 0.35, view.stage[1] + view.stage[3] * 0.35];
  await drag(from, [from[0] + 120, from[1] + 80]);
  assert.equal(await evaluate(`document.querySelectorAll('.image-annotator-mark').length`), 1, 'the drag creates one mark');
  const [mark] = await fractions();
  const firstLabel = (await labels())[0];
  const recorded = /at (\d+),(\d+)/.exec(firstLabel)?.slice(1).map(Number) ?? [];
  const expected = [(from[0] - view.image[0]) / view.image[2] * view.natural[0], (from[1] - view.image[1]) / view.image[3] * view.natural[1]];
  close(recorded[0], expected[0], 2, `the mark records image pixels: ${firstLabel} vs ${expected.join(',')}`);
  close(recorded[1], expected[1], 2, `the mark records image pixels: ${firstLabel} vs ${expected.join(',')}`);
  // The number is a chip outside the box, so it cannot be read as part of the shot.
  const badge = await evaluate(`{const mark=document.querySelector('.image-annotator-region').getBoundingClientRect();
    const chip=document.querySelector('.image-annotator-region .image-annotator-index').getBoundingClientRect();
    ({outside:chip.bottom<=mark.top+0.5,visible:chip.width>0,text:document.querySelector('.image-annotator-index').textContent})}`);
  assert.ok(badge.outside, `the number sits above the box, not inside the screenshot: ${JSON.stringify(badge)}`);
  assert.equal(badge.text, '1');
  // The row repeats the chip and gives the note the whole column, not a sliver beside a label.
  const row = await evaluate(`{const r=document.querySelector('.image-annotator-row');
    ({head:document.querySelector('.image-annotator-list-head').textContent,chip:r.querySelector('.image-annotator-index').textContent,
      note:Math.round(r.querySelector('input').getBoundingClientRect().width),list:Math.round(r.getBoundingClientRect().width)})}`);
  assert.equal(row.chip, '1', 'the row carries the same chip as its box');
  assert.match(row.head, /^Annotations \(\d+\)$/, `the list names itself and counts: ${row.head}`);
  assert.ok(row.note > row.list * 0.9, `the note field spans the column: ${row.note} of ${row.list}`);
  console.log(`PASS mark ${firstLabel} with its number outside the box`);

  // Marks are placed in content space, so scrolling must not peel them off their pixels.
  await evaluate(`{const stage=document.querySelector('.image-annotator-stage');stage.scrollLeft+=70;stage.scrollTop+=50;}`);
  await settle();
  const afterScroll = await fractions();
  close(afterScroll[0][0], mark[0], 0.002, 'the mark keeps its horizontal pixel while scrolling');
  close(afterScroll[0][1], mark[1], 0.002, 'the mark keeps its vertical pixel while scrolling');
  assert.deepEqual(await labels(), [firstLabel], 'scrolling records no new coordinates');
  console.log('PASS marks stay on their pixels while the stage scrolls');

  // Pressing a mark goes back to its note instead of drawing a second box over it.
  const centre = await evaluate(`{const r=document.querySelector('.image-annotator-mark').getBoundingClientRect();[r.left+r.width/2,r.top+r.height/2]}`);
  await press(centre);
  assert.equal(await evaluate(`document.querySelectorAll('.image-annotator-mark').length`), 1, 'a press on a mark draws nothing');
  assert.equal(await evaluate(`document.activeElement===document.querySelector('.image-annotator-row input')`), true, 'a press on a mark focuses its note');
  console.log('PASS pressing a mark focuses its note');

  // The toolbar: original size, then back to fit, with the mark still recorded.
  await evaluate(`document.querySelector('.image-annotator-tools [aria-label="Original size"]').click()`);
  await settle();
  const actualSize = await geometry();
  close(actualSize.image[2], actualSize.natural[0], 1, '100% is one image pixel per screen pixel');
  assert.equal(actualSize.zoom, '100%');
  await evaluate(`document.querySelector('.image-annotator-tools [aria-label="Fit the picture to the window"]').click()`);
  await settle();
  const refit = await geometry();
  assert.ok(refit.image[2] <= refit.stage[2] + 1 && refit.image[3] <= refit.stage[3] + 1, 'Fit returns to the window');
  assert.deepEqual(await labels(), [firstLabel], 'zooming never rewrites the recorded pixels');
  const refitMarks = await fractions();
  close(refitMarks[0][0], mark[0], 0.01, 'the refit mark still covers the same pixel');
  console.log(`PASS toolbar 100% then Fit (${refit.zoom})`);

  // Near the top edge the number has nowhere to hang, so it moves inside the box.
  await evaluate(`document.querySelector('.image-annotator-tools [aria-label="Original size"]').click()`);
  await settle();
  const edge = await geometry();
  await drag([edge.image[0] + 200, edge.image[1] + 4], [edge.image[0] + 320, edge.image[1] + 40]);
  const inside = await evaluate(`{const marks=[...document.querySelectorAll('.image-annotator-region')].at(-1);
    const chip=marks.querySelector('.image-annotator-index').getBoundingClientRect(),r=marks.getBoundingClientRect();
    ({inside:chip.top>=r.top-0.5&&chip.left>=r.left-0.5})}`);
  assert.ok(inside.inside, `the number falls inside at the top edge: ${JSON.stringify(inside)}`);
  console.log('PASS the number flips inside at the top edge');

  // One toggle hides every box and number, and nothing can be drawn while hidden.
  const markCount = await evaluate(`document.querySelectorAll('.image-annotator-mark').length`);
  assert.equal(await evaluate(`document.querySelector('.image-annotator-size').textContent`), '1600 \u00d7 1000', 'the toolbar names the picture size');
  await evaluate(`document.querySelector('.image-annotator-toggle').click()`);
  await settle();
  assert.equal(await evaluate(`document.querySelector('.image-annotator-toggle').getAttribute('aria-pressed')`), 'true', 'the toggle reports its state');
  assert.equal(await evaluate(`document.querySelector('.image-annotator-toggle').textContent`), 'Show annotations');
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('.image-annotator-layers')).display`), 'none', 'hiding takes every mark off the picture');
  const plain = await send('Page.captureScreenshot');
  await writeFile(join(artifacts, 'annotator-plain.png'), Buffer.from(plain.data, 'base64'));
  const plainView = await geometry();
  await drag([plainView.stage[0] + 60, plainView.stage[1] + 60], [plainView.stage[0] + 180, plainView.stage[1] + 140]);
  assert.equal(await evaluate(`document.querySelectorAll('.image-annotator-mark').length`), markCount, 'a drag on the plain picture adds no mark');
  await evaluate(`document.querySelector('.image-annotator-toggle').click()`);
  await settle();
  assert.notEqual(await evaluate(`getComputedStyle(document.querySelector('.image-annotator-layers')).display`), 'none', 'showing brings the marks back');
  assert.equal(await evaluate(`document.querySelectorAll('.image-annotator-mark').length`), markCount, 'showing restores the same marks');
  console.log(`PASS the toggle hides and restores ${markCount} marks`);

  const shot = await send('Page.captureScreenshot');
  await writeFile(join(artifacts, 'annotator-marks.png'), Buffer.from(shot.data, 'base64'));
  await evaluate(`document.querySelector('.image-annotator-tools [aria-label="Fit the picture to the window"]').click()`);
  await settle();
  const finalShot = await send('Page.captureScreenshot');
  await writeFile(join(artifacts, 'annotator-fit.png'), Buffer.from(finalShot.data, 'base64'));

  // Deleting a row leaves the keyboard in the list and renumbers what is left.
  await evaluate(`document.querySelector('.image-annotator-row .image-annotator-remove').click()`);
  await settle();
  assert.equal(await evaluate(`document.querySelectorAll('.image-annotator-mark').length`), 1, 'delete removes one mark');
  assert.equal(await evaluate(`document.querySelector('.image-annotator-list-head').textContent`), 'Annotations (1)');
  assert.equal(await evaluate(`document.activeElement===document.querySelector('.image-annotator-row input')`), true, 'focus stays in the list after a delete');
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('.image-annotator-index')].map(n=>n.textContent)`), ['1', '1'], 'the surviving mark and its row are renumbered');
  console.log('PASS delete keeps focus and renumbers');
}, false);
