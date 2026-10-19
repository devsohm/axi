export const MAX_STORE_VALUE_CHARS = 256 * 1024;
export const MAX_STORE_TOTAL_CHARS = 1024 * 1024;
export const MAX_OUTPUT_CHARS = 16 * 1024 * 1024;
export const MAX_OUTPUT_ITEMS = 100000;

export const PRELUDE_SOURCE = String.raw`(function (send, toolList, globalList, initialStore) {
  "use strict";
  (function freezeBuiltins() {
  const visited = new Set([globalThis]), objects = [];
  const overridable = new Set(["constructor", "name", "message", "toString", "toLocaleString", "valueOf", "toJSON"]);
  function visit(value) {
    if ((typeof value === "function" || (value !== null && typeof value === "object")) && !visited.has(value)) {
      visited.add(value); objects.push(value);
    }
  }
  for (const key of Reflect.ownKeys(globalThis)) {
    const d = Object.getOwnPropertyDescriptor(globalThis, key);
    visit(d.value); visit(d.get); visit(d.set);
    if ("value" in d && d.configurable) Object.defineProperty(globalThis, key, { writable: false, configurable: false });
  }
  for (const instance of [function* () {}, async function () {}, async function* () {}, Int8Array,
    [][Symbol.iterator](), new Map()[Symbol.iterator](), new Set()[Symbol.iterator](), ""[Symbol.iterator](), /x/[Symbol.matchAll]("")]) visit(Object.getPrototypeOf(instance));
  if (typeof Iterator === "function") {
    if (typeof Iterator.prototype.map === "function") visit(Object.getPrototypeOf([].values().map(x => x)));
    if (typeof Iterator.from === "function") visit(Object.getPrototypeOf(Iterator.from({ next() {} })));
  }
  while (objects.length) {
    const target = objects.pop();
    visit(Object.getPrototypeOf(target));
    for (const key of Reflect.ownKeys(target)) {
      const d = Object.getOwnPropertyDescriptor(target, key);
      if (!("value" in d)) { visit(d.get); visit(d.set); continue; }
      visit(d.value);
      if (!d.configurable || !d.writable || !(target === Object.prototype || overridable.has(key))) continue;
      const value = d.value;
      const access = Object.getOwnPropertyDescriptor({
        get accessor() { return value; },
        set accessor(next) {
          if (this === target) throw new TypeError("Cannot assign to read only property '" + String(key) + "' of a built-in");
          if (this !== null && (typeof this === "object" || typeof this === "function"))
            Object.defineProperty(this, key, { value: next, configurable: true, enumerable: true, writable: true });
        }
      }, "accessor");
      Object.defineProperty(target, key, { get: access.get, set: access.set, configurable: false, enumerable: d.enumerable });
      visit(access.get); visit(access.set);
    }
    Object.freeze(target);
  }
  })();
  const json = JSON.stringify, parse = JSON.parse, then = Promise.prototype.then;
  const waiting = new Map(), values = new Map(Object.entries(parse(initialStore))), changes = new Map();
  let next = 0, ended = false, chars = 0, items = 0, total = 0;
  for (const [key, value] of values) total += key.length + value.length;
  const EXIT = Object.freeze({});
  const encode = value => value === undefined ? undefined : json(value);
  function stack(error) {
    const headline = error.message ? error.name + ": " + error.message : String(error.name);
    const frames = typeof error.stack === "string" ? error.stack.split("\n").filter(line => line.trim() && !line.includes("codemode-prelude.js")) : [];
    return [headline, ...frames].join("\n");
  }
  function format(value) {
    if (typeof value === "string") return value;
    if (value instanceof Error) return stack(value);
    try { const text = json(value); return text === undefined ? String(value) : text; } catch { return String(value); }
  }
  function failure(error) {
    try { return error instanceof Error ? json({ name: String(error.name), message: String(error.message), stack: stack(error) }) : json({ message: String(format(error)) }); }
    catch { return json({ message: "The script threw a value that cannot be described" }); }
  }
  function finish(ok, payload, writes) {
    if (ended) return;
    ended = true; send("done", ok, payload, writes);
  }
  function writeChanges() { return json(Array.from(changes, ([key, value]) => value === undefined ? [key] : [key, value])); }
  function output(kind, value, mime) {
    if (ended) return;
    chars += value.length; items++;
    if (chars > ${MAX_OUTPUT_CHARS} || items > ${MAX_OUTPUT_ITEMS}) {
      const error = new RangeError("script output exceeded the limit of ${MAX_OUTPUT_CHARS} characters or ${MAX_OUTPUT_ITEMS} text(), image(), and console calls. Print a summary instead, or write large data to a file with a tool.");
      finish(false, failure(error)); throw error;
    }
    send("output", kind, value, mime);
  }
  function text(value) {
    let rendered;
    try { rendered = value === null || (typeof value !== "object" && typeof value !== "function") ? String(value) : json(value) ?? String(value); }
    catch (error) { throw new TypeError(error instanceof Error ? error.message : String(error)); }
    output("text", rendered);
  }
  const imageHint = 'image expects a non-empty image URL string, an object with image_url, or an image block { type: "image", data, mimeType }';
  const formats = [
    ["image/png", /^iVBORw0KGg/],
    ["image/jpeg", /^[/]9j[/](?!9)/],
    ["image/gif", /^R0lGOD[dl]h/],
    ["image/webp", /^UklG.{8}RUJQ/]
  ];
  function image(value) {
    let url;
    if (typeof value === "string") url = value;
    else {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(imageHint);
      if (value.image_url !== undefined) {
        if (typeof value.image_url !== "string") throw new TypeError(imageHint);
        url = value.image_url;
      } else {
        if (typeof value.type !== "string") throw new TypeError(imageHint);
        if (value.type !== "image") throw new TypeError('image only accepts image blocks, got "' + value.type + '"');
        if (typeof value.data !== "string" || !value.data) throw new TypeError("image expected image block data");
        url = value.data.toLowerCase().startsWith("data:") ? value.data : "data:;base64," + value.data;
      }
    }
    if (!url) throw new TypeError(imageHint);
    const colon = url.indexOf(":"), comma = url.indexOf(","), scheme = colon < 0 ? "" : url.slice(0, colon).toLowerCase();
    if (scheme === "http" || scheme === "https") throw new TypeError("remote image URLs are not supported in tool outputs. Pass a base64 data URI instead");
    if (scheme !== "data" || comma < 0 || !url.slice(colon + 1, comma).split(";").slice(1).some(part => part.toLowerCase() === "base64"))
      throw new TypeError("invalid image output. Pass a base64 data URI instead");
    const data = url.slice(comma + 1).replace(/\s+/g, "");
    if (data.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw new TypeError("invalid image output. The image data is not valid base64 (truncated or corrupted?)");
    const prefix = data.slice(0, 16);
    const format = formats.find(([, signature]) => signature.test(prefix));
    if (!format) throw new TypeError("invalid image output. The image data is not a PNG, JPEG, GIF, or WebP image");
    output("image", data, format[0]);
  }
  function checkKey(name, key) { if (typeof key !== "string") throw new TypeError(name + "() key must be a string"); }
  const storeHint = "store() is for small state such as IDs or summaries. Show images with image(), keep large data in variables, or write it to a file with a tool.";
  function store(key, value) {
    checkKey("store", key);
    const oldSize = values.has(key) ? key.length + values.get(key).length : 0;
    if (value === undefined) { values.delete(key); total -= oldSize; changes.set(key, undefined); return; }
    let encoded;
    try { encoded = json(value); }
    catch (error) { throw new TypeError("store(" + json(key) + ") value is not JSON-serializable: " + format(error)); }
    if (encoded === undefined) throw new TypeError("store(" + json(key) + ") value is not JSON-serializable");
    if (encoded.length > ${MAX_STORE_VALUE_CHARS}) throw new RangeError("store(" + json(key) + ") value has " + encoded.length + " characters of JSON, more than the limit of ${MAX_STORE_VALUE_CHARS}. " + storeHint);
    const size = total - oldSize + key.length + encoded.length;
    if (size > ${MAX_STORE_TOTAL_CHARS}) throw new RangeError("store is full: stored values would exceed ${MAX_STORE_TOTAL_CHARS} characters of JSON. Delete keys with store(key, undefined). " + storeHint);
    values.set(key, encoded); changes.set(key, encoded); total = size;
  }
  function load(key) { checkKey("load", key); return values.has(key) ? parse(values.get(key)) : undefined; }
  function exit() { try { finish(true, undefined, writeChanges()); } catch (error) { finish(false, failure(error)); } throw EXIT; }
  function callable(kind, name, spread) {
    return (...args) => new Promise((resolve, reject) => {
      let encoded;
      try { encoded = encode(spread ? args : args[0]); } catch (error) { reject(error); return; }
      const id = ++next;
      waiting.set(id, { resolve, reject }); send(kind, id, name, encoded);
    });
  }
  const comparable = name => name.toLowerCase().replace(/[^a-z0-9]/g, "");
  function guarded(target, label, names, hint) {
    return new Proxy(target, { get(object, key, receiver) {
      if (typeof key !== "string" || key in object || key in Object.prototype || key === "then" || key === "toJSON") return Reflect.get(object, key, receiver);
      const query = comparable(key), exact = names.filter(name => comparable(name) === query);
      const suggestions = exact.length ? exact : names.filter(name => query && (comparable(name).includes(query) || query.includes(comparable(name))));
      let message = label + "." + key + " does not exist.";
      if (suggestions.length) message += " Did you mean " + suggestions.slice(0, 5).map(name => label + "." + name).join(", ") + "?";
      else if (names.length <= 20) message += " Available: " + names.join(", ") + ".";
      if (hint) message += " " + hint;
      throw new TypeError(message + ' Check for a member with "' + key + '" in ' + label + ".");
    }});
  }
  const table = Object.create(null), listing = [], groups = new Map();
  for (const tool of parse(toolList)) {
    const fn = callable("call", tool.name, false);
    if (!(tool.jsName in table)) { table[tool.jsName] = fn; listing.push(Object.freeze({ name: tool.jsName, description: tool.description })); }
    if (!(tool.name in table)) table[tool.name] = fn;
  }
  Object.freeze(table); Object.freeze(listing);
  const tools = guarded(table, "tools", listing.map(tool => tool.name), "ALL_TOOLS lists every tool; searchTools(query) finds tools by topic.");
  function publish(name, value) { Object.defineProperty(globalThis, name, { value, enumerable: true }); }
  for (const global of parse(globalList)) {
    const fn = callable("global", global.name, global.spread), dot = global.name.indexOf(".");
    if (dot < 0) publish(global.name, fn);
    else {
      const group = global.name.slice(0, dot);
      if (!groups.has(group)) groups.set(group, Object.create(null));
      groups.get(group)[global.name.slice(dot + 1)] = fn;
    }
  }
  for (const [name, group] of groups) publish(name, guarded(Object.freeze(group), name, Object.keys(group)));
  publish("store", store); publish("load", load);
  const console = {};
  for (const level of ["log", "info", "warn", "error", "debug"]) console[level] = (...args) => output("console", args.map(format).join(" "));
  for (const [name, value] of Object.entries({ tools, ALL_TOOLS: listing, console: Object.freeze(console), text, image, exit })) publish(name, value);
  return {
    settle(id, ok, payload, properties) {
      const entry = waiting.get(id);
      if (!entry) return;
      waiting.delete(id);
      if (!ok) {
        const error = new Error(payload);
        if (properties !== undefined) for (const [key, value] of Object.entries(parse(properties))) {
          if (key !== "name" && key !== "message" && key !== "stack") Object.defineProperty(error, key, { value, enumerable: true, configurable: true, writable: true });
        }
        entry.reject(error); return;
      }
      try { entry.resolve(payload === undefined ? undefined : parse(payload)); } catch (error) { entry.reject(error); }
    },
    run(fn) {
      let promise;
      try { promise = fn(tools, console); } catch (error) { finish(false, failure(error)); return; }
      then.call(promise, value => {
        try { finish(true, encode(value), writeChanges()); } catch (error) { finish(false, failure(error)); }
      }, error => finish(false, failure(error)));
    },
    stalled() {
      if (ended || waiting.size) return false;
      finish(false, json({ name: "Error", message: "The script is waiting on a promise that can never settle: no tool call is pending, and timers do not exist here." }));
      return true;
    }
  };
})`;
