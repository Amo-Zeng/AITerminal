(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.AITerminalLayout = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  const leaf = (tabId) => ({ type: "terminal", tabId });
  function leaves(tree) {
    if (!tree) return [];
    return tree.type === "terminal"
      ? [tree.tabId]
      : tree.children.flatMap(leaves);
  }
  function split(tree, target, tabId, axis = "horizontal", before = false) {
    if (!tree || leaves(tree).includes(tabId) || !leaves(tree).includes(target))
      throw new Error("无效的分屏目标");
    if (!["horizontal", "vertical"].includes(axis))
      throw new Error("无效的分屏方向");
    if (tree.type === "terminal")
      return {
        type: "split",
        axis,
        ratio: 0.5,
        children: before ? [leaf(tabId), tree] : [tree, leaf(tabId)],
      };
    return {
      ...tree,
      children: tree.children.map((child) =>
        leaves(child).includes(target)
          ? split(child, target, tabId, axis, before)
          : child,
      ),
    };
  }
  function remove(tree, tabId) {
    if (!tree) return null;
    if (tree.type === "terminal") return tree.tabId === tabId ? null : tree;
    const children = tree.children
      .map((child) => remove(child, tabId))
      .filter(Boolean);
    return children.length === 2 ? { ...tree, children } : children[0] || null;
  }
  function map(tree, fn) {
    return tree.type === "terminal"
      ? leaf(fn(tree.tabId))
      : { ...tree, children: tree.children.map((child) => map(child, fn)) };
  }
  // Persist connection identity only. No password, API URL, key, webhook, or
  // startup command may enter a layout file, including unknown nested keys.
  function connection(input) {
    if (!input || typeof input !== "object") return null;
    const output = {};
    for (const key of ["host", "username", "privateKeyPath"]) {
      if (typeof input[key] === "string" && input[key].length <= 2048)
        output[key] = input[key];
    }
    output.port = Math.min(65535, Math.max(1, parseInt(input.port, 10) || 22));
    output.authMethod =
      input.authMethod === "privateKey" ? "privateKey" : "password";
    return output.host && output.username ? output : null;
  }
  function validate(input) {
    if (
      !input ||
      input.version !== 1 ||
      !Array.isArray(input.groups) ||
      !input.groups.length ||
      !Array.isArray(input.sessions)
    )
      throw new Error("工作区格式无效");
    if (input.sessions.length > 512 || input.groups.length > 512)
      throw new Error("工作区文件过大");
    const ids = new Set(),
      used = new Set();
    const sessions = input.sessions.map((session) => {
      if (
        !session ||
        typeof session.id !== "string" ||
        !/^[\w.:-]{1,80}$/.test(session.id) ||
        ids.has(session.id)
      )
        throw new Error("工作区会话重复或无效");
      ids.add(session.id);
      return {
        id: session.id,
        title: String(session.title || "终端").slice(0, 120),
        connection: connection(session.connection),
      };
    });
    function tree(node, depth = 0) {
      if (!node || depth > 32) throw new Error("工作区布局层级无效");
      if (node.type === "terminal") {
        if (!ids.has(node.tabId) || used.has(node.tabId))
          throw new Error("窗格必须对应唯一会话");
        used.add(node.tabId);
        return leaf(node.tabId);
      }
      if (
        node.type !== "split" ||
        !["horizontal", "vertical"].includes(node.axis) ||
        !Array.isArray(node.children) ||
        node.children.length !== 2
      )
        throw new Error("分屏布局无效");
      return {
        type: "split",
        axis: node.axis,
        ratio: Number.isFinite(node.ratio)
          ? Math.max(0.1, Math.min(0.9, node.ratio))
          : 0.5,
        children: node.children.map((child) => tree(child, depth + 1)),
      };
    }
    const groups = input.groups.map((item) => tree(item));
    if (used.size !== ids.size) throw new Error("工作区包含未分配的会话");
    const pins = Array.isArray(input.pins)
      ? input.pins.slice(0, 128).map((pin) => {
          if (
            !pin ||
            !ids.has(pin.tabId) ||
            !/^[a-z0-9][a-z0-9._-]{1,127}$/.test(pin.pluginId || "") ||
            !/^[\w.-]{1,100}$/.test(pin.panelId || "")
          )
            throw new Error("插件面板引用无效");
          return {
            tabId: pin.tabId,
            pluginId: pin.pluginId,
            panelId: pin.panelId,
            title: String(pin.title || pin.panelId).slice(0, 120),
          };
        })
      : [];
    return {
      version: 1,
      name: String(input.name || "我的工作区").slice(0, 80),
      sessions,
      groups,
      pins,
      active: ids.has(input.active) ? input.active : sessions[0].id,
    };
  }
  return { leaf, leaves, split, remove, map, connection, validate };
});
