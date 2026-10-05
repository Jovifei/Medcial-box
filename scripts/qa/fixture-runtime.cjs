'use strict';
// MEDICINE_QA_ONLY. No native storage/network/files/camera/account/share calls exist here.
const mockModule = require('./synthetic-mock');
let installed;
// Pure codec, no wx/Node/browser helper. This deliberately accepts canonical padded base64 only.
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function decodeBase64(text) {
  if (typeof text !== 'string' || text.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text)) throw new Error('QA invalid base64');
  const bytes = new Uint8Array(text.length / 4 * 3 - (text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0));
  let offset = 0;
  for (let i = 0; i < text.length; i += 4) {
    const a = alphabet.indexOf(text[i]); const b = alphabet.indexOf(text[i + 1]);
    const c = text[i + 2] === '=' ? 0 : alphabet.indexOf(text[i + 2]);
    const d = text[i + 3] === '=' ? 0 : alphabet.indexOf(text[i + 3]);
    if (offset < bytes.length) bytes[offset++] = (a << 2) | (b >> 4);
    if (offset < bytes.length) bytes[offset++] = ((b & 15) << 4) | (c >> 2);
    if (offset < bytes.length) bytes[offset++] = ((c & 3) << 6) | d;
  }
  if (encodeBase64(bytes) !== text) throw new Error('QA noncanonical base64');
  return bytes.buffer;
}
function encodeBase64(bytes) {
  let text = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]; const b = bytes[i + 1] ?? 0; const c = bytes[i + 2] ?? 0;
    text += alphabet[a >> 2] + alphabet[((a & 3) << 4) | (b >> 4)] +
      (i + 1 < bytes.length ? alphabet[((b & 15) << 2) | (c >> 6)] : '=') +
      (i + 2 < bytes.length ? alphabet[c & 63] : '=');
  }
  return text;
}
function install(native, config, nativeApp, nativePage) {
  if (installed) throw new Error('QA bootstrap already installed');
  if (config.buildMark !== 'MEDICINE_QA_ONLY' || config.appId !== 'touristappid' || !/^[a-z0-9-]{1,48}$/.test(config.runId)) throw new Error('QA build-mark gate failed');
  // These two read-only platform probes are the ONLY native calls before installation.
  // An unsupported tourist identity is a blocker, never a reason to substitute production AppID.
  if (native.getSystemInfoSync().platform !== 'devtools') throw new Error('QA requires official IDE simulator');
  const info = native.getAccountInfoSync().miniProgram;
  if (info.appId !== 'touristappid' || info.envVersion !== 'develop') throw new Error('QA requires touristappid develop build');
  const storage = new Map();
  const files = new Map();
  const descriptors = new Map();
  const held = new Map();
  const faults = new Map();
  const events = [];
  const mock = mockModule.createMock();
  let fatal = '';
  let nextFile = 1;
  let nextFd = 1;
  let nextWriteLimit = null;
  const root = '/__qa_memory__/' + config.runId;
  const clone = x => x === undefined ? undefined : JSON.parse(JSON.stringify(x));
  const alive = () => { if (fatal) throw new Error('QA STOPPED: ' + fatal); };
  const stop = reason => { fatal = reason; throw new Error('QA STOPPED: ' + reason); };
  const fault = name => {
    if (faults.has(name)) { const message = faults.get(name); faults.delete(name); throw new Error(message); }
  };
  const path = name => {
    if (typeof name !== 'string' || !name.startsWith(root + '/') || !/^[a-zA-Z0-9_./-]+$/.test(name) || name.includes('//') || name.split('/').some(s => s === '.' || s === '..')) stop('non-synthetic file path');
    return name;
  };
  const protect = (target, label) => new Proxy(Object.freeze(target), {
    get(object, key) { alive(); if (typeof key === 'symbol') return Reflect.get(object, key); if (!Object.prototype.hasOwnProperty.call(object, key)) return stop('unknown ' + label + '.' + key); return object[key]; },
    set() { return stop('QA hooks are immutable'); },
    defineProperty() { return stop('QA hooks are immutable'); },
    deleteProperty() { return stop('QA hooks are immutable'); },
  });
  function asyncCall(name, options = {}, operation) {
    alive();
    const run = () => Promise.resolve().then(() => {
      alive(); fault(name); events.push(name);
      return operation();
    }).then(result => { alive(); options.success?.(result); options.complete?.(result); return result; }, error => {
      const failure = { errMsg: name + ':fail ' + error.message };
      options.fail?.(failure); options.complete?.(failure);
      if (!options.fail && !options.success) throw failure;
      return undefined;
    });
    if (held.has(name)) return new Promise((resolve, reject) => held.get(name).push(() => run().then(resolve, reject)));
    return run();
  }
  const sync = (name, fn) => (...args) => { alive(); fault(name); events.push(name); return fn(...args); };
  const fs = {};
  fs.readFileSync = sync('fs.readFileSync', (file, encoding) => {
    const entry = files.get(path(file));
    if (!entry) throw new Error('no such file or directory');
    if (encoding !== entry.encoding) throw new Error('QA fake requires matching encoding; no native codec inference');
    return entry.data;
  });
  fs.writeFileSync = sync('fs.writeFileSync', (file, data, encoding) => {
    if (!['base64', 'utf8'].includes(encoding) || typeof data !== 'string') throw new Error('QA fake supports explicit base64/utf8 strings only');
    files.set(path(file), { data, encoding });
  });
  fs.unlinkSync = sync('fs.unlinkSync', file => { const target = path(file); if ([...descriptors.values()].includes(target)) throw new Error('QA open descriptor must be closed before unlink'); if (!files.delete(target)) throw new Error('no such file or directory'); });
  for (const name of ['readFile', 'writeFile', 'unlink']) fs[name] = (options = {}) => asyncCall('fs.' + name, options, () => {
    const result = fs[name + 'Sync'](options.filePath, ...(name === 'writeFile' ? [options.data, options.encoding] : name === 'readFile' ? [options.encoding] : []));
    return name === 'readFile' ? { data: result } : { errMsg: name + ':ok' };
  });
  // Explicit model for lifecycle/fault tests ONLY. This is not proof of WeChat flag/FD semantics.
  fs.open = options => asyncCall('fs.open', options, () => {
    const file = path(options.filePath);
    if (options.flag !== 'wx') throw new Error('QA fake supports only its synthetic exclusive-create contract');
    if (files.has(file)) throw new Error('file already exists');
    files.set(file, { data: '', encoding: 'base64' });
    const fd = 'qa-fd-' + nextFd++; descriptors.set(fd, file); return { fd };
  });
  fs.write = options => asyncCall('fs.write', options, () => {
    const file = descriptors.get(options.fd);
    if (!file || Object.prototype.toString.call(options.data) !== '[object ArrayBuffer]' || options.encoding !== undefined) throw new Error('QA write requires a synthetic descriptor and ArrayBuffer');
    const { offset, length, position } = options;
    if (![offset, length, position].every(Number.isSafeInteger) || offset < 0 || length < 0 || position < 0 || offset + length > options.data.byteLength) throw new Error('QA invalid byte range');
    const before = new Uint8Array(decodeBase64(files.get(file).data));
    if (position > before.length) throw new Error('QA fake does not model sparse writes');
    const bytesWritten = nextWriteLimit === null ? length : Math.min(length, nextWriteLimit);
    nextWriteLimit = null;
    const bytes = new Uint8Array(Math.max(before.length, position + bytesWritten));
    bytes.set(before); bytes.set(new Uint8Array(options.data, offset, bytesWritten), position);
    files.set(file, { data: encodeBase64(bytes), encoding: 'base64' }); return { bytesWritten };
  });
  fs.close = options => asyncCall('fs.close', options, () => {
    if (!descriptors.delete(options.fd)) throw new Error('invalid synthetic descriptor'); return { errMsg: 'close:ok' };
  });
  const fileApi = protect(fs, 'FileSystemManager');
  const api = {
    env: Object.freeze({ USER_DATA_PATH: root }),
    getFileSystemManager: () => { alive(); return fileApi; },
    getStorageSync: sync('getStorageSync', key => storage.has(String(key)) ? clone(storage.get(String(key))) : ''),
    setStorageSync: sync('setStorageSync', (key, data) => { storage.set(String(key), clone(data)); }),
    removeStorageSync: sync('removeStorageSync', key => { storage.delete(String(key)); }),
    clearStorageSync: sync('clearStorageSync', () => storage.clear()),
    getStorageInfoSync: sync('getStorageInfoSync', () => ({ keys: [...storage.keys()], currentSize: 0, limitSize: 10240 })),
    login: options => asyncCall('login', options, () => ({ code: 'qa-code-' + mock.actor(), errMsg: 'login:ok' })),
    checkSession: options => asyncCall('checkSession', options, () => ({ errMsg: 'checkSession:ok' })),
    base64ToArrayBuffer: sync('base64ToArrayBuffer', decodeBase64),
    getSystemInfoSync: () => ({ SDKVersion: '2.16.1', platform: 'devtools', statusBarHeight: 20, windowWidth: 390, windowHeight: 844 }),
    getMenuButtonBoundingClientRect: () => ({ left: 300, right: 380, top: 24, bottom: 56, width: 80, height: 32 }),
    getUpdateManager: () => protect({ onCheckForUpdate() {}, onUpdateReady() {}, onUpdateFailed() {}, applyUpdate: () => stop('native update/restart blocked') }, 'UpdateManager'),
    chooseMedia: options => asyncCall('chooseMedia', options, () => {
      const file = root + '/synthetic-photo-' + nextFile++ + '.png';
      files.set(file, { data: mockModule.PNG, encoding: 'base64' });
      return { tempFiles: [{ tempFilePath: file, size: 68, fileType: 'image' }], type: 'image' };
    }),
    scanCode: options => asyncCall('scanCode', options, () => ({ result: '0000000000000', scanType: 'EAN_13', errMsg: 'scanCode:ok' })),
    previewImage: options => asyncCall('previewImage', options, () => ({ errMsg: 'previewImage:ok synthetic no-op' })),
  };
  for (const name of ['getStorage', 'setStorage', 'removeStorage', 'clearStorage', 'getStorageInfo']) {
    api[name] = (options = {}) => asyncCall(name, options, () => {
      if (name === 'getStorage') {
        if (!storage.has(String(options.key))) throw new Error('data not found');
        return { data: api.getStorageSync(options.key), errMsg: name + ':ok' };
      }
      if (name === 'setStorage') api.setStorageSync(options.key, options.data);
      if (name === 'removeStorage') api.removeStorageSync(options.key);
      if (name === 'clearStorage') api.clearStorageSync();
      return name === 'getStorageInfo' ? api.getStorageInfoSync() : { errMsg: name + ':ok' };
    });
  }
  api.batchGetStorageSync = sync('batchGetStorageSync', keys => keys.map(key => ({ key, data: api.getStorageSync(key) })));
  api.batchSetStorageSync = sync('batchSetStorageSync', list => { for (const item of list) api.setStorageSync(item.key, item.data); });
  api.batchGetStorage = options => asyncCall('batchGetStorage', options, () => ({ dataList: api.batchGetStorageSync(options.keyList) }));
  api.batchSetStorage = options => asyncCall('batchSetStorage', options, () => { api.batchSetStorageSync(options.dataList); return {}; });
  const blocked = ['uploadFile', 'connectSocket', 'sendSocketMessage', 'closeSocket', 'onSocketOpen', 'onSocketMessage', 'onSocketError', 'onSocketClose', 'createTCPSocket', 'createUDPSocket', 'chooseImage', 'chooseMessageFile', 'shareFileMessage', 'setClipboardData', 'getClipboardData', 'requestSubscribeMessage', 'saveFile', 'getSavedFileList', 'removeSavedFile', 'openDocument', 'saveImageToPhotosAlbum', 'shareAppMessage', 'showShareMenu'];
  for (const name of blocked) api[name] = () => stop('blocked wx.' + name);
  api.cloud = protect({}, 'cloud');
  function request(options, download) {
    alive();
    const method = download ? 'GET' : options.method ?? 'GET';
    try {
      const route = mockModule.validateRequest(options.url, method);
      if (download && !/^\/api\/v1\/medicines\/qa-medicine-\d+\/leaflet-photos\/qa-photo-\d+$/.test(route)) throw new Error('QA download route denied');
    } catch (error) { return stop(error.message); }
    const name = (download ? 'download ' : 'request ') + method + ' ' + options.url.slice(mockModule.ORIGIN.length).split('?')[0];
    let aborted = false;
    void asyncCall(name, { ...options, success: result => { if (!aborted) options.success?.(result); } }, () => {
      if (aborted) throw new Error('abort');
      const response = mock.dispatch({ ...options, method });
      if (response.statusCode >= 300 && response.statusCode < 400 || response.header?.location || response.header?.Location) return stop('redirect rejected before any transport');
      if (download && response.statusCode === 200) {
        const file = root + '/download-' + nextFile++ + '.png';
        files.set(file, { data: response.data.syntheticBase64, encoding: 'base64' });
        return { statusCode: 200, tempFilePath: file, header: response.header };
      }
      return response;
    });
    return { abort() { aborted = true; } };
  }
  api.request = options => request(options, false);
  api.downloadFile = options => request(options, true);
  // The original transport is intentionally NEVER captured or called: wx.request
  // redirect control is unverified. In-memory dispatch is fail-closed and works offline.
  const uiNames = ['showToast', 'showModal', 'showActionSheet', 'navigateTo', 'redirectTo', 'navigateBack', 'reLaunch', 'switchTab', 'stopPullDownRefresh', 'enableAlertBeforeUnload', 'disableAlertBeforeUnload', 'hideShareMenu'];
  const nativeUi = {};
  for (const name of uiNames) {
    if (typeof native[name] !== 'function') throw new Error('QA unverifiable native UI hook: ' + name);
    nativeUi[name] = native[name].bind(native);
    api[name] = (options = {}) => {
      alive();
      if (['navigateTo', 'redirectTo', 'reLaunch', 'switchTab'].includes(name) &&
          (typeof options.url !== 'string' || !config.pages.some(page => options.url === '/' + page || options.url.startsWith('/' + page + '?')))) return stop('navigation outside generated pages');
      const guarded = { ...options };
      for (const key of ['success', 'fail', 'complete']) if (typeof options[key] === 'function') guarded[key] = (...args) => { alive(); return options[key](...args); };
      return nativeUi[name](guarded);
    };
  }
  const facade = protect(api, 'wx');
  for (const name of config.wxInventory) if (!Object.prototype.hasOwnProperty.call(api, name)) throw new Error('QA missing inventory hook: ' + name);
  if (config.fsInventory.some(name => !Object.prototype.hasOwnProperty.call(fs, name))) throw new Error('QA missing filesystem hook');
  const controls = Object.freeze({
    summary: () => ({ buildMark: config.buildMark, sourceSha: config.sourceSha, runId: config.runId, actor: mock.actor(), fatal, storageKeys: [...storage.keys()], syntheticFiles: [...files.keys()], openDescriptors: [...descriptors.keys()], held: [...held].map(([name, queue]) => ({ name, count: queue.length })), events: events.slice(-50), transport: 'in-process synthetic; native network disabled' }),
    hold(name) { alive(); if (held.has(name)) throw new Error('Already held'); held.set(name, []); },
    release(name) { alive(); const queue = held.get(name); if (!queue) throw new Error('Not held'); held.delete(name); queue.forEach(run => run()); },
    failNext(name, message = 'QA injected failure') { alive(); faults.set(name, message); },
    partialNextWrite(byteLimit) { alive(); if (!Number.isSafeInteger(byteLimit) || byteLimit < 0) throw new Error('QA invalid partial-write limit'); nextWriteLimit = byteLimit; },
    setActor: value => { alive(); mock.setActor(value); },
  });
  function wrapDefinition(definition) {
    const result = { ...definition };
    for (const [key, value] of Object.entries(result)) if (typeof value === 'function') result[key] = function (...args) { alive(); return value.apply(this, args); };
    return result;
  }
  const bindings = Object.freeze({ wx: facade,
    App(definition) { alive(); return nativeApp({ ...wrapDefinition(definition), qa: controls }); },
    Page(definition) {
      alive();
      const wrapped = wrapDefinition(definition);
      delete wrapped.onShareAppMessage;
      delete wrapped.onShareTimeline;
      const show = wrapped.onShow;
      wrapped.onShow = function (...args) { alive(); nativeUi.hideShareMenu({ menus: ['shareAppMessage', 'shareTimeline'] }); return show?.apply(this, args); };
      return nativePage(wrapped);
    },
    setTimeout(callback, delay) { alive(); return setTimeout(() => { alive(); callback(); }, delay); },
  });
  // Verify identities before allowing the first product require; no global mutation
  // or read-after-write assumption about WeChat's host wx object is needed.
  if (!Object.isFrozen(api) || !Object.isFrozen(bindings) || bindings.wx !== facade || facade.getFileSystemManager() !== fileApi) throw new Error('QA hook verification failed');
  installed = { bindings, controls, alive };
  return controls;
}
function bindings() { if (!installed) throw new Error('QA bootstrap must run before every product module'); installed.alive(); return installed.bindings; }
module.exports = Object.freeze({ install, bindings });
