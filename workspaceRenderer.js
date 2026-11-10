"use strict";

// Layout owns visibility; renderer.js continues to own sessions and all IPC.
window.AITerminalWorkspace = class {
  constructor() {
    this.layout = window.AITerminalLayout;
    this.groups = [this.layout.leaf("tab-1")];
    this.zoomed = null;
    this.restoring = false;
    this.busy = false;
    this.host = document.getElementById("workspaceCanvas");
    this.parking = document.getElementById("workspaceParking");
    this.status = document.getElementById("workspaceMessage");
    this.dragged = null;
    this.pins = new Map();
    this.pinGeneration = 0;
    document
      .getElementById("sessionSearch")
      .addEventListener("input", () => this.renderSessions());
    document
      .getElementById("workspaceFile")
      .addEventListener("change", (event) => this.importFile(event.target));
    document.addEventListener("click", (event) => this.action(event));
    document.addEventListener("keydown", (event) => this.key(event), true);
    document.addEventListener("dragstart", (event) => {
      const tab = event.target.closest("[data-session-drag]");
      if (!tab) return;
      this.dragged = tab.dataset.sessionDrag;
      event.dataTransfer.setData(
        "application/x-aiterminal-session",
        this.dragged,
      );
      event.dataTransfer.effectAllowed = "move";
    });
    document.addEventListener("dragend", () => {
      this.dragged = null;
      this.clearDrop();
    });
    window.electronAPI?.onPluginsChanged?.(() => {
      clearTimeout(this.pinTimer);
      this.pinTimer = setTimeout(() => this.refreshPins(), 120);
    });
    this.attachPane("tab-1");
    document.querySelector(".session-search kbd").textContent = /Mac/i.test(
      navigator.platform,
    )
      ? "⇧⌘F"
      : "Ctrl ⇧ F";
    this.iconize(document);
    this.render();
    this.renderSaved();
    this.renderAssets();
  }
  message(text) {
    this.status.textContent = text;
  }
  iconize(root) {
    const paths = {
      "split-horizontal":
        "M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z M12 3v18",
      "split-vertical":
        "M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z M3 12h18",
      zoom: "M8 3H3v5 M16 3h5v5 M3 16v5h5 M21 16v5h-5",
      detach: "M13 4h7v7 M20 4L10 14 M9 4H4v16h16v-5",
      files: "M3 7h7l2-3h9v16H3z",
      sidebar: "M3 4h18v16H3z M9 4v16",
      theme: "M20.9 13a9 9 0 1 1-9.9-9.9A7 7 0 0 0 20.9 13z",
      settings: "M4 7h9 M17 7h3 M4 17h3 M11 17h9 M13 4h4v6h-4z M7 14h4v6H7z",
      save: "M5 3h12l4 4v13a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z M7 3v6h9V3 M7 21v-8h10v8",
      plugins:
        "M8 3h4v3a2 2 0 1 0 4 0V3h5v6h-3a2 2 0 1 0 0 4h3v8h-8v-3a2 2 0 1 0-4 0v3H3v-8h3a2 2 0 1 0 0-4H3V3z",
      search: "M16 16l5 5 M10.5 3a7.5 7.5 0 1 0 0 15a7.5 7.5 0 0 0 0-15",
      import: "M12 3v12 M7 10l5 5 5-5 M4 15v6h16v-6",
      export: "M12 15V3 M7 8l5-5 5 5 M4 15v6h16v-6",
      sparkles:
        "M12 3l2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5z M20 2v4 M18 4h4",
    };
    for (const button of root.querySelectorAll(
      "[data-workspace-action], [data-icon]",
    )) {
      const drawing =
        paths[button.dataset.icon || button.dataset.workspaceAction];
      if (!drawing || button.querySelector("svg")) continue;
      if (
        button.classList.contains("icon-button") ||
        button.closest(".pane-actions")
      )
        button.textContent = "";
      else if (
        !button.dataset.icon &&
        button.firstChild?.nodeType === Node.TEXT_NODE
      )
        button.firstChild.textContent = "";
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("viewBox", "0 0 24 24");
      svg.classList.add("ui-icon");
      svg.setAttribute("aria-hidden", "true");
      const path = document.createElementNS(svg.namespaceURI, "path");
      path.setAttribute("d", drawing);
      svg.append(path);
      button.prepend(svg);
    }
  }
  backendChanged(id, { preservePins = false } = {}) {
    const owner = terminalTabs.get(id);
    if (owner) owner.filesRequest = null;
    getTabContent(id)?.querySelector(".pane-files")?.remove();
    if (!preservePins)
      for (const [key, pin] of this.pins)
        if (pin.tabId === id) this.pins.delete(key);
    this.renderPins();
  }
  pendingRemote(id) {
    const info = terminalTabs.get(id),
      content = getTabContent(id);
    if (!info || !content || !this.layout.connection(info.connectionConfig))
      return false;
    info.pendingRemote = true;
    if (!content.querySelector(".pending-connection")) {
      const button = document.createElement("button");
      button.className = "pending-connection btn btn-primary";
      button.textContent = "重新连接 SSH";
      button.dataset.workspaceAction = "reconnect";
      content.append(button);
    }
    this.updatePane(id);
    return true;
  }
  group(tabId) {
    return this.groups.find((tree) => this.layout.leaves(tree).includes(tabId));
  }
  visible(tabId) {
    return this.zoomed
      ? this.zoomed === tabId
      : this.layout.leaves(this.group(activeTabId)).includes(tabId);
  }
  fit() {
    for (const id of terminalTabs.keys())
      if (this.visible(id)) scheduleFitTerminalTab(id, { syncSsh: true });
  }
  attachPane(id) {
    const content = getTabContent(id);
    if (!content || content.querySelector(".pane-header")) return;
    const header = document.createElement("div");
    header.className = "pane-header";
    header.innerHTML = `<span class="pane-lights" aria-hidden="true"><i></i><i></i><i></i></span><span class="pane-status"></span><button class="pane-title" data-workspace-action="rename" title="重命名会话"></button><span class="pane-environment"></span><div class="pane-actions"><button data-workspace-action="files" title="远程文件" aria-label="远程文件">▱</button><button data-workspace-action="split-horizontal" title="左右分屏" aria-label="左右分屏">◫</button><button data-workspace-action="split-vertical" title="上下分屏" aria-label="上下分屏">⊟</button><button data-workspace-action="zoom" title="放大 / 还原窗格" aria-label="放大或还原窗格">⛶</button><button data-workspace-action="detach" title="移到独立标签" aria-label="移到独立标签">↗</button><button data-action="close-terminal-tab" title="关闭会话" aria-label="关闭会话">×</button></div>`;
    content.prepend(header);
    this.iconize(header);
    content.addEventListener(
      "pointerdown",
      (event) => {
        if (id !== activeTabId && !event.target.closest(".pane-actions"))
          switchToTab(id, { focus: false });
      },
      true,
    );
    content.addEventListener("focusin", () => {
      if (id !== activeTabId) switchToTab(id, { focus: false });
    });
    content.addEventListener("dragover", (event) => {
      if (!this.dragged || this.dragged === id) return;
      event.preventDefault();
      event.stopPropagation();
      const r = content.getBoundingClientRect();
      const x = (event.clientX - r.x) / r.width,
        y = (event.clientY - r.y) / r.height;
      const edge =
        Math.min(x, 1 - x) < Math.min(y, 1 - y)
          ? x < 0.5
            ? "left"
            : "right"
          : y < 0.5
            ? "top"
            : "bottom";
      this.clearDrop();
      content.dataset.dropEdge = edge;
    });
    content.addEventListener("drop", (event) => {
      if (!this.dragged) return;
      event.preventDefault();
      event.stopPropagation();
      const source = this.dragged,
        edge = content.dataset.dropEdge || "right";
      this.dragged = null;
      this.clearDrop();
      if (source !== id && terminalTabs.has(source))
        this.move(source, id, edge);
    });
    const tab = getTabButton(id);
    tab.draggable = true;
    tab.dataset.sessionDrag = id;
    this.updatePane(id);
  }
  clearDrop() {
    document
      .querySelectorAll("[data-drop-edge]")
      .forEach((node) => delete node.dataset.dropEdge);
  }
  created(id, options = {}) {
    this.attachPane(id);
    if (!options.restoring) {
      const target = options.splitTarget;
      if (target && this.group(target)) {
        const index = this.groups.indexOf(this.group(target));
        this.groups[index] = this.layout.split(
          this.groups[index],
          target,
          id,
          options.axis,
        );
      } else this.groups.push(this.layout.leaf(id));
    }
    this.zoomed = null;
  }
  selected(id, previous) {
    if (this.zoomed && this.zoomed !== id) this.zoomed = null;
    if (
      this.group(previous) !== this.group(id) ||
      !getTabContent(id)?.classList.contains("pane-visible")
    )
      this.render();
    else this.renderSessions();
    for (const key of terminalTabs.keys()) {
      getTabContent(key)?.classList.toggle("pane-focused", key === id);
      this.updatePane(key);
    }
    const info = terminalTabs.get(id);
    document.getElementById("activeSessionLabel").textContent =
      info?.title || "终端";
    document.getElementById("composerTarget").textContent =
      info?.title || "当前会话";
    this.fit();
  }
  closed(id) {
    const original = this.group(id);
    const neighbor = this.layout.leaves(original).find((key) => key !== id);
    this.groups = this.groups
      .map((tree) => this.layout.remove(tree, id))
      .filter(Boolean);
    if (this.zoomed === id) this.zoomed = null;
    for (const [key, pin] of this.pins)
      if (pin.tabId === id) this.pins.delete(key);
    this.renderPins();
    return neighbor;
  }
  updatePane(id) {
    const info = terminalTabs.get(id),
      node = getTabContent(id);
    if (!info || !node) return;
    const title = node.querySelector(".pane-title");
    if (title) title.textContent = info.title;
    const status = getTabDisplayStatus(id);
    node.querySelector(".pane-status")?.setAttribute("data-status", status);
    const environment = node.querySelector(".pane-environment");
    if (environment)
      environment.textContent = info.pendingRemote
        ? "待连接 · SSH"
        : info.isConnected
          ? "SSH"
          : info.sshConnecting
            ? "连接中"
            : info.localTerminalShell || "本地";
    node.classList.toggle("pane-focused", activeTabId === id);
    const zoom = node.querySelector('[data-workspace-action="zoom"]');
    if (zoom) zoom.setAttribute("aria-pressed", String(this.zoomed === id));
    const row = document.querySelector(
      `#sessionList [data-session-drag="${id}"]`,
    );
    if (row) {
      row.querySelector(".session-name").textContent = info.title;
      row.querySelector(".session-dot").dataset.status = status;
      row.querySelector(".session-badge").textContent = info.isConnected
        ? "SSH"
        : info.pendingRemote
          ? "待连接"
          : info.sshConnecting
            ? "连接中"
            : "PTY";
    }
    if (id === activeTabId) {
      document.getElementById("activeSessionLabel").textContent = info.title;
      document.getElementById("composerTarget").textContent = info.title;
      document.getElementById("connectionLabel").textContent =
        info.pendingRemote
          ? "等待连接 SSH"
          : status === "connected"
            ? "SSH 已连接"
            : status === "local"
              ? "本地终端"
              : status === "connecting"
                ? "正在连接"
                : "已断开";
    }
  }
  render() {
    const focused = [...terminalTabs].find(
      ([, info]) => document.activeElement === info.terminal.textarea,
    )?.[0];
    document.body.classList.remove("resizing-panes");
    for (const [id] of terminalTabs) {
      const node = getTabContent(id);
      if (!node) continue;
      node.classList.remove("pane-visible");
      this.parking.append(node);
    }
    this.host.replaceChildren();
    const tree = this.zoomed
      ? this.layout.leaf(this.zoomed)
      : this.group(activeTabId);
    if (tree) this.host.append(this.build(tree));
    this.renderSessions();
    this.fit();
    document.getElementById("paneCount").textContent =
      `${terminalTabs.size} 会话 · ${this.layout.leaves(tree).length} 窗格`;
    // Reparenting the same xterm view temporarily removes its textarea from the
    // document. Restore only the actual input owner, never a merely selected tab.
    if (focused) focusTerminalTab(focused);
    syncTerminalFocus();
  }
  build(tree) {
    if (tree.type === "terminal") {
      const content = getTabContent(tree.tabId);
      content.classList.add("pane-visible");
      this.updatePane(tree.tabId);
      return content;
    }
    const node = document.createElement("div");
    node.className = "workspace-split";
    node.dataset.axis = tree.axis;
    const first = document.createElement("div"),
      second = document.createElement("div");
    first.className = second.className = "workspace-branch";
    const update = () => {
      first.style.flex = `${tree.ratio} 1 0`;
      second.style.flex = `${1 - tree.ratio} 1 0`;
    };
    update();
    first.append(this.build(tree.children[0]));
    second.append(this.build(tree.children[1]));
    const handle = document.createElement("div");
    handle.className = "workspace-divider";
    handle.tabIndex = 0;
    handle.setAttribute("role", "separator");
    handle.setAttribute("aria-label", "调整分屏比例");
    handle.setAttribute(
      "aria-orientation",
      tree.axis === "horizontal" ? "vertical" : "horizontal",
    );
    const set = (value) => {
      tree.ratio = Math.max(0.1, Math.min(0.9, value));
      handle.setAttribute("aria-valuenow", Math.round(tree.ratio * 100));
      update();
      this.fit();
    };
    handle.setAttribute("aria-valuemin", "10");
    handle.setAttribute("aria-valuemax", "90");
    set(tree.ratio);
    handle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      handle.setPointerCapture(event.pointerId);
      document.body.classList.add("resizing-panes");
      const move = (e) => {
        const r = node.getBoundingClientRect();
        set(
          tree.axis === "horizontal"
            ? (e.clientX - r.x) / r.width
            : (e.clientY - r.y) / r.height,
        );
      };
      const finish = () => {
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("lostpointercapture", finish);
        document.body.classList.remove("resizing-panes");
        this.fit();
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("lostpointercapture", finish);
    });
    handle.addEventListener("keydown", (event) => {
      if (
        ["ArrowLeft", "ArrowUp", "ArrowRight", "ArrowDown", "Home"].includes(
          event.key,
        )
      ) {
        event.preventDefault();
        set(
          event.key === "Home"
            ? 0.5
            : tree.ratio +
                (["ArrowLeft", "ArrowUp"].includes(event.key) ? -0.05 : 0.05),
        );
      }
    });
    handle.addEventListener("dblclick", () => set(0.5));
    node.append(first, handle, second);
    return node;
  }
  renderSessions() {
    const query = document.getElementById("sessionSearch").value.toLowerCase();
    const list = document.getElementById("sessionList");
    list.replaceChildren();
    for (const [id, info] of terminalTabs) {
      if (
        !`${info.title} ${info.connectionConfig?.host || ""}`
          .toLowerCase()
          .includes(query)
      )
        continue;
      const button = document.createElement("button");
      button.className = "session-row";
      button.dataset.action = "switch-terminal-tab";
      button.dataset.tabId = id;
      button.draggable = true;
      button.dataset.sessionDrag = id;
      button.classList.toggle("selected", id === activeTabId);
      button.classList.toggle("in-view", this.visible(id));
      const dot = document.createElement("span");
      dot.className = "session-dot";
      dot.dataset.status = getTabDisplayStatus(id);
      const text = document.createElement("span");
      text.className = "session-name";
      text.textContent = info.title;
      const badge = document.createElement("span");
      badge.className = "session-badge";
      badge.textContent = info.isConnected
        ? "SSH"
        : info.pendingRemote
          ? "待连接"
          : "PTY";
      button.append(dot, text, badge);
      list.append(button);
      getTabButton(id)?.classList.toggle("in-view", this.visible(id));
    }
  }
  async split(axis, target = activeTabId) {
    if (this.busy || !terminalTabs.has(target)) return;
    this.busy = true;
    try {
      await createNewTerminalTab({ splitTarget: target, axis });
    } finally {
      this.busy = false;
    }
  }
  move(source, target, edge) {
    if (source === target || !this.group(source) || !this.group(target)) return;
    this.groups = this.groups
      .map((tree) => this.layout.remove(tree, source))
      .filter(Boolean);
    const index = this.groups.indexOf(this.group(target));
    if (index < 0) return;
    this.groups[index] = this.layout.split(
      this.groups[index],
      target,
      source,
      ["left", "right"].includes(edge) ? "horizontal" : "vertical",
      ["left", "top"].includes(edge),
    );
    this.zoomed = null;
    switchToTab(source);
    this.render();
  }
  detach(id) {
    if (this.layout.leaves(this.group(id)).length < 2) return;
    this.groups = this.groups
      .map((tree) => this.layout.remove(tree, id))
      .filter(Boolean);
    this.groups.push(this.layout.leaf(id));
    this.zoomed = null;
    switchToTab(id);
    this.render();
  }
  snapshot(name) {
    return this.layout.validate({
      version: 1,
      name,
      active: activeTabId,
      groups: this.groups,
      pins: [...this.pins.values()],
      sessions: [...terminalTabs].map(([id, info]) => ({
        id,
        title: info.title,
        connection:
          info.isConnected || info.sshConnecting || info.pendingRemote
            ? info.connectionConfig
            : null,
      })),
    });
  }
  saved() {
    return readStoredObject("aiterminalWorkspaces");
  }
  save() {
    showCustomPrompt(
      "保存工作区",
      "保存布局与连接信息；不会保存凭据、终端进程或命令。",
      "我的工作区",
      (name) => {
        if (!name?.trim()) return;
        try {
          const saved = this.saved();
          const key = name.trim().slice(0, 80);
          if (["__proto__", "constructor", "prototype"].includes(key))
            throw new Error("请使用其他工作区名称");
          Object.defineProperty(saved, key, {
            value: this.snapshot(name),
            enumerable: true,
            configurable: true,
            writable: true,
          });
          localStorage.setItem("aiterminalWorkspaces", JSON.stringify(saved));
          this.renderSaved();
          this.message("工作区已保存");
        } catch (error) {
          this.message(`工作区保存失败：${error.message}`);
        }
      },
    );
  }
  renderSaved() {
    const container = document.getElementById("savedWorkspaces");
    container.replaceChildren();
    for (const name of Object.keys(this.saved())) {
      const row = document.createElement("div");
      row.className = "saved-row";
      const button = document.createElement("button");
      button.textContent = name;
      button.addEventListener("click", () => this.restore(this.saved()[name]));
      const remove = document.createElement("button");
      remove.textContent = "×";
      remove.title = "删除已保存布局";
      remove.setAttribute("aria-label", `删除工作区 ${name}`);
      remove.addEventListener("click", () => {
        const saved = this.saved();
        delete saved[name];
        localStorage.setItem("aiterminalWorkspaces", JSON.stringify(saved));
        this.renderSaved();
      });
      row.append(button, remove);
      container.append(row);
    }
    if (!container.children.length) {
      const tip = document.createElement("p");
      tip.className = "sidebar-empty";
      tip.textContent = "保存常用布局，下次一键打开。";
      container.append(tip);
    }
  }
  async restore(raw) {
    if (this.busy) return;
    let saved;
    try {
      saved = this.layout.validate(raw);
    } catch (error) {
      this.message(error.message);
      return;
    }
    this.busy = true;
    this.restoring = true;
    const mapping = new Map(),
      created = [];
    try {
      for (const session of saved.sessions) {
        const id = await createNewTerminalTab({
          restoring: true,
          background: true,
          title: session.title,
          deferStart: !!session.connection,
          connection: session.connection,
        });
        if (!id) throw new Error("创建会话失败");
        mapping.set(session.id, id);
        created.push(id);
      }
      this.groups.push(
        ...saved.groups.map((tree) =>
          this.layout.map(tree, (id) => mapping.get(id)),
        ),
      );
      for (const pin of saved.pins)
        this.pin(mapping.get(pin.tabId), pin.pluginId, pin.panelId, pin.title);
      switchToTab(mapping.get(saved.active));
      this.render();
      this.message(
        `已打开「${saved.name}」；SSH 窗格保留连接信息，点击窗格中的连接按钮即可重连。`,
      );
    } catch (error) {
      for (const id of created) doCloseTab(id);
      this.message(error.message);
    } finally {
      this.restoring = false;
      this.busy = false;
    }
  }
  async importFile(input) {
    const file = input.files[0];
    input.value = "";
    if (!file) return;
    try {
      if (file.size > 1024 * 1024) throw new Error("工作区文件不能超过 1 MiB");
      await this.restore(JSON.parse(await file.text()));
    } catch (error) {
      this.message(error.message);
    }
  }
  export() {
    let snapshot;
    try {
      snapshot = this.snapshot("我的工作区");
    } catch (error) {
      this.message(error.message);
      return;
    }
    const blob = new Blob([JSON.stringify(snapshot, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob),
      link = document.createElement("a");
    link.href = url;
    link.download = "aiterminal-workspace.json";
    link.click();
    URL.revokeObjectURL(url);
  }
  renderAssets() {
    const list = document.getElementById("connectionProfiles");
    list.replaceChildren();
    for (const [name, config] of Object.entries(
      readStoredObject("configProfiles"),
    )) {
      if (!config?.host || !config.username) continue;
      const row = document.createElement("button");
      row.className = "asset-row";
      row.textContent = name;
      row.title = `${config.username}@${config.host}`;
      row.addEventListener("click", async () => {
        try {
          const id = await createNewTerminalTab({
            title: name,
            deferStart: true,
            connection: this.layout.connection(config),
          });
          if (!id) return;
          const info = terminalTabs.get(id);
          info.connectionConfig = sanitizeConfigForStorage(config);
          info.aiConfigSnapshot = sanitizeConfigForStorage(config);
          await window.electronAPI.aiConfigure(config, id);
          if (ownsTerminalTab(id, info))
            await autoConnectSSH({ ...config, autoCommand: "" }, id);
        } catch (error) {
          this.message(`打开连接失败：${error.message}`);
        }
      });
      list.append(row);
    }
    if (!list.children.length) {
      const tip = document.createElement("p");
      tip.className = "sidebar-empty";
      tip.textContent = "在连接设置中保存配置方案。";
      list.append(tip);
    }
  }
  pin(tabId, pluginId, panelId, title) {
    const owner = terminalTabs.get(tabId);
    if (!owner) return;
    this.pins.set(`${tabId}/${pluginId}/${panelId}`, {
      tabId,
      pluginId,
      panelId,
      title,
      owner,
    });
    void this.refreshPins();
  }
  async files(id, remotePath = ".") {
    const owner = terminalTabs.get(id);
    if (!owner?.isConnected) {
      this.message("远程文件浏览需要先连接 SSH。");
      return;
    }
    const request = Symbol("files");
    owner.filesRequest = request;
    try {
      const result = await window.electronAPI.sshExecuteSpecial(
        "rfe",
        [remotePath],
        id,
      );
      if (
        !ownsTerminalTab(id, owner) ||
        owner.filesRequest !== request ||
        !owner.isConnected
      )
        return;
      if (!result.success) throw new Error(result.error || "目录读取失败");
      this.fileResult(result.files, result.path, id);
    } catch (error) {
      if (ownsTerminalTab(id, owner)) this.message(error.message);
    }
  }
  fileResult(files, remotePath, id) {
    const owner = terminalTabs.get(id),
      content = getTabContent(id);
    if (!owner || !content) return;
    content.querySelector(".pane-files")?.remove();
    const panel = document.createElement("section");
    panel.className = "pane-files";
    const header = document.createElement("div");
    header.className = "files-header";
    const parent = document.createElement("button");
    parent.textContent = "↑";
    parent.title = "上级目录";
    parent.addEventListener("click", () =>
      this.files(id, remotePath.replace(/\/?[^/]+\/?$/, "") || "/"),
    );
    const title = document.createElement("span");
    title.textContent = remotePath;
    title.title = `直连 SSH：${owner.connectionConfig?.host || ""} · ${remotePath}（不跟随终端内的嵌套 SSH）`;
    const refresh = document.createElement("button");
    refresh.textContent = "↻";
    refresh.title = "刷新目录";
    refresh.addEventListener("click", () => this.files(id, remotePath));
    const close = document.createElement("button");
    close.textContent = "×";
    close.title = "关闭文件面板";
    close.addEventListener("click", () => {
      owner.filesRequest = null;
      panel.remove();
      this.fit();
    });
    header.append(parent, title, refresh, close);
    panel.append(header);
    const list = document.createElement("div");
    list.className = "files-list";
    for (const file of files) {
      const row = document.createElement("div");
      row.className = "file-row";
      const open = document.createElement("button");
      open.textContent = (file.isDirectory ? "▸ " : "· ") + file.name;
      open.title = file.isDirectory ? "打开目录" : "下载并用本机应用打开";
      const full = remotePath.replace(/\/$/, "") + "/" + file.name;
      open.addEventListener("click", async () => {
        if (!ownsTerminalTab(id, owner) || !owner.isConnected) return;
        if (file.isDirectory) return this.files(id, full);
        try {
          const result = await window.electronAPI.sshDownloadAndOpen(full, id);
          if (ownsTerminalTab(id, owner))
            this.message(
              result.success ? "已下载并打开文件" : result.error || "打开失败",
            );
        } catch (error) {
          if (ownsTerminalTab(id, owner)) this.message(error.message);
        }
      });
      row.append(open);
      if (!file.isDirectory) {
        const download = document.createElement("button");
        download.textContent = "↓";
        download.title = "下载文件";
        download.addEventListener("click", () => downloadFile(full, id));
        row.append(download);
      }
      list.append(row);
    }
    panel.append(list);
    content.append(panel);
    this.fit();
  }
  async refreshPins() {
    const generation = ++this.pinGeneration;
    for (const id of new Set([...this.pins.values()].map((pin) => pin.tabId))) {
      const owner = terminalTabs.get(id);
      if (!owner) continue;
      try {
        const result = await window.electronAPI.pluginsList(id);
        if (generation !== this.pinGeneration || !ownsTerminalTab(id, owner))
          return;
        for (const pin of this.pins.values())
          if (pin.tabId === id)
            pin.panel =
              result.plugins
                ?.find((p) => p.id === pin.pluginId)
                ?.runtimeState?.panels?.find((p) => p.id === pin.panelId) ||
              null;
      } catch {}
    }
    if (generation === this.pinGeneration) this.renderPins();
  }
  renderPins() {
    const dock = document.getElementById("pluginDock");
    dock.replaceChildren();
    dock.hidden = !this.pins.size;
    for (const [key, pin] of this.pins) {
      const section = document.createElement("section");
      section.className = "pinned-panel";
      const header = document.createElement("div");
      header.className = "pinned-header";
      const title = document.createElement("strong");
      title.textContent = `${pin.title} · ${pin.owner.title}`;
      const close = document.createElement("button");
      close.textContent = "×";
      close.title = "取消固定";
      close.addEventListener("click", () => {
        this.pins.delete(key);
        this.renderPins();
      });
      header.append(title, close);
      section.append(header);
      const panel = pin.panel;
      if (panel?.type === "table") {
        const table = document.createElement("table");
        for (const values of [panel.columns, ...(panel.rows || [])].slice(
          0,
          101,
        )) {
          const row = document.createElement("tr");
          for (const value of values.slice(0, 16)) {
            const cell = document.createElement("td");
            cell.textContent = String(value ?? "");
            row.append(cell);
          }
          table.append(row);
        }
        section.append(table);
      } else {
        const pre = document.createElement("pre");
        pre.textContent =
          panel?.text || "暂无输出；请在此会话的插件中心运行工具。";
        section.append(pre);
      }
      dock.append(section);
    }
    this.fit();
  }
  aiMounted(panel) {
    document.getElementById("aiDock").append(panel);
    document.getElementById("aiDock").hidden = false;
    const scope = document.createElement("span");
    scope.className = "ai-session-scope";
    scope.textContent = terminalTabs.get(panel.dataset.tabId)?.title || "";
    panel.querySelector(".ai-result-header")?.prepend(scope);
    const handle = document.getElementById("aiDivider");
    handle.hidden = false;
    if (!handle.dataset.ready) {
      handle.dataset.ready = "true";
      const set = (width) => {
        const max = Math.min(
          720,
          document.querySelector(".workbench").clientWidth * 0.65,
        );
        document
          .querySelector(".workbench")
          .style.setProperty(
            "--ai-width",
            Math.max(240, Math.min(max, width)) + "px",
          );
        this.fit();
      };
      handle.addEventListener("pointerdown", (event) => {
        event.preventDefault();
        handle.setPointerCapture(event.pointerId);
        const move = (e) =>
          set(
            document.querySelector(".workbench").getBoundingClientRect().right -
              e.clientX,
          );
        const stop = () => {
          handle.removeEventListener("pointermove", move);
          handle.removeEventListener("lostpointercapture", stop);
        };
        handle.addEventListener("pointermove", move);
        handle.addEventListener("lostpointercapture", stop);
      });
      handle.addEventListener("keydown", (event) => {
        if (["ArrowLeft", "ArrowRight"].includes(event.key)) {
          event.preventDefault();
          set(
            document.getElementById("aiDock").clientWidth +
              (event.key === "ArrowLeft" ? 20 : -20),
          );
        }
      });
    }
    this.fit();
  }
  syncAi() {
    const present = !!document.getElementById("aiResultContainer");
    document.getElementById("aiDock").hidden = !present;
    document.getElementById("aiDivider").hidden = !present;
    this.fit();
  }
  action(event) {
    const node = event.target.closest("[data-workspace-action]");
    if (!node) return;
    const action = node.dataset.workspaceAction,
      id = node.closest("[data-tab-id]")?.dataset.tabId || activeTabId;
    if (action === "split-horizontal" || action === "split-vertical")
      void this.split(action.slice(6), id);
    else if (action === "zoom") {
      const zoom = this.zoomed === id ? null : id;
      if (id !== activeTabId) switchToTab(id);
      this.zoomed = zoom;
      this.render();
    } else if (action === "detach") this.detach(id);
    else if (action === "files") void this.files(id);
    else if (action === "rename")
      showCustomPrompt(
        "重命名会话",
        "设置一个容易识别的名称",
        terminalTabs.get(id)?.title || "",
        (value) => {
          if (value?.trim() && terminalTabs.has(id)) {
            updateTabTitle(id, value.trim().slice(0, 120));
            this.renderSessions();
          }
        },
      );
    else if (action === "save") this.save();
    else if (action === "export") this.export();
    else if (action === "import")
      document.getElementById("workspaceFile").click();
    else if (action === "sidebar") {
      document.querySelector(".app-body").classList.toggle("sidebar-collapsed");
      this.fit();
    } else if (action === "settings") {
      createSSHModal();
      sshModal.style.display = "block";
    } else if (action === "theme") {
      const next = terminalConfig.theme === "light" ? "dark" : "light";
      terminalConfig.theme = next;
      localStorage.setItem("terminalConfig", JSON.stringify(terminalConfig));
      updateGlobalTheme(next);
      for (const info of terminalTabs.values())
        info.terminal.options.theme = terminalThemes[next];
      this.fit();
    } else if (action === "reconnect") {
      switchToTab(id);
      createSSHModal();
      sshModal.style.display = "block";
    }
  }
  key(event) {
    if (
      !(event.ctrlKey || event.metaKey) ||
      !event.shiftKey ||
      document.querySelector("dialog[open], .custom-dialog-overlay") ||
      sshModal.style.display === "block"
    )
      return;
    if (event.code === "KeyE") {
      event.preventDefault();
      event.stopImmediatePropagation();
      void this.split(event.altKey ? "vertical" : "horizontal");
    } else if (event.code === "KeyF") {
      event.preventDefault();
      event.stopImmediatePropagation();
      document.querySelector(".app-body").classList.remove("sidebar-collapsed");
      document.getElementById("sessionSearch").focus();
    } else if (event.code === "ArrowLeft" || event.code === "ArrowRight") {
      event.preventDefault();
      event.stopImmediatePropagation();
      const ids = this.layout.leaves(this.group(activeTabId));
      const index = ids.indexOf(activeTabId);
      switchToTab(
        ids[
          (index + (event.code === "ArrowLeft" ? -1 : 1) + ids.length) %
            ids.length
        ],
      );
    }
  }
};
