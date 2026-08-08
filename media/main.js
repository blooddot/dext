(function () {
  const vscode = acquireVsCodeApi();
  const elements = {
    codeMode: document.getElementById("code-mode"),
    chatMode: document.getElementById("chat-mode"),
    codePanel: document.getElementById("code-panel"),
    chatPanel: document.getElementById("chat-panel"),
    codeInput: document.getElementById("code-input"),
    chatInput: document.getElementById("chat-input"),
    completions: document.getElementById("completions"),
    signature: document.getElementById("signature"),
    diagnostics: document.getElementById("diagnostics"),
    run: document.getElementById("run"),
    runState: document.getElementById("run-state"),
    reload: document.getElementById("reload"),
    trust: document.getElementById("trust-status"),
    methods: document.getElementById("methods"),
    methodCount: document.getElementById("method-count"),
    configErrors: document.getElementById("config-errors"),
    resultSection: document.getElementById("result-section"),
    result: document.getElementById("result"),
    clearOutput: document.getElementById("clear-output")
  };

  let mode = "code";
  let languageRequest = 0;
  let latestLanguageRequest = 0;
  let currentCompletions = [];
  let selectedCompletion = 0;

  function post(message) {
    vscode.postMessage(message);
  }

  function setMode(nextMode) {
    mode = nextMode;
    const code = mode === "code";
    elements.codeMode.classList.toggle("active", code);
    elements.chatMode.classList.toggle("active", !code);
    elements.codeMode.setAttribute("aria-selected", String(code));
    elements.chatMode.setAttribute("aria-selected", String(!code));
    elements.codePanel.classList.toggle("hidden", !code);
    elements.chatPanel.classList.toggle("hidden", code);
    (code ? elements.codeInput : elements.chatInput).focus();
  }

  function requestLanguage() {
    const source = elements.codeInput.value;
    const cursor = elements.codeInput.selectionStart;
    latestLanguageRequest = ++languageRequest;
    post({ type: "language", requestId: latestLanguageRequest, source, cursor });
  }

  function run() {
    if (elements.run.disabled) return;
    if (mode === "code") {
      const source = elements.codeInput.value.trim();
      if (source) post({ type: "executeCode", source });
    } else {
      const message = elements.chatInput.value.trim();
      if (message) post({ type: "executeChat", message });
    }
  }

  function methodTemplate(method) {
    const args = method.input
      .filter((field) => field.required)
      .map((field) => `${field.name}: ${defaultValue(field)}`);
    return `${method.id}(${args.join(", ")})`;
  }

  function defaultValue(field) {
    if (field.multiple) {
      return `[${defaultValue({ ...field, multiple: false })}]`;
    }
    if (field.default !== undefined) {
      return typeof field.default === "string" ? `"${field.default}"` : String(field.default);
    }
    if (field.type === "context") return "@selection";
    if (field.type === "number") return "0";
    if (field.type === "boolean") return "false";
    if (field.type === "enum") return `"${field.values?.[0] ?? ""}"`;
    return '""';
  }

  function renderMethods(state) {
    elements.methods.replaceChildren();
    elements.methodCount.textContent = String(state.methods.length);
    for (const method of state.methods) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "method-row";
      row.title = method.description;

      const identity = document.createElement("span");
      identity.className = "method-identity";
      const name = document.createElement("span");
      name.className = "method-name";
      name.textContent = method.id;
      const meta = document.createElement("span");
      meta.className = "method-meta";
      meta.textContent = `${method.kind} | ${method.source} | ${method.output.kind}`;
      identity.append(name, meta);

      const insert = document.createElement("i");
      insert.className = "codicon codicon-add";
      row.append(identity, insert);
      row.addEventListener("click", () => {
        setMode("code");
        elements.codeInput.value = methodTemplate(method);
        elements.codeInput.focus();
        elements.codeInput.setSelectionRange(
          elements.codeInput.value.length - 1,
          elements.codeInput.value.length - 1
        );
        requestLanguage();
      });
      elements.methods.append(row);
    }

    elements.trust.className = `status-dot ${state.trusted ? "trusted" : "untrusted"}`;
    elements.trust.title = state.trusted ? "Workspace trusted" : "Workspace untrusted";
    elements.configErrors.replaceChildren();
    for (const diagnostic of state.diagnostics) {
      const item = document.createElement("div");
      item.textContent = diagnostic;
      elements.configErrors.append(item);
    }
  }

  function renderLanguage(message) {
    if (message.requestId !== latestLanguageRequest) return;
    currentCompletions = message.completions;
    selectedCompletion = 0;
    elements.signature.textContent = message.signature?.label ?? "";
    elements.signature.title = message.signature?.documentation ?? "";
    elements.diagnostics.replaceChildren();
    for (const diagnostic of message.diagnostics) {
      const line = document.createElement("div");
      line.className = diagnostic.severity;
      const icon = document.createElement("i");
      icon.className = `codicon codicon-${diagnostic.severity}`;
      const text = document.createElement("span");
      text.textContent = diagnostic.message;
      line.append(icon, text);
      elements.diagnostics.append(line);
    }
    elements.run.disabled = message.diagnostics.some((item) => item.severity === "error");
    renderCompletions();
  }

  function renderCompletions() {
    elements.completions.replaceChildren();
    elements.completions.classList.toggle("hidden", currentCompletions.length === 0);
    currentCompletions.forEach((completion, index) => {
      const option = document.createElement("button");
      option.type = "button";
      option.className = `completion ${index === selectedCompletion ? "selected" : ""}`;
      option.setAttribute("role", "option");
      option.setAttribute("aria-selected", String(index === selectedCompletion));
      const label = document.createElement("span");
      label.textContent = completion.label;
      const detail = document.createElement("span");
      detail.className = "completion-detail";
      detail.textContent = completion.detail;
      option.append(label, detail);
      option.addEventListener("mousedown", (event) => {
        event.preventDefault();
        applyCompletion(completion);
      });
      elements.completions.append(option);
    });
  }

  function applyCompletion(completion) {
    const input = elements.codeInput;
    const cursor = input.selectionStart;
    const before = input.value.slice(0, cursor);
    let start = cursor;
    if (completion.kind === "method" || completion.kind === "parameter") {
      start -= /[A-Za-z0-9_.]*$/.exec(before)?.[0].length ?? 0;
    } else {
      start -= /[@A-Za-z0-9_."()]*$/.exec(before)?.[0].length ?? 0;
    }
    input.setRangeText(completion.insertText, start, cursor, "end");
    const emptyString = completion.insertText.indexOf('""');
    if (emptyString >= 0) {
      const position = start + emptyString + 1;
      input.setSelectionRange(position, position);
    }
    currentCompletions = [];
    renderCompletions();
    input.focus();
    requestLanguage();
  }

  function resultHeading(response) {
    const heading = document.createElement("div");
    heading.className = "result-meta";
    heading.textContent = `${response.method.id} | ${Math.round(response.durationMs)} ms`;
    return heading;
  }

  function renderResult(response) {
    elements.result.replaceChildren(resultHeading(response));
    const result = response.result;
    if (result.kind === "text") {
      const paragraph = document.createElement("p");
      paragraph.className = "text-result";
      paragraph.textContent = result.text;
      elements.result.append(paragraph);
    } else if (result.kind === "code") {
      if (result.title) {
        const title = document.createElement("div");
        title.className = "output-title";
        title.textContent = result.title;
        elements.result.append(title);
      }
      elements.result.append(codeBlock(result.code));
    } else if (result.kind === "review") {
      const summary = document.createElement("p");
      summary.className = "text-result";
      summary.textContent = result.summary;
      elements.result.append(summary);
      for (const finding of result.findings) {
        const item = document.createElement("div");
        item.className = `finding ${finding.severity}`;
        const icon = document.createElement("i");
        icon.className = `codicon codicon-${finding.severity}`;
        const content = document.createElement("span");
        content.textContent = finding.message;
        item.append(icon, content);
        elements.result.append(item);
      }
    } else if (result.kind === "plan") {
      const title = document.createElement("div");
      title.className = "output-title";
      title.textContent = result.title;
      const list = document.createElement("ol");
      list.className = "plan-list";
      for (const step of result.steps) {
        const item = document.createElement("li");
        const name = document.createElement("span");
        name.textContent = step.title;
        item.append(name);
        if (step.detail) {
          const detail = document.createElement("small");
          detail.textContent = step.detail;
          item.append(detail);
        }
        list.append(item);
      }
      elements.result.append(title, list);
    } else if (result.kind === "patch") {
      const title = document.createElement("div");
      title.className = "output-title";
      title.textContent = result.title;
      elements.result.append(title);
      for (const change of result.changes) {
        const file = document.createElement("div");
        file.className = "patch-file";
        const uri = document.createElement("div");
        uri.className = "patch-uri";
        uri.textContent = change.uri;
        const diff = codeBlock(`- ${change.before}\n+ ${change.after}`);
        file.append(uri, diff);
        elements.result.append(file);
      }
    }
    elements.resultSection.classList.remove("hidden");
  }

  function codeBlock(content) {
    const pre = document.createElement("pre");
    const code = document.createElement("code");
    code.textContent = content;
    pre.append(code);
    return pre;
  }

  function renderError(message) {
    const response = {
      method: { id: "runtime" },
      durationMs: 0,
      result: { kind: "review", summary: "Execution failed", findings: [{ severity: "error", message }] }
    };
    renderResult(response);
  }

  elements.codeMode.addEventListener("click", () => setMode("code"));
  elements.chatMode.addEventListener("click", () => setMode("chat"));
  elements.run.addEventListener("click", run);
  elements.reload.addEventListener("click", () => post({ type: "reload" }));
  elements.clearOutput.addEventListener("click", () => {
    elements.result.replaceChildren();
    elements.resultSection.classList.add("hidden");
  });
  elements.codeInput.addEventListener("input", requestLanguage);
  elements.codeInput.addEventListener("click", requestLanguage);
  elements.codeInput.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      run();
    } else if (currentCompletions.length && event.key === "ArrowDown") {
      event.preventDefault();
      selectedCompletion = (selectedCompletion + 1) % currentCompletions.length;
      renderCompletions();
    } else if (currentCompletions.length && event.key === "ArrowUp") {
      event.preventDefault();
      selectedCompletion = (selectedCompletion - 1 + currentCompletions.length) % currentCompletions.length;
      renderCompletions();
    } else if (currentCompletions.length && (event.key === "Enter" || event.key === "Tab")) {
      event.preventDefault();
      applyCompletion(currentCompletions[selectedCompletion]);
    } else if (event.key === "Escape") {
      currentCompletions = [];
      renderCompletions();
    }
  });
  elements.chatInput.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      run();
    }
  });

  window.addEventListener("message", (event) => {
    const message = event.data;
    if (message.type === "state") renderMethods(message.state);
    if (message.type === "language") renderLanguage(message);
    if (message.type === "execution") renderResult(message.response);
    if (message.type === "executing") {
      elements.run.disabled = message.value;
      elements.runState.textContent = message.value ? "Running..." : "";
    }
    if (message.type === "error") renderError(message.message);
    if (message.type === "focusEditor") {
      (mode === "code" ? elements.codeInput : elements.chatInput).focus();
    }
  });

  post({ type: "ready" });
  requestLanguage();
})();
