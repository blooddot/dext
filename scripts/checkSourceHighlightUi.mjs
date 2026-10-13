import assert from 'node:assert/strict';
import { runLabChecks } from './monaco-ref-lab/check.mjs';

await runLabChecks(async ({ evaluate }) => {
  const cases = [
    ['import { feat } from "dext/api/dev/feat";\nlet input = `\n说明 ', '\n数据类似PetCombatBubble，属性需要一起计算 ', ' 后续\n`;\nfeat(input);'],
    ['const input = "前 ', ' 后";\nconst count = 42;'],
    ['/* 前 ', '\n后 ', ' */\nconst count = 42;'],
    ['const input = `前 ', ' ${1 + 2} 后 ', '`;'],
    ['const input = "<img src=x onerror=alert(1)> \ue100 ', ' 后";'],
    ['const count = 42;\n']
  ];
  for (const theme of ['vscode-light', 'vscode-dark', 'vscode-high-contrast', 'vscode-high-contrast-light']) {
    await evaluate(`document.body.className = ${JSON.stringify(theme)}; lab.production.applyTheme();`);
    for (const parts of cases) {
      const result = await evaluate(`(async () => {
        const parts = ${JSON.stringify(parts)};
        const pre = document.createElement('pre');
        const chips = [];
        let clicks = 0;
        let projected = '';
        let next = 0xe100;
        for (let index = 0; index < parts.length; index++) {
          pre.append(document.createTextNode(parts[index]));
          projected += parts[index];
          if (index < parts.length - 1) {
            const chip = document.createElement('button');
            chip.className = 'test-reference';
            chip.textContent = 'file-' + index + '.ts';
            chip.addEventListener('click', () => clicks++);
            pre.append(chip);
            chips.push(chip);
            while (parts.join('').includes(String.fromCharCode(next))) next++;
            projected += String.fromCharCode(next++);
          }
        }
        document.body.append(pre);
        // Compare with a complete Monaco model, as used by the input editor.
        const model = lab.monaco.editor.createModel(projected, 'typescript');
        const expected = document.createElement('pre');
        document.body.append(expected);
        await lab.monaco.editor.colorize(projected, 'typescript', {});
        for (let line = 1; line <= model.getLineCount(); line++) {
          expected.insertAdjacentHTML('beforeend', lab.monaco.editor.colorizeModelLine(model, line));
        }
        lab.colorizeSource(pre);
        for (let attempt = 0; attempt < 100 && !pre.querySelector('[class^="mtk"]'); attempt++) {
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        const colors = (element, skipChips) => {
          const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
          const output = [];
          while (walker.nextNode()) {
            const node = walker.currentNode;
            if (skipChips && node.parentElement.closest('.test-reference')) continue;
            for (const character of node.data) {
              if (!/\\s|[\\ue100-\\uf8ff]/.test(character)) output.push([character, getComputedStyle(node.parentElement).color]);
            }
          }
          return output;
        };
        chips.forEach(chip => chip.click());
        const result = { actual: colors(pre, true), expected: colors(expected, false), clicks,
          preserved: chips.every(chip => pre.contains(chip)), images: pre.querySelectorAll('img').length,
          lineBreaks: pre.querySelectorAll('br').length, expectedLineBreaks: projected.split('\\n').length - 1 };
        pre.remove(); expected.remove(); model.dispose();
        return result;
      })()`);
      assert.deepEqual(result.actual, result.expected, `${theme}: colors match the complete editor model`);
      assert.equal(result.preserved, true, 'original reference elements survive');
      assert.equal(result.clicks, parts.length - 1, 'reference click handlers survive');
      assert.equal(result.images, 0, 'source remains escaped');
      assert.equal(result.lineBreaks, result.expectedLineBreaks, 'reference boundaries add no line breaks');
    }
    console.log(`PASS ${theme}: template strings, quoted strings, comments, interpolation, escaping and references`);
  }
}, false);
