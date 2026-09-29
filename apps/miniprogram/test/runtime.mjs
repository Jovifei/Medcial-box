import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

const root = path.resolve(import.meta.dirname, "..");

export function loadPage(relativePath, { modules = {}, wx = {}, setTimeoutFn = setTimeout } = {}) {
  const filename = path.join(root, relativePath);
  const source = fs.readFileSync(filename, "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: filename,
  }).outputText;
  let definition;
  const pageWx = {
    showToast() {},
    showModal(options) { options?.success?.({ confirm: true }); },
    navigateTo() {},
    redirectTo() {},
    navigateBack() {},
    reLaunch() {},
    scanCode() {},
    requestSubscribeMessage() {},
    getSystemInfoSync() { return { statusBarHeight: 20 }; },
    getStorageSync() { return undefined; },
    setStorageSync() {},
    removeStorageSync() {},
    enableAlertBeforeUnload() {},
    disableAlertBeforeUnload() {},
    ...wx,
  };
  const exports = {};
  const module = { exports };
  const requireMock = (id) => {
    if (Object.hasOwn(modules, id)) return modules[id];
    if (id === "../../services/ingredient-matches") return loadService("services/ingredient-matches.ts", { wx: pageWx });
    throw new Error(`Unexpected module import in test: ${id}`);
  };
  const sandbox = {
    exports,
    module,
    require: requireMock,
    Page(value) { definition = value; },
    wx: pageWx,
    setTimeout: setTimeoutFn,
    clearTimeout,
    console,
  };
  vm.runInNewContext(`(function(exports, require, module) { ${compiled}\n})`, sandbox)(exports, requireMock, module);
  return { definition, wx: pageWx, module: module.exports };
}

export function loadService(relativePath, { modules = {}, wx = {} } = {}) {
  const filename = path.join(root, relativePath);
  const source = fs.readFileSync(filename, "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: filename,
  }).outputText;
  const exports = {};
  const module = { exports };
  const requireMock = (id) => {
    if (Object.hasOwn(modules, id)) return modules[id];
    throw new Error(`Unexpected service import in test: ${id}`);
  };
  const serviceWx = { showModal(options) { options?.success?.({ confirm: true }); }, ...wx };
  const sandbox = { exports, module, require: requireMock, wx: serviceWx, console };
  vm.runInNewContext(`(function(exports, require, module) { ${compiled}\n})`, sandbox)(exports, requireMock, module);
  return module.exports;
}

export function makePageContext(definition, overrides = {}) {
  const context = {
    ...definition,
    data: structuredClone(definition.data),
    calls: [],
    setData(patch) {
      for (const [key, value] of Object.entries(patch)) {
        const parts = key.replaceAll("]", "").split(/[.[]/).filter(Boolean);
        let target = this.data;
        for (const part of parts.slice(0, -1)) target = target[part];
        target[parts.at(-1)] = value;
      }
      this.calls.push(patch);
    },
    ...overrides,
  };
  return context;
}

export function loadApi({ wx = {}, baseUrl = "https://medicine.test" } = {}) {
  const filename = path.join(root, "services/api.ts");
  const source = fs.readFileSync(filename, "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: filename,
  }).outputText;
  const requests = [];
  const apiWx = {
    getStorageSync() { return "test-token"; },
    setStorageSync() {},
    removeStorageSync() {},
    request(options) {
      requests.push(options);
      options.success({ statusCode: 200, data: { approved: true } });
    },
    ...wx,
  };
  const exports = {};
  const module = { exports };
  const requireMock = (id) => {
    if (id === "./config") return { API_BASE: baseUrl };
    throw new Error(`Unexpected API import in test: ${id}`);
  };
  const sandbox = { exports, module, require: requireMock, wx: apiWx, console };
  vm.runInNewContext(`(function(exports, require, module) { ${compiled}\n})`, sandbox)(exports, requireMock, module);
  return { ...module.exports, requests, wx: apiWx };
}
